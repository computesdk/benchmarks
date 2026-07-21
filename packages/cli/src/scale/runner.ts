import { log } from './logger.js';
import type {
  BurstProviderConfig,
  SandboxResult,
  FailureClass,
  ProgressStats,
} from './types.js';

export const FIRST_COMMAND_TIMEOUT_MS = 90_000;
export const LIVENESS_CHECK_TIMEOUT_MS = 90_000;

export interface RunnerCallbacks {
  onResult: (result: SandboxResult) => Promise<void> | void;
  onProgress: (stats: ProgressStats) => void;
}

type Pending = { sandbox: any; result: SandboxResult };

/**
 * Run the 100k burst in two coordinated phases so we can distinguish
 * "stayed alive until end-of-test" from "died mid-test":
 *
 *   Phase 1 (per-sandbox, fully parallel):
 *     - call `sandbox.create()`           → on failure: status='failed'
 *     - call `sandbox.runCommand('node -v')` (readiness)
 *                                         → on failure: status='readiness_failed',
 *                                            destroy and emit immediately
 *     - on readiness success: keep the sandbox handle alive; defer emit to phase 2
 *
 *   Phase 2 (kicks off after every phase-1 task has settled):
 *     - for each surviving sandbox: re-run `node -v` as a final liveness probe
 *           → pass: status='success'
 *           → fail: status='partial'  (created OK, died before we got here)
 *     - destroy the sandbox, emit the result
 *
 * `latency_ms` keeps its existing meaning (allocate-phase time, or
 * time-to-failure on create-fail). `completed_at` is set to the moment this
 * sandbox's lifecycle ended (final destroy or earlier failure), so the
 * downstream concurrency-over-time view reflects how long each sandbox was
 * actually held alive — not just how long create took.
 */
export class BurstLifecycle {
  private config: BurstProviderConfig;
  private compute: any;
  private callbacks: RunnerCallbacks;
  private done = 0;
  private in_flight = 0;
  private errors = 0;
  private startTime = Date.now();
  private progressStep: number;
  private nextProgressMilestone: number;
  private survivors: Map<number, Pending>;

  constructor(config: BurstProviderConfig, compute: any, callbacks: RunnerCallbacks) {
    this.config = config;
    this.compute = compute;
    this.callbacks = callbacks;
    this.progressStep = Math.max(1, Math.floor(config.concurrencyTarget / 10));
    this.nextProgressMilestone = this.progressStep;
    this.survivors = new Map();
  }

  async createOne(idx: number): Promise<void> {
    const { sandboxOptions, perRequestTimeoutMs = 120_000 } = this.config;
    this.in_flight++;
    this.callbacks.onProgress({ done: this.done, in_flight: this.in_flight, errors: this.errors });
    const started_at = new Date().toISOString();
    const t0 = performance.now();

    const result: SandboxResult = {
      sandbox_idx: idx,
      started_at,
      completed_at: '',
      latency_ms: 0,
      first_command_ms: null,
      status: 'success',
      failure_class: null,
      http_status: null,
      error_code: null,
      error_message: null,
      provider_metadata: null,
    };

    try {
      const sandbox = await withTimeout(this.compute.sandbox.create(sandboxOptions), perRequestTimeoutMs);
      result.latency_ms = Math.round(performance.now() - t0);
      result.provider_metadata = extractProviderMetadata(sandbox);
      this.survivors.set(idx, { sandbox, result });
    } catch (err: any) {
      this.errors++;
      result.status = 'failed';
      result.failure_class = classifyError(err);
      result.http_status = numericHttpStatus(err);
      result.error_code = err?.code ?? null;
      result.error_message = truncate(err?.message ?? String(err), 500);
      result.latency_ms = Math.round(performance.now() - t0);
      await this.emit(result);
    }
  }

  async execInitialOne(idx: number): Promise<void> {
    const pending = this.survivors.get(idx);
    if (!pending) return;
    const { sandbox, result } = pending;
    const afterCreate = performance.now();
    try {
      await withTimeout(sandbox.runCommand('node -v'), FIRST_COMMAND_TIMEOUT_MS);
      result.first_command_ms = Math.round(performance.now() - afterCreate);
    } catch (cmdErr: any) {
      this.errors++;
      result.status = 'readiness_failed';
      result.failure_class = classifyError(cmdErr);
      result.http_status = numericHttpStatus(cmdErr);
      result.error_code = cmdErr?.code ?? null;
      result.error_message = truncate(cmdErr?.message ?? String(cmdErr), 500);
      if (sandbox?.destroy) {
        Promise.resolve(sandbox.destroy()).catch(() => {});
      }
      this.survivors.delete(idx);
      await this.emit(result);
    }
  }

  async pause(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  async execAfterPauseOne(idx: number): Promise<void> {
    const pending = this.survivors.get(idx);
    if (!pending) return;
    const { sandbox, result } = pending;
    try {
      await withTimeout(sandbox.runCommand('node -v'), LIVENESS_CHECK_TIMEOUT_MS);
      result.status = 'success';
    } catch (livenessErr: any) {
      this.errors++;
      result.status = 'partial';
      result.failure_class = classifyError(livenessErr);
      result.http_status = numericHttpStatus(livenessErr);
      result.error_code = livenessErr?.code ?? null;
      result.error_message = truncate(livenessErr?.message ?? String(livenessErr), 500);
      result.completed_at = new Date().toISOString();
    }
  }

  async destroyOne(idx: number): Promise<void> {
    const pending = this.survivors.get(idx);
    if (!pending) return;
    this.survivors.delete(idx);
    const { sandbox, result } = pending;
    if (sandbox?.destroy) {
      await Promise.resolve(sandbox.destroy()).catch(() => {});
    }
    await this.emit(result);
  }

  countSurvivors(): number {
    return this.survivors.size;
  }

  countLiveSurvivors(): number {
    let live = 0;
    for (const pending of this.survivors.values()) {
      if (pending.result.status !== 'partial') live++;
    }
    return live;
  }

  private async emit(result: SandboxResult): Promise<void> {
    const { concurrencyTarget } = this.config;
    if (!result.completed_at) result.completed_at = new Date().toISOString();
    this.in_flight--;
    this.done++;
    try { await this.callbacks.onResult(result); } catch { /* swallow */ }
    this.callbacks.onProgress({ done: this.done, in_flight: this.in_flight, errors: this.errors });

    if (result.status === 'success') {
      const sb = result.provider_metadata?.sandboxId
        ? ` — sandboxId=${result.provider_metadata.sandboxId}`
        : '';
      log.ok(`sandbox ${result.sandbox_idx} success (allocate=${result.latency_ms}ms` +
        (result.first_command_ms != null ? ` ready=${result.first_command_ms}ms` : '') +
        `)${sb}`);
    } else {
      log.error(`sandbox ${result.sandbox_idx} ${result.status} ` +
        `(class=${result.failure_class ?? '-'} http=${result.http_status ?? '-'} ` +
        `code=${result.error_code ?? '-'}): ${result.error_message ?? '(no message)'}`);
    }
    log.data(result);

    if (this.done >= this.nextProgressMilestone && this.done < concurrencyTarget) {
      const elapsedMs = Date.now() - this.startTime;
      const rate = this.done / (elapsedMs / 1000);
      const etaSec = (concurrencyTarget - this.done) / Math.max(rate, 0.001);
      log.stat(
        `progress ${this.done}/${concurrencyTarget} ` +
        `(in_flight=${this.in_flight} errors=${this.errors}) ` +
        `rate=${rate.toFixed(1)}/s eta≈${etaSec.toFixed(0)}s`,
      );
      this.nextProgressMilestone += this.progressStep;
    }
  }
}

/**
 * Pull primitive props off the adapter's returned sandbox object so we can
 * cross-reference against the provider's own dashboards (sandbox id, region,
 * etc.). Skips anything that looks like a credential and any non-primitive
 * value to keep the JSON bounded.
 */
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|credential)/i;
export function extractProviderMetadata(sandbox: any): Record<string, unknown> | null {
  if (!sandbox || typeof sandbox !== 'object') return null;
  const meta: Record<string, unknown> = {};
  for (const key of Object.keys(sandbox)) {
    if (SECRET_KEY_RE.test(key)) continue;
    const val = (sandbox as any)[key];
    if (val == null) continue;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      meta[key] = val;
    }
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function classifyError(err: any): FailureClass {
  const msg = (err?.message ?? '').toString().toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (typeof (err?.status ?? err?.statusCode) === 'number') return 'http_error';
  return 'network_error';
}

function numericHttpStatus(err: any): number | null {
  const s = err?.status ?? err?.statusCode;
  return typeof s === 'number' ? s : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

// NOTE: Promise.race only ignores the late resolution; it does NOT cancel the
// underlying SDK request. If sandbox.create() resolves after the timeout,
// the sandbox is created and the handle is lost (leaked). True cancellation
// requires SDK-level support for AbortSignal or similar.
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
