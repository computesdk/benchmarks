import type { ProviderConfig } from '../sandbox/types.js';

export interface BurstProviderConfig extends ProviderConfig {
  /** Peak target concurrency for this provider's burst (typically 100_000). */
  concurrencyTarget: number;
  /** Per-request timeout in ms. Defaults to 120_000. */
  perRequestTimeoutMs?: number;
}

/**
 * Final lifecycle status of a sandbox in the burst:
 *   success           — created, readiness `node -v` passed, end-of-test
 *                       liveness `node -v` also passed (alive when we
 *                       destroyed everything).
 *   partial           — created, readiness passed, but end-of-test liveness
 *                       failed (died between create and the coordinated
 *                       destroy).
 *   readiness_failed  — created, but the first `node -v` after create failed
 *                       so the sandbox never became usable. Destroyed early.
 *   failed            — `sandbox.create()` itself errored.
 *   worker_ready_failed — the pre-create worker readiness step failed before
 *                       `sandbox.create()` was attempted.
 */
export type SandboxResultStatus = 'success' | 'partial' | 'readiness_failed' | 'failed' | 'worker_ready_failed';

/**
 * Sub-classification of the underlying error for any non-success status.
 * For `failed`, describes how create errored. For `worker_ready_failed`,
 * describes how the readiness step errored. For `readiness_failed` and
 * `partial`, describes how the `node -v` probe errored.
 */
export type FailureClass = 'timeout' | 'http_error' | 'network_error';

export interface SandboxResult {
  sandbox_idx: number;
  started_at: string;        // ISO-8601 — when we called sandbox.create()
  completed_at: string;      // ISO-8601 — when this sandbox's lifecycle ended
                             //            (destroy or detected death)
  /**
   * "Allocate" phase: time for `sandbox.create()` to resolve.
   * Named `latency_ms` for backward-compat with older runs/queries.
   * On create-failure this is the time-to-failure.
   */
  latency_ms: number;
  /**
   * "First command" phase: time for `sandbox.runCommand('node -v')` to
   * return after `create()` resolved. Null when create failed (never
   * attempted) or when the command itself failed (measurement aborted).
   * Matches the daily benchmark's `node -v` readiness check.
   */
  first_command_ms: number | null;
  status: SandboxResultStatus;
  /** Set whenever status != 'success'. Null on success. */
  failure_class: FailureClass | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  /**
   * Whatever primitive props the adapter put on the returned sandbox object
   * (e.g. sandbox id, region). Null on failure or when nothing useful is
   * exposed. Stored as JSONB in Postgres and verbatim in Tigris raw.jsonl.
   */
  provider_metadata: Record<string, unknown> | null;
}

export interface ProgressStats {
  done: number;
  in_flight: number;
  errors: number;
}

export interface MetricsSample {
  ts: string;                          // ISO-8601
  uptime_ms: number;                   // since coordinator start
  cpu_user_us: number;                 // cumulative process CPU time (microseconds)
  cpu_system_us: number;
  mem_rss_mb: number;
  mem_heap_used_mb: number;
  mem_heap_total_mb: number;
  mem_external_mb: number;
  event_loop_p50_ms: number;           // lag percentiles since previous sample
  event_loop_p99_ms: number;
  event_loop_max_ms: number;
  loadavg_1m: number;
  loadavg_5m: number;
  loadavg_15m: number;
  open_fds: number | null;             // null on non-Linux
  sockstat: Record<string, number> | null;
}

/**
 * True fleet-wide peak concurrency, captured at the synchronized `ready.barrier`
 * hold. Because that barrier holds every shard's survivors alive at the same
 * instant, the platform's aggregated in-flight count at barrier release equals
 * the number of sandboxes simultaneously alive across ALL shards — the real
 * "N concurrent" number, as opposed to the per-shard interval-overlap estimate
 * in `concurrency_summary`.
 */
export interface GlobalConcurrency {
  /** Aggregate sandboxes simultaneously alive across all shards at the hold. */
  peak_concurrent: number;
  /** Global target == participant total tasks across all shards. */
  target: number;
  /** Provenance of the measurement. `platform` = read from the orchestrator's
   *  aggregated progress; `unavailable` = no claimed worker (bare local run). */
  source: 'platform' | 'unavailable';
  /** ISO-8601 — when the barrier released and the measurement was taken. */
  measured_at: string;
}

export interface FinalStats {
  sandboxes_attempted: number;
  /** count of status='success' */
  sandboxes_succeeded: number;
  /** count of status='partial' (created, died before end-of-test) */
  partials: number;
  /** count of status='readiness_failed' (created, first `node -v` failed) */
  readiness_failures: number;
  /** count of status='failed' (create itself errored) */
  failures: number;
  /** sub-classification of create-failures (sums to `failures`) */
  timeouts: number;
  http_errors: number;
  network_errors: number;
  /** allocate-phase latency percentiles, over status='success' only */
  p50_latency_ms: number;
  p99_latency_ms: number;
}
