import https from 'https';
import type { TLSSocket } from 'tls';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { AIGatewayProviderConfig, AIGatewayWireFormat, PhaseProbeResult } from './types.js';

const RECEIPT_HEADERS = ['x-vercel-id', 'cf-ray', 'x-request-id', 'request-id', 'anthropic-request-id'];

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
      ? /"(?:content|reasoning|reasoning_content)"\s*:\s*"[^"]/
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

export function buildRequestBody(config: AIGatewayProviderConfig, prompt: string, maxTokens: number): string {
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
export function extractOutputTokens(wireFormat: AIGatewayWireFormat, buf: string): number | undefined {
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
/** Cheap regex extraction of the latest known input-token count from the raw SSE buffer so far. */
export function extractInputTokens(wireFormat: AIGatewayWireFormat, buf: string): number | undefined {
  if (wireFormat === 'openai') {
    const m = [...buf.matchAll(/"usage"\s*:\s*\{[^}]*"prompt_tokens"\s*:\s*(\d+)/g)];
    return m.length > 0 ? Number(m[m.length - 1][1]) : undefined;
  }
  if (wireFormat === 'gemini') {
    const m = [...buf.matchAll(/"usageMetadata"\s*:\s*\{[^}]*"promptTokenCount"\s*:\s*(\d+)/g)];
    return m.length > 0 ? Number(m[m.length - 1][1]) : undefined;
  }
  // Anthropic and the Responses API both stream cumulative usage under a
  // "usage" object keyed by "input_tokens". Use the same usage-scoped regex
  // pattern as extractOutputTokens so an unrelated "input_tokens" field outside
  // the usage object is not mistaken for the real count.
  const matches = [...buf.matchAll(/"usage"\s*:\s*\{(?:[^{}]|\{[^{}]*\})*?"input_tokens"\s*:\s*(\d+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : undefined;
}

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

export interface RawProbeOutcome {
  ttfbMs: number;
  ttftMs: number;
  totalMs: number;
  outputTokens?: number;
  inputTokens?: number;
  resolvedProvider?: string;
  receipts: Record<string, string>;
}

/** Sends one request over `agent` and resolves once the SSE stream ends. */
export function sendAndMeasure(
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
      let inputTokens: number | undefined;
      let resolvedProvider: string | undefined;

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (ttftMs === 0 && contentRe.test(buf)) {
          ttftMs = now() - start;
        }
        outputTokens = extractOutputTokens(config.wireFormat, buf) ?? outputTokens;
        inputTokens = extractInputTokens(config.wireFormat, buf) ?? inputTokens;
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
        resolve({ ttfbMs, ttftMs, totalMs: now() - start, outputTokens, inputTokens, resolvedProvider, receipts });
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
  // Measure throughput over the full wall-clock time from request start to
  // stream end, including TTFT. Using only the window from the first token to
  // the last token would let a gateway buffer the whole response and emit it
  // in a single burst, inflating this number while the user still waits the
  // full generation time.
  const elapsedMs = Math.max(outcome.totalMs, 1);
  return outcome.outputTokens / (elapsedMs / 1000);
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
      resolvedProvider: outcome.resolvedProvider,
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
      resolvedProvider: outcome.resolvedProvider,
      receipts: outcome.receipts,
    };
  } catch (err) {
    return { mode: 'warm', ttfbMs: 0, ttftMs: 0, receipts: {}, error: formatError(err) };
  } finally {
    agent.destroy();
  }
}
