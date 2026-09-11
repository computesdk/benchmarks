export type AIGatewayWireFormat = 'openai' | 'anthropic' | 'responses' | 'gemini';

export interface AIGatewayProviderConfig {
  /** Provider name (unique participant slug) */
  name: string;
  /** Optional display name for legacy result/SVG output (defaults to `name`) */
  displayName?: string;
  /** Environment variables that must all be set to run this benchmark */
  requiredEnvVars: string[];
  /** Request/response wire format this gateway speaks */
  wireFormat: AIGatewayWireFormat;
  /** Model id to request, in this gateway's own catalog naming convention */
  model: string;
  /** Hostname to connect to over TLS (port 443) */
  host: string;
  /** Request path for a chat/message completion */
  path: string;
  /** Auth (and any gateway-specific) headers. Evaluated per-request so env vars can be read lazily. */
  buildHeaders: () => Record<string, string>;
  /**
   * Extra top-level fields merged into the request body, for gateways whose
   * model id is a catalog alias that can resolve to more than one upstream
   * (e.g. OpenRouter's or Vercel AI Gateway's `anthropic/...` can also be
   * served via Bedrock/Vertex). Used to set Anthropic as the preferred
   * provider so the benchmark measures that provider's overhead by default,
   * while still allowing automatic fallback if Anthropic itself is down.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Cheap regex-style extraction of which upstream provider actually served
   * a request, from the raw SSE buffer accumulated so far — mirrors how
   * token counts are extracted (see `extractOutputTokens`), so a gateway
   * that's only pinned by preference (not restricted) can still report a
   * fallback instead of it blending silently into that gateway's numbers.
   */
  extractResolvedProvider?: (buf: string) => string | undefined;
  /**
   * When true, `ttftMs` is measured to the first *reasoning* token instead
   * of the first *visible* one — a deliberate redefinition, not the
   * default, and only meaningful for participants whose model does
   * genuine invisible reasoning before answering (currently: every
   * `providers-kimi.ts` entry, since `kimi-k3` runs with reasoning locked
   * "always on"). Rationale: for a model like that, "time to first visible
   * token" is dominated by however long the model chooses to deliberate,
   * which is a property of the model, not the gateway — "time to first
   * reasoning token" is a closer proxy for actual gateway/network
   * responsiveness, comparable in spirit to what TTFT already measures for
   * every non-reasoning participant in every other family (where reasoning
   * and visible content start at the same moment, since there's no
   * separate reasoning phase to speak of). Confirmed live across all six
   * Kimi-family participants: exactly two reasoning-field-name conventions
   * exist (`reasoning_content` — Moonshot direct, Cloudflare; `reasoning` —
   * OpenRouter, Vercel, LLM Gateway, Concentrate), both handled by
   * `contentRegexFor` in `phase-probe.ts` when this flag is set.
   */
  reasoningCountsAsFirstToken?: boolean;
}

export interface AIGatewayStats {
  dnsMs: { median: number; p95: number; p99: number };
  tcpMs: { median: number; p95: number; p99: number };
  tlsMs: { median: number; p95: number; p99: number };
  coldTtfbMs: { median: number; p95: number; p99: number };
  coldTtftMs: { median: number; p95: number; p99: number };
  coldE2eMs: { median: number; p95: number; p99: number };
  warmTtfbMs: { median: number; p95: number; p99: number };
  warmTtftMs: { median: number; p95: number; p99: number };
  outputTokensPerSec: { median: number; p95: number; p99: number };
}

/**
 * Result of one probe request. `dnsMs`/`tcpMs`/`tlsMs`/`coldE2eMs` are only
 * populated for `mode: 'cold'` — a warm request reuses an already-open
 * connection, so those phases don't apply.
 */
export interface PhaseProbeResult {
  mode: 'cold' | 'warm';
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  /** Request fully sent -> first response byte. */
  ttfbMs: number;
  /**
   * Request fully sent -> first content token in the SSE stream. Normally
   * the first *visible* token — except for participants with
   * `reasoningCountsAsFirstToken: true` (see `AIGatewayProviderConfig`),
   * where this is the first *reasoning* token instead. Check that flag
   * before comparing `ttftMs` across participants from different families.
   */
  ttftMs: number;
  /** dns + tcp + tls + ttft: what a short-lived process pays end to end. Cold only. */
  coldE2eMs?: number;
  outputTokens?: number;
  /** Output tokens per second over the full request wall-clock time (request start -> stream end). */
  outputTokensPerSec?: number;
  /**
   * Upstream provider that actually served this request, when the gateway's
   * response exposes it (see `extractResolvedProvider`). Only present for
   * gateways whose model id is a catalog alias that can fall back to a
   * different provider than the one requested.
   */
  resolvedProvider?: string;
  /** Request-identifying response headers (x-vercel-id, cf-ray, ...), for debugging. */
  receipts: Record<string, string>;
  error?: string;
}

export interface AIGatewayBenchmarkResult {
  provider: string;
  mode: 'ai-gateway';
  model: string;
  iterations: PhaseProbeResult[];
  summary: AIGatewayStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
