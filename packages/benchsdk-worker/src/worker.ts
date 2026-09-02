import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(gzipCallback);
import { createSystemMetricsCollector } from './metrics.js';
import type { BenchmarkSystemMetricsSample } from './metrics.js';
import type {
  BenchmarkClient,
  BenchmarkAssignment,
  BenchmarkLogLevel,
  BenchmarkLogOptions,
  BenchmarkStepOutcome,
  DefineStepOptions,
  JsonObject,
  RunWorkerContext,
  RunWorkerOptions,
  RunWorkerResult,
  TaskFunction,
  TaskResultRecord,
  TaskStepRecord,
  WorkerConcurrencySample,
} from '@benchsdk/api';

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 1000;
const DEFAULT_LOG_LEVEL: BenchmarkLogLevel = 'info';
const DEFAULT_LOG_FLUSH_INTERVAL_MS = 0;
const DEFAULT_MAX_LOG_LINES = 100_000;
// On by default (unlike log flushing): this is the worker's only source of
// system metrics, so leaving it opt-in would silently reproduce the gap
// where no benchmark on this path collected any resource data at all.
const DEFAULT_METRICS_INTERVAL_MS = 30_000;
const MAX_TASK_RESULT_RECORDS = 5000;
const MAX_TASK_RECORD_STEPS = 100;
const MAX_HEARTBEAT_CONCURRENCY_SAMPLES = 20;

const LOG_LEVEL_ORDER: BenchmarkLogLevel[] = ['debug', 'info', 'warn', 'error'];

function logLevelIndex(level: BenchmarkLogLevel): number {
  return LOG_LEVEL_ORDER.indexOf(level);
}

function shouldLog(level: BenchmarkLogLevel, threshold: BenchmarkLogLevel): boolean {
  return logLevelIndex(level) >= logLevelIndex(threshold);
}

function parseLogLevel(value: string | undefined, fallback: BenchmarkLogLevel): BenchmarkLogLevel {
  if (!value) return fallback;
  const trimmed = value.trim().toLowerCase() as BenchmarkLogLevel;
  if (LOG_LEVEL_ORDER.includes(trimmed)) return trimmed;
  return fallback;
}

function parseEnvInt(name: string, fallback: number): number {
  if (typeof process === 'undefined') return fallback;
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

function isLogOptions(value: unknown): value is BenchmarkLogOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return false;
  if (!keys.every((k) => k === 'level' || k === 'meta')) return false;
  if (o.level !== undefined && (typeof o.level !== 'string' || !LOG_LEVEL_ORDER.includes(o.level as BenchmarkLogLevel))) {
    return false;
  }
  return true;
}

const STEP_OUTCOME_KEYS = new Set(['stdout', 'stderr', 'error', 'exitCode', 'code', 'signal', 'pid']);

function isStepOutcome(value: unknown): value is BenchmarkStepOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return false;
  if (!keys.every((k) => STEP_OUTCOME_KEYS.has(k))) return false;
  return typeof o.stdout === 'string' || typeof o.stderr === 'string' || typeof o.error === 'string';
}

function getErrorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string' && (error as { code: string }).code) {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && error.name) return error.name;
  return 'ERROR';
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function mergeMeasures(measures: JsonObject, returned: JsonObject | undefined): JsonObject | undefined {
  const merged = { ...measures, ...(returned ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function implicitTaskStep(record: TaskResultRecord, measures: JsonObject): TaskStepRecord {
  return {
    name: 'task',
    status: record.status === 'success' ? 'success' : 'error',
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    latencyMs: record.latencyMs,
    errorCode: record.errorCode ?? null,
    data: Object.keys(measures).length > 0 ? { ...measures } : undefined,
  };
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Benchmark ${name} must be a positive integer.`);
  }
}

function validateBatchSize(value: number): void {
  validatePositiveInteger('batchSize', value);
  if (value > MAX_TASK_RESULT_RECORDS) {
    throw new Error(`Benchmark batchSize must be at most ${MAX_TASK_RESULT_RECORDS}.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runWorker(client: BenchmarkClient, options: RunWorkerOptions): Promise<RunWorkerResult> {
  if (options.concurrency !== undefined) validatePositiveInteger('concurrency', options.concurrency);
  if (options.batchSize !== undefined) validateBatchSize(options.batchSize);
  if (options.flushIntervalMs !== undefined) validatePositiveInteger('flushIntervalMs', options.flushIntervalMs);
  if (options.logFlushIntervalMs !== undefined && options.logFlushIntervalMs < 0) {
    throw new Error('Benchmark logFlushIntervalMs must be a non-negative integer.');
  }
  if (options.metricsIntervalMs !== undefined && (!Number.isInteger(options.metricsIntervalMs) || options.metricsIntervalMs < 0)) {
    throw new Error('Benchmark metricsIntervalMs must be a non-negative integer.');
  }

  const logLevel: BenchmarkLogLevel = options.logLevel ?? parseLogLevel(
    typeof process !== 'undefined' ? process.env.BENCHMARK_LOG_LEVEL : undefined,
    DEFAULT_LOG_LEVEL,
  );
  const maxLogLines = options.maxLogLines ?? parseEnvInt('BENCHMARK_LOG_MAX_LINES', DEFAULT_MAX_LOG_LINES);
  const logFlushIntervalMs = options.logFlushIntervalMs ?? parseEnvInt('BENCHMARK_LOG_FLUSH_INTERVAL_MS', DEFAULT_LOG_FLUSH_INTERVAL_MS);
  const logCompression: 'gzip' | false =
    options.logCompression ??
    (typeof process !== 'undefined' && process.env.BENCHMARK_LOG_COMPRESSION === 'gzip' ? 'gzip' : false);
  // 0 disables, same as logFlushIntervalMs, but the default is on: unlike log
  // flushing (a mid-run nicety for a stream that uploads in full at the end
  // regardless), this is the only place samples are ever taken — skipping a
  // sample at this interval loses it for good.
  const metricsIntervalMs = options.metricsIntervalMs ?? parseEnvInt('BENCHMARK_METRICS_INTERVAL_MS', DEFAULT_METRICS_INTERVAL_MS);

  const assignment = await client.claimWorker(options.benchmarkSlug, options.runId, options.participantSlug, {
    processKind: options.processKind,
    processKey: options.processKey,
  });
  if (!assignment) return { assignment: null, records: [] };
  const claimed = assignment;

  let sequenceNumber = 0;
  const records: TaskResultRecord[] = [];
  const pending: TaskResultRecord[] = [];
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const workerConcurrency = options.concurrency ?? claimed.targetConcurrency;
  validatePositiveInteger('concurrency', workerConcurrency);
  const taskIndices = Array.from({ length: claimed.taskRange.count }, (_, index) => claimed.taskRange.start + index);
  const activeByStep = new Map<string, number>();
  const targetByStep = new Map<string, number>();
  const readyWaitByStep = new Map<string, Promise<void>>();
  let doneCount = 0;
  let errorCount = 0;
  let inFlightCount = 0;
  let flushChain = Promise.resolve();

  function concurrencySamples(): WorkerConcurrencySample[] {
    return Array.from(activeByStep.entries())
      .filter(([, active]) => active > 0)
      .map(([step, active]) => ({
        step,
        active,
        target: targetByStep.get(step) ?? workerConcurrency,
      }))
      .sort((a, b) => b.active - a.active)
      .slice(0, MAX_HEARTBEAT_CONCURRENCY_SAMPLES);
  }

  async function sendHeartbeat(): Promise<void> {
    const concurrency = concurrencySamples();
    const step = concurrency[0]?.step ?? null;
    await client.heartbeatWorker(options.benchmarkSlug, options.runId, claimed.workerId, {
      attemptId: claimed.attemptId,
      progressDone: doneCount,
      progressInFlight: inFlightCount,
      progressErrors: errorCount,
      progressTotal: taskIndices.length,
      ...(step ? { currentStep: step } : {}),
      concurrency,
    });
  }

  let heartbeatInFlight: Promise<void> | null = null;
  let heartbeatRequested = false;

  function requestHeartbeat(): void {
    heartbeatRequested = true;
    if (heartbeatInFlight) return;

    heartbeatInFlight = (async () => {
      while (heartbeatRequested) {
        heartbeatRequested = false;
        await sendHeartbeat().catch(() => {});
      }
    })().finally(() => {
      heartbeatInFlight = null;
      if (heartbeatRequested) requestHeartbeat();
    });
  }

  async function pollStepReady(stepName: string, stepOptions: DefineStepOptions): Promise<void> {
    const startedAt = Date.now();
    const pollInterval = stepOptions.readyPollIntervalMs ?? options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;

    while (true) {
      const progress = await client.getRunProgress(options.benchmarkSlug, options.runId);
      const participant = progress.participants.find((item) => item.slug === options.participantSlug);
      const step = participant?.concurrency.find((item) => item.step === stepName);
      if (step?.ready) return;

      if (typeof stepOptions.readyTimeoutMs === 'number' && Date.now() - startedAt >= stepOptions.readyTimeoutMs) {
        throw new Error(`Timed out waiting for benchmark step "${stepName}" to become ready.`);
      }

      await sleep(pollInterval);
    }
  }

  async function waitForStepReady(stepName: string, stepOptions: DefineStepOptions): Promise<void> {
    const existing = readyWaitByStep.get(stepName);
    if (existing) return existing;

    const wait = pollStepReady(stepName, stepOptions).finally(() => {
      if (readyWaitByStep.get(stepName) === wait) readyWaitByStep.delete(stepName);
    });
    readyWaitByStep.set(stepName, wait);
    return wait;
  }

  const heartbeat = setInterval(() => {
    requestHeartbeat();
  }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  async function flush(isFinal: boolean, force = false): Promise<void> {
    flushChain = flushChain.then(async () => {
      if (force && doneCount >= taskIndices.length) return;
      while (pending.length >= batchSize || ((isFinal || force) && pending.length > 0)) {
        const batch = pending.splice(0, batchSize);
        await client.sendTaskResults({
          benchmarkSlug: options.benchmarkSlug,
          runId: options.runId,
          workerId: claimed.workerId,
          attemptId: claimed.attemptId,
          sequenceNumber,
          isFinal: isFinal && pending.length === 0,
          records: batch,
        });
        sequenceNumber += 1;
      }
    });
    await flushChain;
  }

  const resultFlush = setInterval(() => {
    if (doneCount < taskIndices.length) void flush(false, true).catch(() => {});
  }, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  resultFlush.unref?.();

  // Accumulated across the worker's tasks via `ctx.step` and `ctx.log`,
  // uploaded as a `coordinator.log` worker artifact. Flushed incrementally
  // when `logFlushIntervalMs` is set and once when the worker finishes.
  const workerLogLines: string[] = [];
  let workerLogTruncated = false;
  function appendWorkerLog(line: string): void {
    if (workerLogLines.length >= maxLogLines) {
      if (!workerLogTruncated) {
        workerLogTruncated = true;
        workerLogLines.push('... (worker log truncated)');
      }
      return;
    }
    workerLogLines.push(line);
  }

  function appendPrefixedLines(prefix: string, channel: string, text: string): void {
    const timestamp = new Date().toISOString();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.length === 0) continue;
      appendWorkerLog(`${timestamp} ${prefix} ${channel}: ${line}`);
    }
  }

  function appendStepOutcome(name: string, taskIndex: number, outcome: BenchmarkStepOutcome): void {
    const prefix = `[task ${taskIndex}] ${name}`;
    if (outcome.stdout?.trim()) appendPrefixedLines(prefix, 'stdout', outcome.stdout.trim());
    if (outcome.stderr?.trim()) appendPrefixedLines(prefix, 'stderr', outcome.stderr.trim());
    if (outcome.error?.trim()) appendPrefixedLines(prefix, 'error', outcome.error.trim());
  }

  async function runFinishHook(status: 'success' | 'error'): Promise<void> {
    await options.onFinish?.({
      assignment: claimed,
      records,
      status,
      client,
      uploadArtifact(input) {
        return client.uploadWorkerArtifact(options.benchmarkSlug, options.runId, claimed.workerId, {
          ...input,
          attemptId: claimed.attemptId,
        });
      },
    });
  }

  let logUploadInFlight: Promise<void> | undefined;

  async function uploadWorkerLogArtifact(isFinal: boolean = false): Promise<void> {
    if (logUploadInFlight) {
      if (!isFinal) return;
      // At finish, wait for the in-flight upload before flushing any remaining
      // lines appended after its snapshot.
      await logUploadInFlight.catch(() => {});
    }

    const snapshot = workerLogLines.slice();
    if (snapshot.length === 0) return;

    let uploaded = false;
    const upload = (async () => {
      try {
        const bodyText = snapshot.join('\n') + '\n';
        const body = logCompression === 'gzip' ? await gzip(bodyText) : bodyText;
        const contentType = logCompression === 'gzip' ? 'application/gzip' : 'text/plain';
        await client.uploadWorkerArtifact(options.benchmarkSlug, options.runId, claimed.workerId, {
          attemptId: claimed.attemptId,
          kind: 'coordinator.log',
          contentType,
          name: 'worker.log',
          body,
        });
        uploaded = true;
        // Only remove the lines that were uploaded; lines appended during the
        // upload remain buffered for the next flush.
        workerLogLines.splice(0, snapshot.length);
      } catch {
        // Log upload is best-effort; never fail the run over it.
      }
    })();

    logUploadInFlight = upload;
    try {
      await upload;
    } finally {
      if (logUploadInFlight === upload) {
        logUploadInFlight = undefined;
      }
      if (isFinal && uploaded && workerLogLines.length > 0) {
        // Flush any lines appended while this upload was in flight.
        await uploadWorkerLogArtifact(true).catch(() => {});
      }
    }
  }

  const logFlush =
    logFlushIntervalMs > 0
      ? setInterval(() => {
          if (workerLogLines.length > 0) void uploadWorkerLogArtifact(false).catch(() => {});
        }, logFlushIntervalMs)
      : undefined;
  logFlush?.unref?.();

  // Sampled on an interval and uploaded once as a `system-metrics` artifact
  // at finish, mirroring how the worker log is buffered and uploaded. Samples
  // are this worker process's own CPU/memory plus host-wide load average and
  // socket counts — not the sandbox/VM's total resource usage.
  const systemMetricsCollector = metricsIntervalMs > 0 ? createSystemMetricsCollector() : undefined;
  const systemMetricsSamples: BenchmarkSystemMetricsSample[] = [];
  const metricsInterval =
    systemMetricsCollector && metricsIntervalMs > 0
      ? setInterval(() => {
          systemMetricsSamples.push(systemMetricsCollector.sample());
        }, metricsIntervalMs)
      : undefined;
  metricsInterval?.unref?.();

  async function uploadSystemMetricsArtifact(): Promise<void> {
    if (systemMetricsSamples.length === 0) return;
    try {
      const body = systemMetricsSamples.map((sample) => JSON.stringify(sample)).join('\n') + '\n';
      await client.uploadWorkerArtifact(options.benchmarkSlug, options.runId, claimed.workerId, {
        attemptId: claimed.attemptId,
        kind: 'system-metrics',
        contentType: 'application/x-ndjson',
        name: 'metrics.jsonl',
        body,
      });
    } catch {
      // Metrics upload is best-effort; never fail the run over it.
    }
  }

  try {
    await sendHeartbeat().catch(() => {});
    // An immediate baseline sample, same reasoning as the heartbeat above: a
    // worker that finishes inside one metricsIntervalMs window would
    // otherwise upload no metrics artifact at all.
    if (systemMetricsCollector) systemMetricsSamples.push(systemMetricsCollector.sample());

    await mapPool(taskIndices, workerConcurrency, async (taskIndex) => {
      inFlightCount += 1;
      const startedAtDate = new Date();
      const startedAtMs = Date.now();
      const record: TaskResultRecord = {
        taskIndex,
        status: 'success',
        startedAt: startedAtDate.toISOString(),
      };
      const steps: TaskStepRecord[] = [];
      const taskMeasures: JsonObject = {};
      // The step a `measure(...)` call currently attributes to. Set while a
      // step's fn runs; null at task top-level (measures go on the record).
      let activeStep: TaskStepRecord | null = null;

      function measure(data: JsonObject): void {
        if (activeStep) {
          activeStep.data = { ...(activeStep.data ?? {}), ...data };
        } else {
          Object.assign(taskMeasures, data);
        }
      }

      function log(message: string, metaOrOptions?: JsonObject | BenchmarkLogOptions): void {
        const opts: { level: BenchmarkLogLevel; meta?: JsonObject } = isLogOptions(metaOrOptions)
          ? { level: metaOrOptions.level ?? 'info', meta: metaOrOptions.meta }
          : { level: 'info', meta: metaOrOptions };
        if (!shouldLog(opts.level, logLevel)) return;
        const suffix = opts.meta && Object.keys(opts.meta).length > 0 ? ` ${JSON.stringify(opts.meta)}` : '';
        appendWorkerLog(`${new Date().toISOString()} [task ${taskIndex}] [${opts.level}] ${message}${suffix}`);
      }

      async function step<T>(name: string, fn: () => Promise<T> | T, stepOptions: DefineStepOptions = {}): Promise<T> {
        const stepStartedAtMs = Date.now();
        const stepRecord: TaskStepRecord = {
          name,
          status: 'success',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          latencyMs: 0,
        };
        if (stepOptions.timeoutMs !== undefined) stepRecord.timeoutMs = stepOptions.timeoutMs;
        if (stepOptions.stepConcurrency !== undefined) stepRecord.concurrency = stepOptions.stepConcurrency;

        const shouldReportConcurrency = stepOptions.reportConcurrency ?? true;
        if (shouldReportConcurrency) {
          const stepConcurrency = stepOptions.concurrency ?? workerConcurrency;
          validatePositiveInteger(`step "${name}" concurrency`, stepConcurrency);
          targetByStep.set(name, stepConcurrency);
          activeByStep.set(name, (activeByStep.get(name) ?? 0) + 1);
          requestHeartbeat();
        }

        const previousStep = activeStep;
        activeStep = stepRecord;
        try {
          if (stepOptions.readiness === 'poll') {
            await waitForStepReady(name, stepOptions);
          }
          const value = await fn();
          appendWorkerLog(`${new Date().toISOString()} [task ${taskIndex}] [info] ${name}`);
          if (stepOptions.captureOutput !== false && isStepOutcome(value)) {
            appendStepOutcome(name, taskIndex, value);
          }
          return value;
        } catch (error) {
          stepRecord.status = 'error';
          stepRecord.errorCode = getErrorCode(error);
          appendWorkerLog(`${new Date().toISOString()} [task ${taskIndex}] [error] ${name}`);
          appendWorkerLog(`  error: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        } finally {
          activeStep = previousStep;
          stepRecord.completedAt = new Date().toISOString();
          stepRecord.latencyMs = Date.now() - stepStartedAtMs;
          steps.push(stepRecord);
          if (shouldReportConcurrency) {
            const nextActive = Math.max(0, (activeByStep.get(name) ?? 0) - 1);
            if (nextActive === 0) {
              activeByStep.delete(name);
              targetByStep.delete(name);
            } else {
              activeByStep.set(name, nextActive);
            }
            requestHeartbeat();
          }
        }
      }

      try {
        const data = await options.task({ assignment: claimed, taskIndex, step, measure, log });
        record.data = mergeMeasures(taskMeasures, toJsonObject(data));
      } catch (error) {
        record.status = 'error';
        record.errorCode = getErrorCode(error);
        record.data = mergeMeasures(taskMeasures, { errorMessage: error instanceof Error ? error.message : String(error) });
      } finally {
        record.completedAt = new Date().toISOString();
        record.latencyMs = Date.now() - startedAtMs;
        // A task with no explicit steps is recorded as a single implicit
        // 'task' step, so every task contributes at least one step row.
        if (steps.length === 0) {
          steps.push(implicitTaskStep(record, taskMeasures));
        }
        record.steps = steps;
        doneCount += 1;
        inFlightCount = Math.max(0, inFlightCount - 1);
        if (record.status !== 'success') errorCount += 1;
      }

      records.push(record);
      pending.push(record);
      options.onResult?.(record);
      if (pending.length >= batchSize) await flush(false);
    });

    await flush(true);

    const hasErrors = records.some((record) => record.status !== 'success');
    try {
      await runFinishHook(hasErrors ? 'error' : 'success');
    } catch (error) {
      if (!hasErrors) throw error;
    }

    if (hasErrors) {
      await client.failWorker(options.benchmarkSlug, options.runId, claimed.workerId, claimed.attemptId, new Error('One or more tasks failed'));
    } else {
      await client.completeWorker(options.benchmarkSlug, options.runId, claimed.workerId, claimed.attemptId);
    }

    return { assignment: claimed, records };
  } catch (error) {
    await flush(true).catch(() => {});
    await runFinishHook('error').catch(() => {});
    await client.failWorker(options.benchmarkSlug, options.runId, claimed.workerId, claimed.attemptId, error).catch(() => {});
    throw error;
  } finally {
    if (logFlush) clearInterval(logFlush);
    await uploadWorkerLogArtifact(true);
    if (metricsInterval) clearInterval(metricsInterval);
    if (systemMetricsCollector) systemMetricsSamples.push(systemMetricsCollector.sample());
    systemMetricsCollector?.stop();
    await uploadSystemMetricsArtifact();
    clearInterval(heartbeat);
    clearInterval(resultFlush);
  }
}
