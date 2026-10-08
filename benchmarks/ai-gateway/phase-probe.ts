import https from 'https';
import http2 from 'node:http2';
import tls from 'node:tls';
import type { TLSSocket } from 'tls';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { AIGatewayProviderConfig, AIGatewayWireFormat, PhaseProbeResult } from './types.js';

const RECEIPT_HEADERS = ['x-vercel-id', 'cf-ray', 'x-request-id', 'request-id', 'anthropic-request-id', 'x-github-request-id'];

/**
 * Returns the regex that detects the first *visible* content token for a
 * given wire format — deliberately per-format, not one shared pattern.
 *
 * A single shared `"(?:content|text|delta)"\s*:\s*"[^"]` regex was used
 * here previously, on the reasoning that each format's real content field
 * is never a bare string under any of the other names. That held for every
 * format this benchmark exercised until Kimi K3 via OpenRouter/Vercel,
 * confirmed live: both stream a `reasoning_details` array alongside the
 * real `content` field, and each entry looks like
 * `{"type":"reasoning.text","text":"…"}` — a genuine `"text":"…"` match,
 * just on invisible reasoning, not the answer. The shared regex fired on
 * that first reasoning token, so OpenRouter and Vercel's Kimi-family TTFT
 * numbers were measuring "time to first reasoning token" while every other
 * participant in that family measured "time to first visible token" — a
 * real correctness bug, not just an unlucky benchmark run (confirmed by the
 * reported numbers: 2s/8s vs. 24-38s for a model with reasoning locked
 * "always on").
 *
 * Fix: only match the field name that's genuinely the answer content for
 * *that* format, not every alternative used across all formats:
 * - `openai`: `delta.content` only. Chat Completions never uses a bare
 *   `"text"` or `"delta"` string for the real answer, so restricting to
 *   `content` removes the `reasoning_details[].text` collision entirely —
 *   not just for Kimi, for any `openai`-format participant that might
 *   stream a similarly-shaped reasoning trace.
 * - `anthropic`: `delta.text` (content_block_delta). Anthropic's extended
 *   thinking blocks use `"thinking":"…"`, not `"text"`, so no equivalent
 *   collision risk here.
 * - `responses`: the flat `"delta":"…"` string (`response.output_text.
 *   delta`). Note: if reasoning summaries were ever requested for a
 *   `responses`-format participant, `response.reasoning_summary_text.delta`
 *   events use this same field name and would reproduce the identical
 *   false-positive risk — not currently triggered, since no participant in
 *   this repo requests reasoning summaries, but worth knowing if that
 *   changes.
 * - `gemini`: `parts[].text` — Gemini's only real content field name, no
 *   collision risk since Gemini has no equivalent nested reasoning-trace
 *   shape in this benchmark's usage.
 *
 * `includeReasoning` deliberately widens the `openai` case back to also
 * match reasoning content — used only when
 * `AIGatewayProviderConfig.reasoningCountsAsFirstToken` is set (see that
 * flag's doc comment in `types.ts` for the full rationale). Confirmed live
 * across all six Kimi-family participants: exactly two reasoning-field
 * conventions exist — `reasoning_content` (Moonshot direct, Cloudflare) and
 * `reasoning` (OpenRouter, Vercel, LLM Gateway, Concentrate) — both handled
 * here rather than assumed to match from one gateway to the next, the same
 * live-verification discipline that caught the `reasoning_details[].text`
 * bug above in the first place.
 */
function contentRegexFor(wireFormat: AIGatewayWireFormat, includeReasoning: boolean): RegExp {
  if (wireFormat === 'openai') {
    return includeReasoning
      ? /"(?:content|reasoning|reasoning_content|reasoning_text)"\s*:\s*"[^"]/
      : /"content"\s*:\s*"[^"]/;
  }
  if (wireFormat === 'responses') return /"delta"\s*:\s*"[^"]/;
  // 'anthropic' and 'gemini' both use "text" as their real content field,
  // with no collision risk in either case (see rationale above).
  return /"text"\s*:\s*"[^"]/;
}

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
      ...config.extraBody,
    });
  }
  if (config.wireFormat === 'responses') {
    // OpenAI Responses API shape: flat `input` string instead of a `messages`
    // array, `max_output_tokens` instead of `max_tokens`. `store: false`
    // opts out of the Responses API's default 30-day server-side retention
    // (docs.openai.com — Responses defaults to `store: true`) — these are
    // one-shot benchmark probes with no need for persisted state, and
    // leaving the default on has a real failure mode: at least one gateway
    // (LLM Gateway, per its own Codex integration docs) surfaces a hard
    // error — "The Responses API requires data retention to be enabled" —
    // unless the backing OpenAI org has "Retain All Data" turned on, which
    // isn't something this benchmark controls. Setting `store: false`
    // sidesteps that requirement entirely rather than depending on an
    // account setting outside this repo.
    //
    // `temperature: 0` per the "identical request configuration" fairness
    // principle in AI_GATEWAYS.md — this branch is shared by the Anthropic
    // family's Concentrate entry (Claude Haiku) and every OpenAI-family
    // entry (`gpt-5.4-mini`, per `providers-openai.ts`), and neither has a
    // reason to deviate from it.
    return JSON.stringify({
      model: config.model,
      input: prompt,
      max_output_tokens: maxTokens,
      temperature: 0,
      stream: true,
      store: false,
      ...config.extraBody,
    });
  }
  if (config.wireFormat === 'gemini') {
    // Gemini's native generateContent shape: `contents[].parts[].text`
    // instead of `messages`, `generationConfig.maxOutputTokens` instead of
    // `max_tokens`. No `stream` body field — streaming is selected by the
    // `:streamGenerateContent` path segment instead.
    return JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
      ...config.extraBody,
    });
  }
  return JSON.stringify({
    model: config.model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    ...config.extraBody,
  });
}

/** Cheap regex extraction of the latest known output-token count from the raw SSE buffer so far. */
function extractOutputTokens(wireFormat: AIGatewayWireFormat, buf: string): number | undefined {
  if (wireFormat === 'openai') {
    // Take the last match per field: some gateways stream cumulative usage on
    // early chunks, not just the final one. Fields are matched independently
    // (not scoped inside `"usage":{}`) because LLM API emits
    // `prompt_tokens_details:{...}` before `completion_tokens`, which a
    // brace-scoped regex can't step past.
    //
    // Some Gemini-via-OpenAI-compat gateways (ngrok, BlazeRail, LLM API) report
    // `completion_tokens` as visible-answer-only and fold the thinking tokens
    // into `total_tokens` instead — so take max(completion, total - prompt).
    // No-op for non-thinking models where the two are already equal.
    const last = (re: RegExp): number | undefined => {
      const m = [...buf.matchAll(re)];
      return m.length > 0 ? Number(m[m.length - 1][1]) : undefined;
    };
    const completion = last(/"completion_tokens"\s*:\s*(\d+)/g);
    const prompt = last(/"prompt_tokens"\s*:\s*(\d+)/g);
    const total = last(/"total_tokens"\s*:\s*(\d+)/g);
    const derived = total !== undefined && prompt !== undefined ? total - prompt : undefined;
    const candidates = [completion, derived].filter((n): n is number => n !== undefined && n > 0);
    return candidates.length > 0 ? Math.max(...candidates) : undefined;
  }
  if (wireFormat === 'gemini') {
    // Gemini streams cumulative usage under `usageMetadata` on each chunk
    // (mirroring Anthropic's message_start/message_delta pattern) — take the
    // last match for each field, same rationale as the openai branch above.
    // Thinking models split output into `candidatesTokenCount` (visible answer
    // tokens) and `thoughtsTokenCount` (internal reasoning tokens); report the
    // total. Match the fields independently because `usageMetadata` can
    // contain nested arrays/objects like `promptTokensDetails`.
    const candMatches = [...buf.matchAll(/"candidatesTokenCount"\s*:\s*(\d+)/g)];
    const thoughtMatches = [...buf.matchAll(/"thoughtsTokenCount"\s*:\s*(\d+)/g)];
    const candidates = candMatches.length > 0 ? Number(candMatches[candMatches.length - 1][1]) : 0;
    const thoughts = thoughtMatches.length > 0 ? Number(thoughtMatches[thoughtMatches.length - 1][1]) : 0;
    const total = candidates + thoughts;
    return total > 0 ? total : undefined;
  }
  // Anthropic and the Responses API both stream cumulative usage under a
  // "usage" object keyed by "output_tokens" (Anthropic: message_start/
  // message_delta; Responses: response.completed's `response.usage`) — same
  // shared extraction path. The last "output_tokens" seen in the buffer is
  // the most up to date. Scoped to inside the "usage" object (allowing one
  // level of nested {} for fields like usage.server_tool_use) so a gateway
  // that echoes an unrelated "output_tokens" elsewhere — e.g. Concentrate's
  // sibling `cost.breakdown[…].output_tokens` dollar amount, present on both
  // its /messages and /responses endpoints — can't be mistaken for the real
  // count.
  const matches = [...buf.matchAll(/"usage"\s*:\s*\{(?:[^{}]|\{[^{}]*\})*?"output_tokens"\s*:\s*(\d+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : undefined;
}

/**
 * Cheap regex extraction of an API-reported error message from the raw SSE
 * buffer, for a more useful failure log than "no content token observed"
 * alone. A request can return HTTP 200 and a validly-terminated SSE stream
 * while still failing server-side, with the real reason inside an
 * `event: error` / `response.failed` payload rather than the HTTP status.
 * Matches the common `{"error":{...,"message":"..."}}` shape shared by
 * OpenAI (Chat Completions, Responses, and its own `event: error`/
 * `response.failed` payloads), Anthropic, and Gemini error responses alike —
 * not exhaustive, but strictly additive: if this finds nothing, the caller
 * falls back to the original generic message exactly as before.
 */
function extractStreamErrorMessage(buf: string): string | undefined {
  const matches = [...buf.matchAll(/"error"\s*:\s*\{(?:[^{}]|\{[^{}]*\})*?"message"\s*:\s*"([^"]*)"/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : undefined;
}

function extractReceipts(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const receipts: Record<string, string> = {};
  for (const h of RECEIPT_HEADERS) {
    const v = headers[h];
    if (typeof v === 'string') receipts[h] = v;
  }
  return receipts;
}

type ProbeProtocol = 'h2' | 'http/1.1';

/**
 * ALPN-negotiated protocol per host, learned on the first probe and reused
 * for the rest of the run. Cold probes get this for free — they already
 * open an explicit TLS connection for DNS/TCP/TLS timing, so `alpnProtocol`
 * is read off that socket. A warm-only run (cold phase dialed to 0) pays
 * one extra throwaway handshake the first time it calls `ensureProtocol`.
 */
const protocolByHost = new Map<string, ProbeProtocol>();

/**
 * Opens a TLS connection advertising both `h2` and `http/1.1` and resolves
 * once the handshake completes. The returned socket is whatever the server
 * negotiated — check `socket.alpnProtocol`.
 */
function connectTls(host: string, timeout: number, onSocket?: (socket: TLSSocket) => void): Promise<TLSSocket> {
  return withTimeout(new Promise<TLSSocket>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: 443,
      servername: host,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    // Synchronous: lets the caller attach 'lookup'/'connect'/'secureConnect'
    // timing listeners before the handshake completes.
    onSocket?.(socket);
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  }), timeout, `TLS handshake to ${host} timed out`);
}

function protocolOf(socket: TLSSocket): ProbeProtocol {
  // `alpnProtocol` is `false` (not undefined) when the server didn't select
  // a protocol — both cases mean plain HTTP/1.1.
  return socket.alpnProtocol === 'h2' ? 'h2' : 'http/1.1';
}

/**
 * Returns the host's negotiated protocol, cached per host. Used by the warm
 * probe so a warm-only run still picks up HTTP/2 where supported; the extra
 * detection handshake is skipped whenever the cold phase already populated
 * the cache.
 */
async function ensureProtocol(host: string, timeout: number): Promise<ProbeProtocol> {
  const cached = protocolByHost.get(host);
  if (cached) return cached;
  const socket = await connectTls(host, timeout);
  const protocol = protocolOf(socket);
  protocolByHost.set(host, protocol);
  socket.destroy();
  return protocol;
}

/**
 * Wraps a pre-connected `TLSSocket` that negotiated `h2` in a client HTTP/2
 * session. `http2.connect` normally opens its own connection; passing the
 * socket through `createConnection` keeps it on the connection we timed.
 */
function h2SessionOver(host: string, socket: TLSSocket): http2.ClientHttp2Session {
  return http2.connect(`https://${host}`, { createConnection: () => socket });
}

function h2Session(host: string): http2.ClientHttp2Session {
  return http2.connect(`https://${host}`);
}

/**
 * An `https.Agent` that dispatches its one request over an already-connected
 * `TLSSocket`. `https.request`'s own `createConnection` option is silently
 * ignored when `agent` is set — and when `agent: false` Node builds a fresh
 * agent that also ignores it — so the socket has to be injected by
 * overriding the agent's `createConnection` method instead. Verified live:
 * the override is called and the request runs on the same socket.
 */
function http1AgentOver(socket: TLSSocket): https.Agent {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (() => socket) as typeof agent.createConnection;
  return agent;
}

interface RawProbeOutcome {
  ttfbMs: number;
  ttftMs: number;
  totalMs: number;
  outputTokens?: number;
  resolvedProvider?: string;
  protocol: ProbeProtocol;
  receipts: Record<string, string>;
}

/** Sends one request over `agent` (HTTP/1.1) and resolves once the SSE stream ends. */
function sendAndMeasure(
  config: AIGatewayProviderConfig,
  body: string,
  agent: https.Agent,
  timeout: number,
  onSocket?: (socket: TLSSocket) => void,
): Promise<RawProbeOutcome> {
  return withTimeout(new Promise<RawProbeOutcome>((resolve, reject) => {
    const start = now();
    const contentRe = contentRegexFor(config.wireFormat, config.reasoningCountsAsFirstToken ?? false);

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
      let resolvedProvider: string | undefined;

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (ttftMs === 0 && contentRe.test(buf)) {
          ttftMs = now() - start;
        }
        outputTokens = extractOutputTokens(config.wireFormat, buf) ?? outputTokens;
        resolvedProvider = config.extractResolvedProvider?.(buf) ?? resolvedProvider;
      });
      res.on('end', () => {
        if (ttftMs === 0) {
          const streamError = extractStreamErrorMessage(buf);
          reject(new Error(
            streamError
              ? `Stream ended with no content token observed: ${streamError}`
              : 'Stream ended with no content token observed',
          ));
          return;
        }
        resolve({ ttfbMs, ttftMs, totalMs: now() - start, outputTokens, resolvedProvider, protocol: 'http/1.1', receipts });
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

/**
 * Sends one request as a stream on an HTTP/2 `session` and resolves once the
 * response stream ends. Mirrors `sendAndMeasure` — the 'response' event fires
 * when the HEADERS frame arrives (the same point the HTTP/1.1 path calls its
 * response callback), so `ttfbMs` is defined identically across protocols.
 */
function sendAndMeasureH2(
  config: AIGatewayProviderConfig,
  body: string,
  session: http2.ClientHttp2Session,
  timeout: number,
): Promise<RawProbeOutcome> {
  return withTimeout(new Promise<RawProbeOutcome>((resolve, reject) => {
    const start = now();
    const contentRe = contentRegexFor(config.wireFormat, config.reasoningCountsAsFirstToken ?? false);

    const req = session.request({
      ':method': 'POST',
      ':path': config.path,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'content-length': Buffer.byteLength(body),
      ...config.buildHeaders(),
    });

    let ttfbMs = 0;
    let status = 0;
    let receipts: Record<string, string> = {};
    let buf = '';
    let ttftMs = 0;
    let outputTokens: number | undefined;
    let resolvedProvider: string | undefined;

    req.on('response', (headers) => {
      ttfbMs = now() - start;
      status = Number(headers[':status'] ?? 0);
      receipts = extractReceipts(headers as Record<string, string | undefined>);
    });
    req.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (status >= 400) return;
      if (ttftMs === 0 && contentRe.test(buf)) {
        ttftMs = now() - start;
      }
      outputTokens = extractOutputTokens(config.wireFormat, buf) ?? outputTokens;
      resolvedProvider = config.extractResolvedProvider?.(buf) ?? resolvedProvider;
    });
    req.on('end', () => {
      if (status >= 400) {
        reject(new Error(`HTTP ${status}: ${buf.slice(0, 200)}`));
        return;
      }
      if (ttftMs === 0) {
        const streamError = extractStreamErrorMessage(buf);
        reject(new Error(
          streamError
            ? `Stream ended with no content token observed: ${streamError}`
            : 'Stream ended with no content token observed',
        ));
        return;
      }
      resolve({ ttfbMs, ttftMs, totalMs: now() - start, outputTokens, resolvedProvider, protocol: 'h2', receipts });
    });
    req.on('aborted', () => reject(new Error('HTTP/2 stream aborted by the server')));
    req.on('error', reject);
    req.write(body);
    req.end();
  }), timeout, 'AI gateway request timed out');
}

function tokensPerSecond(outcome: RawProbeOutcome): number | undefined {
  if (!outcome.outputTokens || outcome.outputTokens <= 0) return undefined;
  // Measure throughput over the full wall-clock time from request start to
  // stream end, including TTFT. Using only the window from the first token to
  // the last token would let a gateway buffer the whole response and emit it
  // in a single burst, inflating this number while the user still waits the
  // full generation time.
  const elapsedMs = Math.max(outcome.totalMs, 1);
  return outcome.outputTokens / (elapsedMs / 1000);
}

/**
 * One request on a fresh, non-pooled connection. Opens the TLS connection
 * directly (advertising both `h2` and `http/1.1` via ALPN) so DNS/TCP/TLS
 * are timed from the socket's 'lookup'/'connect'/'secureConnect' events and
 * the negotiated protocol is learned in the same handshake — then dispatches
 * the request as an HTTP/2 stream or a plain `https.request` over that same
 * socket, depending on what the server picked. The negotiated protocol is
 * cached per host so the warm probe (and any later iteration) doesn't pay a
 * second detection handshake.
 */
export async function runColdProbe(
  config: AIGatewayProviderConfig,
  prompt: string,
  maxTokens: number,
  timeout: number,
): Promise<PhaseProbeResult> {
  const body = buildRequestBody(config, prompt, maxTokens);

  let lookupAt: number | undefined;
  let connectAt: number | undefined;
  let secureConnectAt: number | undefined;
  const requestStart = now();
  let socket: TLSSocket | undefined;
  let session: http2.ClientHttp2Session | undefined;
  let agent: https.Agent | undefined;

  try {
    socket = await connectTls(config.host, timeout, (s) => {
      s.once('lookup', () => { lookupAt = now(); });
      s.once('connect', () => { connectAt = now(); });
      s.once('secureConnect', () => { secureConnectAt = now(); });
    });

    const protocol = protocolOf(socket);
    protocolByHost.set(config.host, protocol);

    const outcome = protocol === 'h2'
      ? await sendAndMeasureH2(config, body, (session = h2SessionOver(config.host, socket)), timeout)
      : await sendAndMeasure(config, body, (agent = http1AgentOver(socket)), timeout);

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
      resolvedProvider: outcome.resolvedProvider,
      protocol: outcome.protocol,
      receipts: outcome.receipts,
    };
  } catch (err) {
    return { mode: 'cold', ttfbMs: 0, ttftMs: 0, receipts: {}, error: formatError(err) };
  } finally {
    session?.close();
    agent?.destroy();
    socket?.destroy();
  }
}

/**
 * One throwaway request completes on a reused connection, then a second
 * request is measured on that same connection — a second stream on one
 * HTTP/2 session where negotiated, or a reused keep-alive socket otherwise.
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

  try {
    // HTTP/2 when the host negotiated it (cached from the cold probe, or one
    // detection handshake on a warm-only run): warmup and measured request
    // become two streams on the same session — the multiplexed counterpart
    // of a reused keep-alive socket. HTTP/1.1 hosts keep the original path.
    if ((await ensureProtocol(config.host, timeout)) === 'h2') {
      const session = h2Session(config.host);
      try {
        await sendAndMeasureH2(config, body, session, timeout); // warmup, discarded
        const outcome = await sendAndMeasureH2(config, body, session, timeout);
        return {
          mode: 'warm',
          ttfbMs: outcome.ttfbMs,
          ttftMs: outcome.ttftMs,
          outputTokens: outcome.outputTokens,
          outputTokensPerSec: tokensPerSecond(outcome),
          resolvedProvider: outcome.resolvedProvider,
          protocol: outcome.protocol,
          receipts: outcome.receipts,
        };
      } finally {
        session.close();
      }
    }

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
        resolvedProvider: outcome.resolvedProvider,
        protocol: outcome.protocol,
        receipts: outcome.receipts,
      };
    } finally {
      agent.destroy();
    }
  } catch (err) {
    return { mode: 'warm', ttfbMs: 0, ttftMs: 0, receipts: {}, error: formatError(err) };
  }
}
