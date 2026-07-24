import https from 'https';
import type { TLSSocket } from 'tls';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { AIGatewayProviderConfig, AIGatewayWireFormat, PhaseProbeResult } from './types.js';

const RECEIPT_HEADERS = ['x-vercel-id', 'cf-ray', 'x-request-id', 'request-id', 'anthropic-request-id'];

// Matches OpenAI's `delta.content` and Anthropic's `delta.text` fields alike,
// so we can timestamp the first content token without fully parsing every SSE
// event on the hot path.
const CONTENT_RE = /"(?:content|text)"\s*:\s*"[^"]/;

function now(): number {
  return performance.now();
}

function buildRequestBody(config: AIGatewayProviderConfig, prompt: string, maxTokens: number): string {
  if (config.wireFormat === 'openai') {
    return JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    });
  }
  return JSON.stringify({
    model: config.model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });
}

/** Cheap regex extraction of the latest known output-token count from the raw SSE buffer so far. */
function extractOutputTokens(wireFormat: AIGatewayWireFormat, buf: string): number | undefined {
  if (wireFormat === 'openai') {
    // Some OpenAI-compatible gateways stream cumulative usage on early events
    // (mirroring Anthropic's message_start) rather than only on the final
    // chunk, so take the last match — like the anthropic path below.
    const m = [...buf.matchAll(/"usage"\s*:\s*\{[^}]*"completion_tokens"\s*:\s*(\d+)/g)];
    return m.length > 0 ? Number(m[m.length - 1][1]) : undefined;
  }
  // Anthropic streams cumulative usage on message_start/message_delta events;
  // the last "output_tokens" seen in the buffer is the most up to date.
  const matches = [...buf.matchAll(/"output_tokens"\s*:\s*(\d+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : undefined;
}

function extractReceipts(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const receipts: Record<string, string> = {};
  for (const h of RECEIPT_HEADERS) {
    const v = headers[h];
    if (typeof v === 'string') receipts[h] = v;
  }
  return receipts;
}

interface RawProbeOutcome {
  ttfbMs: number;
  ttftMs: number;
  totalMs: number;
  outputTokens?: number;
  receipts: Record<string, string>;
}

/** Sends one request over `agent` and resolves once the SSE stream ends. */
function sendAndMeasure(
  config: AIGatewayProviderConfig,
  body: string,
  agent: https.Agent,
  timeout: number,
  onSocket?: (socket: TLSSocket) => void,
): Promise<RawProbeOutcome> {
  return withTimeout(new Promise<RawProbeOutcome>((resolve, reject) => {
    const start = now();

    const req = https.request({
      host: config.host,
      path: config.path,
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'content-length': Buffer.byteLength(body),
        ...config.buildHeaders(),
      },
    }, (res) => {
      const ttfbMs = now() - start;
      const receipts = extractReceipts(res.headers as Record<string, string | undefined>);

      if ((res.statusCode ?? 0) >= 400) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
        res.on('error', reject);
        return;
      }

      let buf = '';
      let ttftMs = 0;
      let outputTokens: number | undefined;

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (ttftMs === 0 && CONTENT_RE.test(buf)) {
          ttftMs = now() - start;
        }
        outputTokens = extractOutputTokens(config.wireFormat, buf) ?? outputTokens;
      });
      res.on('end', () => {
        if (ttftMs === 0) {
          reject(new Error('Stream ended with no content token observed'));
          return;
        }
        resolve({ ttfbMs, ttftMs, totalMs: now() - start, outputTokens, receipts });
      });
      res.on('error', reject);
    });

    if (onSocket) {
      req.on('socket', (socket) => onSocket(socket as TLSSocket));
    }
    req.on('error', reject);
    req.write(body);
    req.end();
  }), timeout, 'AI gateway request timed out');
}

function tokensPerSecond(outcome: RawProbeOutcome): number | undefined {
  if (!outcome.outputTokens || outcome.outputTokens <= 0) return undefined;
  const generationMs = Math.max(outcome.totalMs - outcome.ttftMs, 1);
  return outcome.outputTokens / (generationMs / 1000);
}

/**
 * One request on a fresh, non-pooled connection. Listens on the request's
 * socket for the underlying TLSSocket's 'lookup'/'connect'/'secureConnect'
 * events to time DNS/TCP/TLS directly — no raw-socket hand-rolling needed.
 */
export async function runColdProbe(
  config: AIGatewayProviderConfig,
  prompt: string,
  maxTokens: number,
  timeout: number,
): Promise<PhaseProbeResult> {
  const body = buildRequestBody(config, prompt, maxTokens);
  const agent = new https.Agent({ keepAlive: false });

  let lookupAt: number | undefined;
  let connectAt: number | undefined;
  let secureConnectAt: number | undefined;
  const requestStart = now();

  try {
    const outcome = await sendAndMeasure(config, body, agent, timeout, (socket) => {
      socket.once('lookup', () => { lookupAt = now(); });
      socket.once('connect', () => { connectAt = now(); });
      socket.once('secureConnect', () => { secureConnectAt = now(); });
    });

    const dnsMs = lookupAt !== undefined ? lookupAt - requestStart : undefined;
    const tcpMs = connectAt !== undefined && lookupAt !== undefined ? connectAt - lookupAt : undefined;
    const tlsMs = secureConnectAt !== undefined && connectAt !== undefined ? secureConnectAt - connectAt : undefined;
    const coldE2eMs = (dnsMs ?? 0) + (tcpMs ?? 0) + (tlsMs ?? 0) + outcome.ttftMs;

    return {
      mode: 'cold',
      dnsMs,
      tcpMs,
      tlsMs,
      ttfbMs: outcome.ttfbMs,
      ttftMs: outcome.ttftMs,
      coldE2eMs,
      outputTokens: outcome.outputTokens,
      outputTokensPerSec: tokensPerSecond(outcome),
      receipts: outcome.receipts,
    };
  } catch (err) {
    return { mode: 'cold', ttfbMs: 0, ttftMs: 0, receipts: {}, error: formatError(err) };
  } finally {
    agent.destroy();
  }
}

/**
 * One throwaway request completes on a keep-alive connection, then a second
 * request is measured on that same reused socket — the connection-pool case.
 * No explicit "drain" step is needed the way a raw-socket implementation
 * would require: Node's http client only fires `res.on('end')` once the full
 * response has been consumed, so the socket is already safe to reuse for the
 * next request by the time the warmup call resolves.
 */
export async function runWarmProbe(
  config: AIGatewayProviderConfig,
  prompt: string,
  maxTokens: number,
  timeout: number,
): Promise<PhaseProbeResult> {
  const body = buildRequestBody(config, prompt, maxTokens);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

  try {
    await sendAndMeasure(config, body, agent, timeout); // warmup, discarded
    const outcome = await sendAndMeasure(config, body, agent, timeout);

    return {
      mode: 'warm',
      ttfbMs: outcome.ttfbMs,
      ttftMs: outcome.ttftMs,
      outputTokens: outcome.outputTokens,
      outputTokensPerSec: tokensPerSecond(outcome),
      receipts: outcome.receipts,
    };
  } catch (err) {
    return { mode: 'warm', ttfbMs: 0, ttftMs: 0, receipts: {}, error: formatError(err) };
  } finally {
    agent.destroy();
  }
}
