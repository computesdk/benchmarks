export type AIGatewayWireFormat = 'openai' | 'anthropic';

export interface AIGatewayProviderConfig {
  /** Provider name */
  name: string;
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
  /** Request fully sent -> first content token in the SSE stream. */
  ttftMs: number;
  /** dns + tcp + tls + ttft: what a short-lived process pays end to end. Cold only. */
  coldE2eMs?: number;
  outputTokens?: number;
  outputTokensPerSec?: number;
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
