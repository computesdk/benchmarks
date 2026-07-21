import { config as loadDotenv } from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createBenchmarkClient, defineStep, defineTask, runBenchmarkWorker } from '@computesdk/bench';
import type { BenchmarkAssignment, JsonObject, TaskResultRecord, TaskStepRecord } from '@computesdk/bench';
import { getProvider } from './providers.js';
import { log } from './logger.js';
import type { FailureClass, MetricsSample, SandboxResult, SandboxResultStatus } from './types.js';
import {
  FIRST_COMMAND_TIMEOUT_MS,
  LIVENESS_CHECK_TIMEOUT_MS,
  extractProviderMetadata,
  withTimeout,
} from './runner.js';

loadDotenv();

const METRICS_SAMPLE_MS = 200;

type SandboxState = {
  sandbox?: any;
};

type PreparedArtifact = {
  kind: string;
  name: string;
  contentType: string;
  uploadUrl: string;
};

type PreparedArtifacts = Partial<Record<'raw' | 'meta' | 'metrics' | 'log', PreparedArtifact>>;

async function main() {
  const PROVIDER = required('PROVIDER');
  const BENCHMARK_RUN_ID = required('BENCHMARK_RUN_ID');
  const provider = getProvider(PROVIDER);

  const RUN_ID = process.env.RUN_ID ?? BENCHMARK_RUN_ID;
  const instanceId = process.env.INSTANCE_ID ?? 'local';
  const benchmarkSlug = process.env.BENCHMARK_SLUG ?? 'scale';
  const participantSlug = process.env.PARTICIPANT_SLUG ?? PROVIDER;
  const commitSha = process.env.GITHUB_SHA ?? 'local';

  const override = process.env.CONCURRENCY_TARGET;
  if (override) provider.concurrencyTarget = parseInt(override, 10);

  const liveHoldMs = parsePositiveInt(process.env.LIFECYCLE_PAUSE_MS, 90_000, true);

  log.phase('scale sdk coordinator starting');
  log.info(`provider=${PROVIDER} (requires: ${provider.requiredEnvVars.join(', ') || 'none'})`);
  log.info(`concurrency=${provider.concurrencyTarget} timeout=${provider.perRequestTimeoutMs ?? 120_000}ms`);
  log.info(`live_hold_ms=${liveHoldMs}`);
  log.info(`commit_sha=${commitSha} instance_id=${instanceId}`);

  log.phase('validating environment');
  const missing = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    log.error(`Missing required env vars for ${PROVIDER}: ${missing.join(', ')}`);
    process.exit(1);
  }
  log.ok(`all ${provider.requiredEnvVars.length} provider env var(s) present`);

  log.phase('initializing compute client');
  const compute = provider.createCompute();
  log.ok(`compute client ready for ${PROVIDER}`);
  const benchClient = createBenchmarkClient({ apiKey: process.env.COMPUTESDK_API_KEY ?? process.env.COMPUTESDK_ADMIN_API_KEY });
  const sandboxResults: SandboxResult[] = [];
  const metricsStartedAt = Date.now();
  const metricsSamples: MetricsSample[] = [];
  const eloopHist = monitorEventLoopDelay({ resolution: 20 });
  eloopHist.enable();
  const cpuBaseline = process.cpuUsage();
  const metricsInterval = setInterval(() => {
    sampleMetrics();
  }, METRICS_SAMPLE_MS);
  let preparedArtifacts: Promise<PreparedArtifacts> | null = null;
  const runStartedAt = Date.now();
  const statusCounts: Record<SandboxResultStatus, number> = {
    success: 0,
    partial: 0,
    readiness_failed: 0,
    failed: 0,
    worker_ready_failed: 0,
  };
  const createLatencies: number[] = [];
  const createStepLatencies: number[] = [];
  let completedTasks = 0;
  let nextProgressAt = Math.max(1, Math.ceil(provider.concurrencyTarget / 10));
  let completedCreates = 0;
  let failedCreates = 0;
  let nextCreateProgressAt = Math.max(1, Math.ceil(provider.concurrencyTarget / 10));
  let workerReadyReleased = false;
  let createStarted = false;
  let liveHoldStarted = false;
  let liveHoldFinished = false;

  const logProgress = (result: SandboxResult): void => {
    completedTasks++;
    statusCounts[result.status]++;
    if (result.status === 'success') createLatencies.push(result.latency_ms);

    if (result.status !== 'success') {
      log.warn(
        `task ${result.sandbox_idx} ${result.status}` +
        ` create=${result.latency_ms}ms first_command=${result.first_command_ms ?? '-'}ms` +
        ` error=${result.error_code ?? result.failure_class ?? 'unknown'}`,
      );
    }

    const shouldLog = completedTasks === 1 || completedTasks >= nextProgressAt || completedTasks === provider.concurrencyTarget;
    if (!shouldLog) return;

    while (nextProgressAt <= completedTasks) nextProgressAt += Math.max(1, Math.ceil(provider.concurrencyTarget / 10));
    const elapsedMs = Date.now() - runStartedAt;
    const rate = completedTasks / Math.max(0.001, elapsedMs / 1000);
    const sorted = [...createLatencies].sort((a, b) => a - b);
    const p50 = sorted.length ? percentile(sorted, 0.5) : null;
    const p95 = sorted.length ? percentile(sorted, 0.95) : null;
    log.stat(
      `progress ${completedTasks}/${provider.concurrencyTarget}` +
      ` elapsed=${formatDuration(elapsedMs)} rate=${rate.toFixed(1)}/s` +
      ` success=${statusCounts.success} partial=${statusCounts.partial}` +
      ` readiness_failed=${statusCounts.readiness_failed} failed=${statusCounts.failed}` +
      ` worker_ready_failed=${statusCounts.worker_ready_failed}` +
      ` create_p50=${p50 ?? '-'}ms create_p95=${p95 ?? '-'}ms`,
    );
  };

  const logCreateProgress = (): void => {
    const shouldLog = completedCreates === 1 || completedCreates >= nextCreateProgressAt || completedCreates === provider.concurrencyTarget;
    if (!shouldLog) return;

    while (nextCreateProgressAt <= completedCreates) nextCreateProgressAt += Math.max(1, Math.ceil(provider.concurrencyTarget / 10));
    const sorted = [...createStepLatencies].sort((a, b) => a - b);
    const p50 = sorted.length ? percentile(sorted, 0.5) : null;
    const p95 = sorted.length ? percentile(sorted, 0.95) : null;
    log.stat(
      `create progress ${completedCreates}/${provider.concurrencyTarget}` +
      ` ok=${completedCreates - failedCreates} failed=${failedCreates}` +
      ` elapsed=${formatDuration(Date.now() - runStartedAt)}` +
      ` create_p50=${p50 ?? '-'}ms create_p95=${p95 ?? '-'}ms`,
    );
  };

  const task = defineTask<SandboxState>('sandbox.lifecycle', [
    defineStep<SandboxState>('worker.ready', { reportConcurrency: false }, async () => {
      if (!workerReadyReleased) {
        workerReadyReleased = true;
        log.ok(`worker.ready reached after ${formatDuration(Date.now() - runStartedAt)}; create phase starting`);
      }
    }),

    defineStep<SandboxState>('create', { reportConcurrency: false }, async ({ assignment, state, taskIndex }) => {
      if (!createStarted) {
        createStarted = true;
        log.phase(`create — issuing up to ${provider.concurrencyTarget} concurrent sandbox.create calls`);
        log.info(
          `assignment worker=${assignment.workerIndex + 1}/${assignment.workerCount}` +
          ` tasks=${assignment.taskRange.start}..${assignment.taskRange.end - 1}` +
          ` target=${assignment.targetConcurrency}`,
        );
      }
      preparedArtifacts ??= prepareArtifacts({ assignment, benchmarkSlug, runId: BENCHMARK_RUN_ID, client: benchClient });
      const createStartedAt = Date.now();
      try {
        state.sandbox = await withTimeout(
          compute.sandbox.create(provider.sandboxOptions),
          provider.perRequestTimeoutMs ?? 120_000,
        );
        const createMs = Date.now() - createStartedAt;
        createStepLatencies.push(createMs);
        completedCreates++;
        logCreateProgress();
        const metadata = extractProviderMetadata(state.sandbox);
        return {
          sandbox_idx: taskIndex,
          ...(typeof metadata?.sandboxId === 'string' ? { sandboxId: metadata.sandboxId } : {}),
        };
      } catch (err: any) {
        const createMs = Date.now() - createStartedAt;
        completedCreates++;
        failedCreates++;
        log.warn(`create task ${taskIndex} failed after ${createMs}ms: ${err?.code ?? err?.name ?? err?.message ?? err}`);
        logCreateProgress();
        throw err;
      }
    }),

    defineStep<SandboxState>('exec.initial', { reportConcurrency: false }, async ({ state }) => {
      await withTimeout(state.sandbox.runCommand('node -v'), FIRST_COMMAND_TIMEOUT_MS);
    }),

    defineStep<SandboxState>('sandbox.live', { reportConcurrency: false }, async () => {
      if (!liveHoldStarted) {
        liveHoldStarted = true;
        log.ok(`sandbox.live hold started after ${formatDuration(Date.now() - runStartedAt)}; holding live sandboxes for ${formatDuration(liveHoldMs)}`);
      }
      if (liveHoldMs > 0) await new Promise(resolve => setTimeout(resolve, liveHoldMs));
      if (!liveHoldFinished) {
        liveHoldFinished = true;
        log.ok(`live hold complete after ${formatDuration(Date.now() - runStartedAt)}; final liveness checks starting`);
      }
    }),

    defineStep<SandboxState>('exec.final', { reportConcurrency: false }, async ({ state }) => {
      await withTimeout(state.sandbox.runCommand('node -v'), LIVENESS_CHECK_TIMEOUT_MS);
    }),

    defineStep<SandboxState>('destroy', { reportConcurrency: false }, async ({ state }) => {
      if (state.sandbox?.destroy) await Promise.resolve(state.sandbox.destroy()).catch(() => {});
    }),
  ]);

  log.phase('claiming benchmark worker');
  log.info(`benchmark=${benchmarkSlug} run=${BENCHMARK_RUN_ID} participant=${participantSlug} process_key=${instanceId}`);
  log.info(`worker.ready concurrency reporting disabled; create starts as each task reaches worker.ready`);

  const result = await runBenchmarkWorker(
    { apiKey: process.env.COMPUTESDK_API_KEY ?? process.env.COMPUTESDK_ADMIN_API_KEY },
    {
      benchmarkSlug,
      runId: BENCHMARK_RUN_ID,
      participantSlug,
      processKind: 'container',
      processKey: instanceId,
      batchSize: 500,
      heartbeatIntervalMs: 2_000,
      task,
      onResult: (record) => {
        const normalized = normalizeTaskRecord(record);
        sandboxResults.push(normalized);
        logProgress(normalized);
      },
    },
  );
  if (!result.assignment) {
    log.warn('bench: no pending worker to claim');
    process.exit(0);
  }
  clearInterval(metricsInterval);
  sampleMetrics();

  const errors = result.records.filter(record => record.status !== 'success').length;
  log.phase('run complete');
  log.ok(`${result.records.length - errors}/${result.records.length} tasks succeeded in ${formatDuration(Date.now() - runStartedAt)}`);
  log.info(
    `status success=${statusCounts.success} partial=${statusCounts.partial}` +
    ` readiness_failed=${statusCounts.readiness_failed} failed=${statusCounts.failed}` +
    ` worker_ready_failed=${statusCounts.worker_ready_failed}`,
  );
  if (errors > 0) log.warn(`${errors} task(s) failed before completing sandbox lifecycle`);
  log.phase('uploading artifacts');
  await uploadArtifacts({
    assignment: result.assignment,
    benchmarkSlug,
    runId: BENCHMARK_RUN_ID,
    provider: PROVIDER,
    logicalRunId: RUN_ID,
    target: provider.concurrencyTarget,
    results: sandboxResults,
    metricsSamples,
    client: benchClient,
    prepared: preparedArtifacts ? await preparedArtifacts : null,
  });
  process.exit(errors > 0 ? 1 : 0);

  function sampleMetrics(): MetricsSample {
    const cpu = process.cpuUsage(cpuBaseline);
    const mem = process.memoryUsage();
    const load = os.loadavg();
    const sample: MetricsSample = {
      ts: new Date().toISOString(),
      uptime_ms: Date.now() - metricsStartedAt,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      mem_rss_mb: Math.round(mem.rss / 1024 / 1024),
      mem_heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      mem_heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      mem_external_mb: Math.round(mem.external / 1024 / 1024),
      event_loop_p50_ms: eloopHist.percentile(50) / 1e6,
      event_loop_p99_ms: eloopHist.percentile(99) / 1e6,
      event_loop_max_ms: eloopHist.max / 1e6,
      loadavg_1m: load[0],
      loadavg_5m: load[1],
      loadavg_15m: load[2],
      open_fds: countOpenFds(),
      sockstat: readSockstat(),
    };
    eloopHist.reset();
    metricsSamples.push(sample);
    return sample;
  }
}

function normalizeTaskRecord(record: TaskResultRecord): SandboxResult {
  const workerReadyStep = stepByName(record, 'worker.ready');
  const createStep = stepByName(record, 'create');
  const initialStep = stepByName(record, 'exec.initial');
  const liveStep = stepByName(record, 'sandbox.live');
  const finalStep = stepByName(record, 'exec.final');
  const failedStep = record.steps?.find(step => step.status === 'error');
  const lifecycleStatus = lifecycleStatusFor(failedStep?.name);

  record.status = lifecycleStatus;
  record.latencyMs = createStep?.latencyMs ?? (lifecycleStatus === 'worker_ready_failed' ? 0 : record.latencyMs);
  record.firstCommandMs = initialStep?.status === 'success' ? initialStep.latencyMs ?? null : null;
  record.errorCode = failedStep?.errorCode ?? null;

  const failureClass = lifecycleStatus === 'success' ? null : classifyFailure(failedStep?.errorCode);
  const data = (record.data ?? {}) as Record<string, unknown>;
  const createMs = createStep?.latencyMs ?? (lifecycleStatus === 'worker_ready_failed' ? 0 : record.latencyMs ?? 0);
  const firstCommandMs = initialStep?.status === 'success' ? initialStep.latencyMs ?? null : null;
  const ttiMs = firstCommandMs == null ? null : createMs + firstCommandMs;
  const sandboxResult: SandboxResult = {
    sandbox_idx: record.taskIndex,
    started_at: createStep?.startedAt ?? record.startedAt ?? new Date().toISOString(),
    completed_at: record.completedAt ?? new Date().toISOString(),
    latency_ms: createMs,
    first_command_ms: firstCommandMs,
    status: lifecycleStatus,
    failure_class: failureClass,
    http_status: null,
    error_code: failedStep?.errorCode ?? null,
    error_message: null,
    provider_metadata: typeof data.sandboxId === 'string' ? { sandboxId: data.sandboxId } : null,
  };

  record.data = {
    ...data,
    lifecycle_status: lifecycleStatus,
    failure_class: failureClass,
    http_status: null,
    error_message: null,
    worker_ready_ms: workerReadyStep?.latencyMs ?? null,
    worker_ready_started_at: workerReadyStep?.startedAt ?? null,
    create_ms: createStep?.latencyMs ?? null,
    first_command_ms: firstCommandMs,
    tti_ms: ttiMs,
    live_ms: liveStep?.latencyMs ?? null,
    final_command_ms: finalStep?.latencyMs ?? null,
    sandbox_result: sandboxResult as unknown as JsonObject,
  };
  return sandboxResult;
}

function stepByName(record: TaskResultRecord, name: string): TaskStepRecord | undefined {
  return record.steps?.find(step => step.name === name);
}

function lifecycleStatusFor(stepName: string | undefined): SandboxResultStatus {
  if (!stepName) return 'success';
  if (stepName === 'worker.ready') return 'worker_ready_failed';
  if (stepName === 'create') return 'failed';
  if (stepName === 'exec.initial') return 'readiness_failed';
  return 'partial';
}

function classifyFailure(errorCode: string | null | undefined): FailureClass {
  const value = (errorCode ?? '').toLowerCase();
  if (value.includes('timeout')) return 'timeout';
  if (value.includes('http') || value.includes('status')) return 'http_error';
  return 'network_error';
}

async function uploadArtifacts(input: {
  assignment: BenchmarkAssignment;
  benchmarkSlug: string;
  runId: string;
  logicalRunId: string;
  provider: string;
  target: number;
  results: SandboxResult[];
  metricsSamples: MetricsSample[];
  client: ReturnType<typeof createBenchmarkClient>;
  prepared: PreparedArtifacts | null;
}): Promise<void> {
  const raw = input.results.map(result => JSON.stringify(result)).join('\n') + (input.results.length ? '\n' : '');
  const meta = buildMeta(input.logicalRunId, input.provider, input.target, input.results, input.metricsSamples);
  const metrics = input.metricsSamples.map(sample => JSON.stringify(sample)).join('\n') + (input.metricsSamples.length ? '\n' : '');
  await uploadPreparedOrCreate(input, input.prepared?.raw, 'raw-results', 'raw.jsonl', 'application/x-ndjson', raw);
  await uploadPreparedOrCreate(input, input.prepared?.meta, 'summary', 'meta.json', 'application/json', JSON.stringify(meta, null, 2));
  await uploadPreparedOrCreate(input, input.prepared?.metrics, 'system-metrics', 'metrics.jsonl', 'application/x-ndjson', metrics);
  await uploadPreparedOrCreate(input, input.prepared?.log, 'log', 'coordinator.log', 'text/plain; charset=utf-8', log.dump());
}

async function prepareArtifacts(input: {
  assignment: BenchmarkAssignment;
  benchmarkSlug: string;
  runId: string;
  client: ReturnType<typeof createBenchmarkClient>;
}): Promise<PreparedArtifacts> {
  const entries = await Promise.all([
    prepareArtifact(input, 'raw', 'raw-results', 'raw.jsonl', 'application/x-ndjson'),
    prepareArtifact(input, 'meta', 'summary', 'meta.json', 'application/json'),
    prepareArtifact(input, 'metrics', 'system-metrics', 'metrics.jsonl', 'application/x-ndjson'),
    prepareArtifact(input, 'log', 'log', 'coordinator.log', 'text/plain; charset=utf-8'),
  ]);
  const out: PreparedArtifacts = {};
  for (const entry of entries) {
    if (entry) out[entry.key] = entry.artifact;
  }
  return out;
}

async function prepareArtifact(
  input: Pick<Parameters<typeof prepareArtifacts>[0], 'assignment' | 'benchmarkSlug' | 'runId' | 'client'>,
  key: keyof PreparedArtifacts,
  kind: string,
  name: string,
  contentType: string,
): Promise<{ key: keyof PreparedArtifacts; artifact: PreparedArtifact } | null> {
  try {
    const res = await input.client.createWorkerArtifact(input.benchmarkSlug, input.runId, input.assignment.workerId, {
      attemptId: input.assignment.attemptId,
      kind,
      name,
      contentType,
      metadata: { prepared: true },
    });
    const uploadUrl = res.uploadUrl ?? res.artifact?.uploadUrl;
    if (!uploadUrl) throw new Error('no uploadUrl returned');
    return { key, artifact: { kind, name, contentType, uploadUrl } };
  } catch (err: any) {
    log.warn(`bench: artifact ${name} prepare failed: ${err?.message ?? err}`);
    return null;
  }
}

async function uploadPreparedOrCreate(
  input: Pick<Parameters<typeof uploadArtifacts>[0], 'assignment' | 'benchmarkSlug' | 'runId' | 'client'>,
  prepared: PreparedArtifact | undefined,
  kind: string,
  name: string,
  contentType: string,
  body: string,
): Promise<void> {
  if (prepared) {
    await putArtifact(prepared.name, prepared.kind, prepared.contentType, prepared.uploadUrl, body);
    return;
  }
  await uploadArtifact(input, kind, name, contentType, body);
}

async function uploadArtifact(
  input: Pick<Parameters<typeof uploadArtifacts>[0], 'assignment' | 'benchmarkSlug' | 'runId' | 'client'>,
  kind: string,
  name: string,
  contentType: string,
  body: string,
): Promise<void> {
  try {
    const sizeBytes = Buffer.byteLength(body);
    const res = await input.client.createWorkerArtifact(input.benchmarkSlug, input.runId, input.assignment.workerId, {
      attemptId: input.assignment.attemptId,
      kind,
      name,
      contentType,
      metadata: { sizeBytes },
    });
    const uploadUrl = res.uploadUrl ?? res.artifact?.uploadUrl;
    if (!uploadUrl) throw new Error('no uploadUrl returned');
    await putArtifact(name, kind, contentType, uploadUrl, body, sizeBytes);
  } catch (err: any) {
    log.warn(`bench: artifact ${name} upload failed: ${err?.message ?? err}`);
  }
}

async function putArtifact(
  name: string,
  kind: string,
  contentType: string,
  uploadUrl: string,
  body: string,
  sizeBytes = Buffer.byteLength(body),
): Promise<void> {
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body });
  if (!put.ok) throw new Error(`${put.status} ${put.statusText}`);
  log.ok(`bench: uploaded artifact ${name} (${kind}, ${sizeBytes}b)`);
}

function buildMeta(
  runId: string,
  provider: string,
  target: number,
  results: SandboxResult[],
  metricsSamples: MetricsSample[],
): Record<string, unknown> {
  const byStatus = {
    success: results.filter(result => result.status === 'success'),
    partial: results.filter(result => result.status === 'partial'),
    readiness_failed: results.filter(result => result.status === 'readiness_failed'),
    failed: results.filter(result => result.status === 'failed'),
    worker_ready_failed: results.filter(result => result.status === 'worker_ready_failed'),
  };
  const createFailureClass = {
    timeout: byStatus.failed.filter(result => result.failure_class === 'timeout').length,
    http_error: byStatus.failed.filter(result => result.failure_class === 'http_error').length,
    network_error: byStatus.failed.filter(result => result.failure_class === 'network_error').length,
  };
  const successLatencies = byStatus.success.map(result => result.latency_ms).sort((a, b) => a - b);
  const firstCommandValues = byStatus.success
    .map(result => result.first_command_ms)
    .filter((value): value is number => value != null);
  const ttiValues = byStatus.success
    .filter(result => result.first_command_ms != null)
    .map(ttiMsOf);

  return {
    sandboxes_attempted: target,
    sandboxes_succeeded: byStatus.success.length,
    partials: byStatus.partial.length,
    readiness_failures: byStatus.readiness_failed.length,
    worker_ready_failures: byStatus.worker_ready_failed.length,
    failures: byStatus.failed.length,
    timeouts: createFailureClass.timeout,
    http_errors: createFailureClass.http_error,
    network_errors: createFailureClass.network_error,
    p50_latency_ms: percentile(successLatencies, 0.5),
    p99_latency_ms: percentile(successLatencies, 0.99),
    latency_distribution: distributionOf(successLatencies),
    first_command_distribution: distributionOf(firstCommandValues),
    tti_distribution: distributionOf(ttiValues),
    status_histogram: {
      success: byStatus.success.length,
      partial: byStatus.partial.length,
      readiness_failed: byStatus.readiness_failed.length,
      failed: byStatus.failed.length,
      worker_ready_failed: byStatus.worker_ready_failed.length,
    },
    create_failure_class: createFailureClass,
    metrics_summary: metricsSummary(metricsSamples),
    run_id: runId,
    provider,
    ended_at: new Date().toISOString(),
  };
}

function metricsSummary(samples: MetricsSample[]): Record<string, number> | null {
  if (samples.length === 0) return null;
  return {
    sample_count: samples.length,
    sample_interval_ms: METRICS_SAMPLE_MS,
    peak_mem_rss_mb: Math.max(...samples.map(s => s.mem_rss_mb)),
    peak_mem_heap_used_mb: Math.max(...samples.map(s => s.mem_heap_used_mb)),
    peak_event_loop_p99_ms: Math.max(...samples.map(s => s.event_loop_p99_ms)),
    peak_event_loop_max_ms: Math.max(...samples.map(s => s.event_loop_max_ms)),
    peak_open_fds: Math.max(...samples.map(s => s.open_fds ?? 0)),
    peak_tcp_inuse: Math.max(...samples.map(s => s.sockstat?.tcp_inuse ?? 0)),
    peak_tcp_tw: Math.max(...samples.map(s => s.sockstat?.tcp_tw ?? 0)),
    total_cpu_user_us: samples[samples.length - 1].cpu_user_us,
    total_cpu_system_us: samples[samples.length - 1].cpu_system_us,
  };
}

function ttiMsOf(result: SandboxResult): number {
  return result.latency_ms + (result.first_command_ms ?? 0);
}

function distributionOf(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min_ms: sorted[0],
    p10_ms: percentile(sorted, 0.10),
    p25_ms: percentile(sorted, 0.25),
    p50_ms: percentile(sorted, 0.50),
    p75_ms: percentile(sorted, 0.75),
    p90_ms: percentile(sorted, 0.90),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    p999_ms: percentile(sorted, 0.999),
    max_ms: sorted[sorted.length - 1],
    mean_ms: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function percentile(sortedValues: number[], quantile: number): number {
  return sortedValues.length === 0
    ? 0
    : sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * quantile))];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function readSockstat(): Record<string, number> | null {
  try {
    const data = fs.readFileSync('/proc/net/sockstat', 'utf-8');
    const out: Record<string, number> = {};
    for (const line of data.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const section = line.slice(0, idx).trim().toLowerCase();
      const parts = line.slice(idx + 1).trim().split(/\s+/);
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const n = parseInt(parts[i + 1], 10);
        if (!Number.isNaN(n)) out[`${section}_${parts[i]}`] = n;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function countOpenFds(): number | null {
  try { return fs.readdirSync('/proc/self/fd').length; } catch { return null; }
}

function parsePositiveInt(raw: string | undefined, fallback: number, allowZero = false): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

main().catch(err => {
  log.error(`crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
