/**
 * Thin reporting layer over the platform-orchestrated `@computesdk/bench`
 * client (v0.1.7+).
 *
 * Why the low-level client and not `defineWorker`/`defineStep`: the scale burst
 * is a *two-phase, barriered* lifecycle (create + readiness for all N, then a
 * coordinated liveness probe + destroy for the survivors — see runner.ts). The
 * SDK's `defineStep` model runs an independent create→…→destroy chain per task
 * index with no cross-task barrier, and its `readiness: "poll"` gate would
 * deadlock here because failed sandboxes never reach the barrier step (active
 * concurrency can never equal the target). So the coordinator keeps owning the
 * burst (BurstLifecycle) and uses this reporter purely to:
 *   - claim one platform worker assignment per VM,
 *   - stream per-sandbox results as `task_results` batches,
 *   - heartbeat progress + in-flight concurrency, and
 *   - mark the worker complete/failed.
 *
 * Tigris remains the source of truth for the fine-grained analytics
 * (raw.jsonl / meta.json / metrics.jsonl); the platform is the orchestration +
 * live-progress + cross-worker rollup layer that watch.ts / aggregate.ts read.
 *
 * All platform calls are best-effort: a telemetry failure must never take down
 * the burst, so network errors are swallowed (mirroring the old bench SDK's
 * internal behaviour).
 */
import { createBenchmarkClient } from '@computesdk/bench';
import type {
  BenchmarkAssignment,
  BenchmarkClient,
  JsonObject,
  TaskResultRecord,
  TaskStepRecord,
  WorkerConcurrencySample,
} from '@computesdk/bench';
import type { ProgressStats, SandboxResult } from './types.js';
import { log } from './logger.js';

const DEFAULT_BATCH_SIZE = 500;

export interface BenchReporterConfig {
  apiKey?: string;
  baseUrl?: string;
  benchmarkSlug: string;
  runId: string;
  participantSlug: string;
  processKind?: string;
  processKey?: string;
  /** Records buffered before a `sendTaskResults` flush. Default 500. */
  batchSize?: number;
}

/** Snapshot taken at the moment a step barrier releases (`ready` flips true). */
export interface StepReadyResult {
  /** Platform-aggregated in-flight count across all shards at release — the
   *  true fleet-wide live concurrency. Null when the platform omitted it. */
  globalInFlight: number | null;
  /** Global target == participant total tasks across all shards. */
  globalTotal: number;
  /** ISO timestamp for the platform sample. */
  measuredAt: string;
}

/** Maps one finalized SandboxResult onto the platform's task-result shape. */
function toTaskRecord(
  r: SandboxResult,
  baseIdx: number,
  extraData?: JsonObject,
): TaskResultRecord {
  // Per-step records let `getRunResults().steps[]` report create / readiness
  // latency summaries even though we don't drive the SDK's step machinery.
  const steps: TaskStepRecord[] = [
    {
      name: 'create',
      status: r.status === 'failed' ? 'error' : 'success',
      latencyMs: r.latency_ms,
      ...(r.status === 'failed' && r.error_code ? { errorCode: r.error_code } : {}),
    },
  ];
  if (r.first_command_ms != null) {
    steps.push({ name: 'exec.initial', status: 'success', latencyMs: r.first_command_ms });
  } else if (r.status === 'readiness_failed') {
    steps.push({ name: 'exec.initial', status: 'error', ...(r.error_code ? { errorCode: r.error_code } : {}) });
  }
  const data: JsonObject = {
    failure_class: r.failure_class,
    http_status: r.http_status,
    error_message: r.error_message,
    ...(typeof r.provider_metadata?.sandboxId === 'string' ? { sandboxId: r.provider_metadata.sandboxId } : {}),
    ...extraData,
  };

  return {
    taskIndex: baseIdx + r.sandbox_idx,
    // Carries the full four-state taxonomy (success/partial/readiness_failed/
    // failed). The platform buckets these into success/error/other, so the fine
    // split is recoverable only from this raw status or from Tigris.
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    latencyMs: r.latency_ms,
    firstCommandMs: r.first_command_ms,
    errorCode: r.error_code,
    steps,
    data,
  };
}

export class BenchReporter {
  private readonly client: BenchmarkClient;
  private readonly cfg: Required<Pick<BenchReporterConfig, 'benchmarkSlug' | 'runId' | 'participantSlug' | 'batchSize'>>;
  private readonly assignment: BenchmarkAssignment;
  private readonly baseIdx: number;
  private readonly total: number;

  private pending: TaskResultRecord[] = [];
  private sequenceNumber = 0;
  private flushChain: Promise<void> = Promise.resolve();
  private lastStats: ProgressStats = { done: 0, in_flight: 0, errors: 0 };
  // While a step barrier is being awaited, every heartbeat (including the
  // periodic one) must keep re-reporting that step's concurrency sample.
  // Otherwise the periodic heartbeat overwrites the worker's snapshot with
  // `lifecycle`/`[]` and the platform stops seeing this worker at the barrier,
  // so the aggregate never reaches target and `ready` never latches.
  private barrier: { step: string; active: number; liveActive?: number } | null = null;

  private constructor(client: BenchmarkClient, cfg: BenchReporterConfig, assignment: BenchmarkAssignment) {
    this.client = client;
    this.assignment = assignment;
    this.baseIdx = assignment.taskRange.start;
    this.total = assignment.taskRange.count;
    this.cfg = {
      benchmarkSlug: cfg.benchmarkSlug,
      runId: cfg.runId,
      participantSlug: cfg.participantSlug,
      batchSize: cfg.batchSize ?? DEFAULT_BATCH_SIZE,
    };
  }

  /**
   * Claim one pending worker for this run/participant. Returns null when the
   * platform has no pending worker to assign (e.g. all already claimed) — the
   * caller should then run the burst without platform reporting.
   */
  static async claim(cfg: BenchReporterConfig): Promise<BenchReporter | null> {
    const client = createBenchmarkClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    try {
      const assignment = await client.claimWorker(cfg.benchmarkSlug, cfg.runId, cfg.participantSlug, {
        processKind: cfg.processKind,
        processKey: cfg.processKey,
      });
      if (!assignment) {
        log.warn('bench: no pending worker to claim — running without platform reporting');
        return null;
      }
      log.ok(
        `bench: claimed worker ${assignment.workerIndex + 1}/${assignment.workerCount} ` +
        `(tasks ${assignment.taskRange.start}..${assignment.taskRange.end - 1}, ` +
        `target=${assignment.targetConcurrency})`,
      );
      return new BenchReporter(client, cfg, assignment);
    } catch (err: any) {
      log.warn(`bench: claimWorker failed (${err?.message ?? err}) — running without platform reporting`);
      return null;
    }
  }

  /** Number of task indexes the platform assigned this worker. */
  get taskCount(): number {
    return this.total;
  }

  /** Global task index of this worker's first sandbox (for cross-worker uniqueness). */
  get taskIndexStart(): number {
    return this.baseIdx;
  }

  /** Buffer one finalized sandbox; flush when the batch fills. */
  recordResult(result: SandboxResult, extraData?: JsonObject): void {
    this.pending.push(toTaskRecord(result, this.baseIdx, extraData));
    if (this.pending.length >= this.cfg.batchSize) void this.flush(false);
  }

  /** Update the in-memory progress snapshot sent on the next heartbeat. */
  setStats(stats: ProgressStats): void {
    this.lastStats = stats;
  }

  /** Send a progress + concurrency heartbeat (best-effort). */
  async heartbeat(activeInFlight: number, liveActive?: number): Promise<void> {
    // A barrier wait takes precedence: keep this worker visible at the barrier
    // step so the periodic heartbeat reinforces (rather than overwrites) the
    // sample that `waitForStepReady` is polling on.
    const barrierConcurrency = this.barrier ? this.barrierConcurrency() : null;
    const concurrency = this.barrier
      ? { currentStep: this.barrier.step, concurrency: barrierConcurrency ?? [] }
      : activeInFlight > 0
        ? { currentStep: 'lifecycle', concurrency: this.lifecycleConcurrency(activeInFlight, liveActive) }
        : liveActive !== undefined
          ? { concurrency: this.liveConcurrency(liveActive) }
        : { concurrency: [] };
    try {
      await this.client.heartbeatWorker(this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId, {
        attemptId: this.assignment.attemptId,
        progressDone: this.lastStats.done,
        progressInFlight: this.lastStats.in_flight,
        progressErrors: this.lastStats.errors,
        progressTotal: this.total,
        ...concurrency,
      });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Report this worker as waiting at a platform-coordinated step barrier, then
   * poll until the participant reaches its aggregate target across all workers.
   */
  async waitForStepReady(
    step: string,
    timeoutMs: number,
    pollIntervalMs = 1_000,
    active = this.total,
    liveActive?: number,
  ): Promise<StepReadyResult> {
    // Mark the barrier active so the periodic heartbeat keeps re-reporting this
    // step (see `heartbeat`) and never clobbers our sample while we wait.
    this.barrier = { step, active, liveActive };
    const started = Date.now();
    try {
      while (true) {
        // Re-announce every tick: a single up-front heartbeat can age out of the
        // platform's freshness window before the whole fleet arrives, so the
        // worker would silently stop counting toward the aggregate.
        await this.client.heartbeatWorker(this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId, {
          attemptId: this.assignment.attemptId,
          progressDone: this.lastStats.done,
          progressInFlight: this.lastStats.in_flight,
          progressErrors: this.lastStats.errors,
          progressTotal: this.total,
          currentStep: step,
          concurrency: this.barrierConcurrency(),
        });

        const progress = await this.client.getRunProgress(this.cfg.benchmarkSlug, this.cfg.runId);
        const participant = progress.participants.find(item => item.slug === this.cfg.participantSlug);
        const concurrency = participant?.concurrency.find(item => item.step === step);
        if (concurrency?.ready) {
          // At release every shard is holding its survivors simultaneously, so
          // the aggregated in-flight count is the true fleet-wide live
          // concurrency. totalTasks is the global target across all shards.
          return {
            globalInFlight: typeof participant?.tasks?.inFlight === 'number' ? participant.tasks.inFlight : null,
            globalTotal: typeof participant?.totalTasks === 'number' ? participant.totalTasks : this.total,
            measuredAt: new Date().toISOString(),
          };
        }
        if (Date.now() - started >= timeoutMs) {
          throw new Error(`Timed out waiting for benchmark step "${step}" to become ready`);
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      this.barrier = null;
    }
  }

  private barrierConcurrency(): WorkerConcurrencySample[] {
    if (!this.barrier) return [];
    const samples: WorkerConcurrencySample[] = [
      { step: this.barrier.step, active: this.barrier.active, target: this.total },
    ];
    if (this.barrier.liveActive !== undefined) {
      samples.push(...this.liveConcurrency(this.barrier.liveActive));
    }
    return samples;
  }

  private lifecycleConcurrency(activeInFlight: number, liveActive?: number): WorkerConcurrencySample[] {
    return [
      { step: 'lifecycle', active: activeInFlight, target: this.total },
      ...this.liveConcurrency(liveActive),
    ];
  }

  private liveConcurrency(liveActive?: number): WorkerConcurrencySample[] {
    return liveActive === undefined
      ? []
      : [{ step: 'live.sandboxes', active: liveActive, target: this.total }];
  }

  /** Serialize `sendTaskResults` so sequenceNumbers stay ordered. */
  private flush(isFinal: boolean): Promise<void> {
    this.flushChain = this.flushChain.then(async () => {
      const batchSize = this.cfg.batchSize;
      while (this.pending.length >= batchSize || (isFinal && this.pending.length > 0)) {
        const batch = this.pending.splice(0, batchSize);
        try {
          await this.client.sendTaskResults({
            benchmarkSlug: this.cfg.benchmarkSlug,
            runId: this.cfg.runId,
            workerId: this.assignment.workerId,
            attemptId: this.assignment.attemptId,
            sequenceNumber: this.sequenceNumber,
            isFinal: isFinal && this.pending.length === 0,
            records: batch,
          });
        } catch (err: any) {
          log.warn(`bench: sendTaskResults batch ${this.sequenceNumber} failed: ${err?.message ?? err}`);
        }
        this.sequenceNumber += 1;
      }
    });
    return this.flushChain;
  }

  /** True once a worker is claimed and artifacts/results can be reported. */
  get active(): boolean {
    return true;
  }

  /**
   * Upload a blob as a worker artifact: create the artifact record (which
   * returns a presigned PUT url), then PUT the bytes. Must run while the worker
   * attempt is still open (i.e. before finish()). Best-effort — returns false on
   * any failure rather than throwing, so a telemetry hiccup never aborts the run.
   */
  async uploadArtifact(kind: string, name: string, contentType: string, body: string): Promise<boolean> {
    const sizeBytes = Buffer.byteLength(body);
    try {
      const res = await this.client.createWorkerArtifact(
        this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId,
        { attemptId: this.assignment.attemptId, kind, name, contentType, metadata: { sizeBytes } },
      );
      const uploadUrl = res.uploadUrl ?? res.artifact?.uploadUrl;
      if (!uploadUrl) {
        log.warn(`bench: artifact ${name} created but no uploadUrl returned`);
        return false;
      }
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body });
      if (!put.ok) {
        log.warn(`bench: artifact ${name} PUT failed: ${put.status} ${put.statusText}`);
        return false;
      }
      log.ok(`bench: uploaded artifact ${name} (${kind}, ${sizeBytes}b)`);
      return true;
    } catch (err: any) {
      log.warn(`bench: artifact ${name} upload failed: ${err?.message ?? err}`);
      return false;
    }
  }

  /** Final flush + mark the worker completed (or failed). Best-effort. */
  async finish(failed: boolean): Promise<void> {
    await this.flush(true).catch(() => {});
    try {
      if (failed) {
        await this.client.failWorker(
          this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId, this.assignment.attemptId,
          new Error('burst reported one or more failures'),
        );
      } else {
        await this.client.completeWorker(
          this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId, this.assignment.attemptId,
        );
      }
    } catch (err: any) {
      log.warn(`bench: ${failed ? 'failWorker' : 'completeWorker'} failed: ${err?.message ?? err}`);
    }
  }
}
