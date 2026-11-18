/**
 * Sandbox Filesystem I/O benchmark: ONE fresh sandbox per task runs a
 * deterministic SQLite operation suite (sequential/batch inserts, count,
 * range/LIKE queries, updates, deletes, transaction inserts, aggregates,
 * join, concurrent reads) inside the sandbox via a single `node` call, so
 * the metric is real in-sandbox filesystem I/O — page cache flushes,
 * journal/WAL writes, and fsyncs — not API latency.
 *
 * Ported from tensorlakeai/sandbox-sqlite-bench. Three modes run as run
 * phases (`ctx.phase`): `default` (WAL, small dataset), `fsync`
 * (synchronous=FULL, no WAL), and `large` (50k-row dataset). Records are
 * tagged `data.phase` by the framework and `scoring.groupBy: 'phase'`
 * produces one results row per (provider, mode).
 *
 * `groupBy: 'round'` is used so the task owns its measured `latencyMs`
 * (the suite's totalMs) and can attach pre-measured per-operation steps.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 *   bench run sandbox-fs-io.bench.ts
 *   bench run sandbox-fs-io.bench.ts --provider e2b,modal --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import { continuousScoring } from './performance-runtime-scoring.js';
import path from 'node:path';
import type { JsonObject } from '@benchsdk/client';
import {
  defineBenchmarkConfig,
  defineTask,
  TaskError,
  type BenchmarkRunOutcome,
  type BenchmarkScoringConfig,
  type ParticipantRecords,
} from '@benchsdk/runner';
import { providers } from './providers.js';
import { getSandboxOptionsWithResources } from './sizes.js';
import type { ProviderConfig } from './types.js';
import type { FsIoMode, FsIoWorkloadResult } from './sandbox-fs-io.js';
import { MODES, OPS, runFsIoWorkload, SUITE_CONFIG } from './sandbox-fs-io.js';
import { writeFsIoLegacyResults } from './sandbox-fs-io-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import { printResultsTable } from './sandbox-fs-io-table.js';


const createTimeoutMs = 120_000;
const destroyTimeoutMs = 15_000;

interface FsIoSandbox {
  runCommand(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  destroy(): Promise<unknown>;
}

interface Compute {
  sandbox: {
    create(options?: Record<string, any>): Promise<FsIoSandbox>;
  };
}

// totalMs is the only metric that shapes the composite score; every
// per-operation timing is declared at weight 0 so the platform aggregates
// and displays it without affecting the composite.
const scoringMetrics: BenchmarkScoringConfig['metrics'] = [
  {
    key: 'totalMs',
    label: 'Suite total',
    unit: SUITE_CONFIG.unit,
    ceiling: SUITE_CONFIG.ceiling,
    higherIsBetter: false,
    weights: { median: 0.7, p95: 0.2, p99: 0.1 },
  },
  ...OPS.map((op) => ({
    key: op.metricKey,
    label: op.label,
    unit: 'ms',
    ceiling: 120_000,
    higherIsBetter: false,
    weights: { median: 0, p95: 0, p99: 0 },
  })),
  {
    key: 'concurrentReadsQps',
    label: 'Concurrent reads',
    unit: 'qps',
    ceiling: 100_000,
    higherIsBetter: true,
    weights: { median: 0, p95: 0, p99: 0 },
  },
  {
    key: 'createMs',
    label: 'Sandbox create',
    unit: 'ms',
    ceiling: 600_000,
    higherIsBetter: false,
    weights: { median: 0, p95: 0, p99: 0 },
  },
  {
    key: 'destroyMs',
    label: 'Sandbox destroy',
    unit: 'ms',
    ceiling: 600_000,
    higherIsBetter: false,
    weights: { median: 0, p95: 0, p99: 0 },
  },
];

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-fs-io',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox FS I/O',
  concurrency: 1,
  // One sandbox per task; the run covers every mode once per iteration.
  phases: MODES.map((name) => ({ name, iterations: SUITE_CONFIG.defaultReplicas })),
  groupBy: 'round',
  participants: providers,
  dimensions: {
    modes: MODES.join(','),
    operations: String(OPS.length),
  },
  display: {
    metrics: [
      { key: 'totalMs', label: 'Suite total', unit: 'ms', direction: 'lower-better' as const, decimals: 0, order: 1 },
      ...OPS.map((op, i) => ({
        key: op.metricKey,
        label: op.label,
        unit: 'ms',
        direction: 'lower-better' as const,
        decimals: 0,
        order: 2 + i,
      })),
      { key: 'concurrentReadsQps', label: 'Concurrent reads', unit: 'qps', direction: 'higher-better' as const, decimals: 0, order: 20 },
      { key: 'dbSizeMb', label: 'DB size', unit: 'MB', direction: 'higher-better' as const, decimals: 1, order: 21 },
    ],
    steps: [
      { key: 'create', label: 'Create', order: 1 },
      ...OPS.map((op, i) => ({ key: op.stepKey, label: op.label, order: 2 + i })),
      { key: 'fs-io', label: 'fs-io suite', order: 20 },
      { key: 'destroy', label: 'Destroy', order: 21 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' as const },
  },
  scoring: continuousScoring({
    // A record only counts when the in-sandbox suite ran to completion and
    // verified its row counts — partial suites don't get a score.
    success: { requireData: { verified: true } },
    metrics: scoringMetrics,
    // One results row per (provider, mode): the three phases are the
    // benchmark's headline breakdown.
    groupBy: 'phase',
  }, { totalMs: 8000 }),
  onComplete: async (outcome: BenchmarkRunOutcome) => {
    // The legacy results tree is one directory per mode; split the
    // phase-tagged records back out and write each mode's directory.
    for (const mode of MODES) {
      const participants: ParticipantRecords[] = outcome.participants.map((p) => ({
        ...p,
        records: p.records.filter(
          (r) => (r.data as { phase?: string } | undefined)?.phase === mode,
        ),
      }));
      const results = await writeFsIoLegacyResults(participants, {
        resultsDir: benchmarkResultsDir(`sandbox_fs_io/${mode}`),
        mode,
      });
      printResultsTable(mode, results);
    }
  },
});

// @benchsdk/runner@0.3.0 validates the older display shape before the
// platform's iterations defaults were added. Inject the new manifest section
// after that validation so it is serialized by the runner's existing
// `config.display` upload path.
type IterationDisplayConfig = NonNullable<typeof config.display> & {
  iterations: { defaultMetric: string };
};

if (config.display) {
  (config.display as IterationDisplayConfig).iterations = {
    defaultMetric: 'totalMs',
  };
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure, phase } = ctx;
  const p = participant;
  const mode: FsIoMode = (MODES as readonly string[]).includes(phase ?? '')
    ? (phase as FsIoMode)
    : 'default';

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? createTimeoutMs;
  const cleanupTimeout = p.destroyTimeoutMs ?? destroyTimeoutMs;

  let sandbox: FsIoSandbox | undefined;
  let workload: FsIoWorkloadResult | undefined;
  let createMs = 0;
  let destroyMs = 0;
  const rStart = performance.now();

  try {
    const createStart = performance.now();
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create(p.sandboxOptions),
        createTimeout,
        'Sandbox creation timed out',
        (s) => s.destroy(),
      ),
    );
    createMs = performance.now() - createStart;
    measure({ createMs, mode });

    workload = await step('fs-io', async () => {
      const result = await runFsIoWorkload(sandbox!, mode);
      // The platform sources its per-metric views from each step's data, so
      // the op timings have to be measured inside the step. A `measure`
      // call at task top-level lands on the task record instead and stays
      // invisible there.
      if (result.ok) {
        measure(opMetrics(result));
      }
      return result;
    });
  } catch (err) {
    // The runner records a thrown task error on the task record but writes
    // nothing to the worker log, so without this the platform's log panel
    // shows step lines and no reason the task died.
    log('fs-io task failed', {
      level: 'error',
      meta: {
        provider: p.name,
        mode,
        stage: sandbox ? 'fs-io' : 'create',
        error: formatError(err),
      },
    });
    throw err;
  } finally {
    if (sandbox) {
      const destroyStart = performance.now();
      await step(
        'destroy',
        () => withTimeout(sandbox!.destroy(), cleanupTimeout, 'Destroy timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      destroyMs = performance.now() - destroyStart;
      measure({ destroyMs });
    }
  }

  const wallClockMs = performance.now() - rStart;
  const opSteps = opStepsFrom(workload);

  if (!workload || !workload.ok) {
    const message = workload?.error ?? 'fs-io workload failed';
    log('fs-io workload failed', {
      level: 'error',
      meta: {
        provider: p.name,
        mode,
        reason: workload && !workload.ok ? workload.reason : 'unexpected',
        error: message,
        createMs,
        destroyMs,
      },
    });
    const data = workload
      ? ({
          ...workload,
          mode,
          createMs,
          destroyMs,
          replicateMs: [wallClockMs],
          wallClockMs,
          meta: { ...workload.meta, mode, createMs, destroyMs },
        } as unknown as JsonObject)
      : ({
          error: message,
          mode,
          createMs,
          destroyMs,
          replicateMs: [wallClockMs],
          wallClockMs,
        } as JsonObject);
    throw new TaskError(message, { code: 'fs_io_workload_failed', data, steps: opSteps });
  }

  // Task-level copy: `scoring` samples metrics from the task record's data,
  // so totalMs has to exist here too, alongside the step-scoped measure.
  measure({
    mode,
    verified: workload.meta.verified === true,
    ...opMetrics(workload),
    createMs,
    destroyMs,
  });

  log('fs-io workload completed', {
    level: 'info',
    meta: {
      provider: p.name,
      mode,
      totalMs: workload.metric.value,
      verified: workload.meta.verified === true,
      createMs,
      destroyMs,
    },
  });

  return {
    data: {
      ...workload,
      mode,
      verified: workload.meta.verified === true,
      ...opMetrics(workload),
      createMs,
      destroyMs,
      replicateMs: [wallClockMs],
      wallClockMs,
      meta: { ...workload.meta, mode, createMs, destroyMs },
    } as unknown as JsonObject,
    steps: opSteps,
    latencyMs: workload.metric.value,
  };
});

/** Flat metric map sampled off a successful WorkloadResult's meta. */
function opMetrics(workload: { metric: { value: number }; meta: Record<string, unknown> }): Record<string, number> {
  const out: Record<string, number> = { totalMs: workload.metric.value };
  for (const op of OPS) {
    const v = workload.meta[op.metricKey];
    if (typeof v === 'number' && Number.isFinite(v)) out[op.metricKey] = v;
  }
  for (const key of ['concurrentReadsQps', 'dbSizeMb', 'rowCount'] as const) {
    const v = workload.meta[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** Pre-measured per-operation steps for the platform's step views. */
function opStepsFrom(
  workload: FsIoWorkloadResult | undefined,
): { name: string; status: 'success'; latencyMs: number; data: Record<string, number> }[] {
  if (!workload || !workload.ok) return [];
  const steps: { name: string; status: 'success'; latencyMs: number; data: Record<string, number> }[] = [];
  for (const op of OPS) {
    const ms = workload.meta[op.metricKey];
    if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
    steps.push({
      name: op.stepKey,
      status: 'success',
      latencyMs: ms,
      data: { [op.metricKey]: ms },
    });
  }
  return steps;
}

export const beforeExit = () => drainLateCleanups();
