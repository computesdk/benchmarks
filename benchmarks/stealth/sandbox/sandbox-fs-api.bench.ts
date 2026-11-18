/**
 * Sandbox Filesystem API Throughput benchmark: ONE sandbox per provider runs `iterations`
 * rounds of file-size tests — each task is a single write/read/verify/
 * delete test of one size, interleaved round-robin (task N tests
 * fileSizes[N % count]), so the default 4 rounds → 20 records in a
 * single sandbox. One record per test means the platform success rate IS
 * the completion rate. Declarative — exports `config` + `task`; `bench
 * run` owns the entrypoint. The custom `--file-size` and `--rounds` flags
 * are scanned from argv here (declared in `customCliFlags` so the runner
 * lets them through); `--rounds` is rounds per size, while the runner's
 * `--iterations` flag stays a raw total-task override.
 *
 *   bench run sandbox-fs-api.bench.ts
 *   bench run sandbox-fs-api.bench.ts --rounds 1 --provider e2b
 *   bench run sandbox-fs-api.bench.ts --file-size 1m,16m --provider e2b
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import { continuousScoring } from './performance-runtime-scoring.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '@benchsdk/client';
import type { TaskResultRecord } from '@benchsdk/client';
import {
  defineBenchmarkConfig,
  defineTask,
  TaskError,
  type BenchmarkRunOutcome,
  type BenchmarkScoringConfig,
  type ParticipantRecords,
  type TaskContext,
} from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { SIZE_SWEEP, scoreRoundTripMs } from './sandbox-fs-api.js';
import type { SweepSize } from './sandbox-fs-api.js';
import { performanceFsApiRankScore } from './performance-scoring.js';
import { writeSandboxFilesystemLegacyResults } from './sandbox-fs-api-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const createTimeoutMs = 120_000;
const destroyTimeoutMs = 15_000;

// --file-size and --rounds are declared in `customCliFlags` so the runner
// lets them through, and we parse them ourselves from process.argv;
// --file-size accepts a comma-separated subset of sizes. The runner's
// --iterations flag means TOTAL tasks (it overrides config.iterations), so
// we read it too — both for the actual scheduled task count and so the last
// task knows when to destroy the shared sandbox.
const args = process.argv.slice(2);
function getArgValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
function getArgValues(argv: string[], flag: string): string[] | undefined {
  const raw = getArgValue(argv, flag);
  if (raw === undefined) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return values.length > 0 ? values : [raw];
}

const fileSizeArgs = getArgValues(args, '--file-size') ?? SIZE_SWEEP.map((s) => s.label);
const fileSizes = fileSizeArgs.map((arg) => {
  const size = SIZE_SWEEP.find((s) => s.label === arg.toLowerCase());
  if (!size) {
    const valid = SIZE_SWEEP.map((s) => s.label).join(', ');
    console.error(`Invalid --file-size "${arg}". Valid sizes: ${valid}`);
    process.exit(1);
  }
  return size;
});
// Two knobs resolve to the scheduled task count:
//   --rounds N   (custom flag) → N tests per size → N × sizes tasks.
//   --iterations N (runner flag) → N total tasks, overriding --rounds.
const DEFAULT_ROUNDS = 4;
const roundsArg = getArgValue(args, '--rounds');
const iterationsArg = getArgValue(args, '--iterations');
const rounds = roundsArg === undefined
  ? (iterationsArg === undefined ? DEFAULT_ROUNDS : Math.ceil(Number(iterationsArg) / fileSizes.length))
  : Number(roundsArg);
if (!Number.isInteger(rounds) || rounds < 1) {
  console.error(`Invalid --rounds "${roundsArg}". Expected a positive integer.`);
  process.exit(1);
}
const scheduledTasks = iterationsArg === undefined ? rounds * fileSizes.length : Number(iterationsArg);
if (!Number.isInteger(scheduledTasks) || scheduledTasks < 1) {
  console.error(`Invalid --iterations "${iterationsArg}". Expected a positive integer.`);
  process.exit(1);
}
if (scheduledTasks < fileSizes.length) {
  console.warn(`[bench] only ${scheduledTasks} task(s) for ${fileSizes.length} sizes — sizes after index ${scheduledTasks - 1} (${fileSizes.slice(scheduledTasks).map((s) => s.label).join(', ')}) will not run`);
}

/** Per-call write/read timeout scales with payload size (base64 wire cost ~1.33x). */
function ioTimeoutMs(bytes: number): number {
  return Math.min(300_000, Math.max(30_000, (bytes / (0.25 * 1024 * 1024)) * 1000));
}

interface SandboxFilesystemSandbox {
  sandboxId: string;
  filesystem?: {
    mkdir(path: string): Promise<void>;
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
  };
  destroy(): Promise<unknown>;
}

interface Compute {
  sandbox: {
    create(options?: Record<string, any>): Promise<SandboxFilesystemSandbox>;
  };
}

/**
 * Provider SDKs can leak errors outside the promise chain — e.g.
 * @northflank/js-client emits a ZlibError on an internal stream during its
 * tar-based file copy — which lands as an uncaughtException and kills the
 * whole run. Route them into the active task so they fail one iteration
 * (recorded as sdkAsyncError*) instead of crashing the benchmark.
 */
interface AsyncSdkError {
  message: string;
  source: 'uncaughtException' | 'unhandledRejection';
  stage: string;
}
let activeTaskErrorSink: ((message: string, source: AsyncSdkError['source']) => void) | undefined;

process.on('uncaughtException', (err) => {
  if (activeTaskErrorSink) activeTaskErrorSink(formatError(err), 'uncaughtException');
  else console.error('[bench] uncaughtException outside task scope:', err);
});
process.on('unhandledRejection', (reason) => {
  if (activeTaskErrorSink) activeTaskErrorSink(formatError(reason), 'unhandledRejection');
  else console.error('[bench] unhandledRejection outside task scope:', reason);
});

// One record = one file-size test (write/read/verify/delete) inside the
// provider's shared sandbox, so the platform's success rate IS the
// completion rate: a provider that can only do 40 KiB files shows ~20%
// success. The composite ranks everyone on one metric: rankScore is the
// completion tier (0-80) while a provider hasn't demonstrated every size,
// and 100 + full-sweep speed once it has — completers always outrank
// non-completers, non-completers order by how far they got, and the
// successRate multiplier still discounts unreliability either way.
// createMs/destroyMs are reported at zero weight: they fail or pass a
// task, they don't shape its score.
const scoringMetrics: BenchmarkScoringConfig['metrics'] = [
  // rankScore is cumulative (each record reports sweep progress so far, and
  // the post-completion 100+sweepScore), so score the p99 — the value near the
  // end of the sweep — not the median, which lands mid-sweep and makes a
  // 1-round run score far below a 4-round run of identical performance.
  { key: 'rankScore', label: 'Rank score', unit: 'score', ceiling: 200, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 1 } },
  // Preserve a continuous candidate for offline review without changing v1.
  { key: 'performanceRankScoreV2', label: 'Candidate rank score', unit: 'score', ceiling: 200, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  // Displayed at zero weight — the pure full-sweep speed number.
  { key: 'sweepScore', label: 'Speed', unit: 'score', ceiling: 100, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  // Declared at weight 0 so the platform aggregates/displays them without
  // affecting the composite.
  { key: 'sweepCompletion', label: 'Completion', unit: '%', ceiling: 100, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'sweepRtMs', label: 'Sweep round trip', unit: 'ms', ceiling: 600_000, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'sizeScore', label: 'Size score', unit: 'score', ceiling: 100, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'rtMs', label: 'Round trip', unit: 'ms', ceiling: 600_000, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'writeMs', label: 'Write', unit: 'ms', ceiling: 600_000, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'readMs', label: 'Read', unit: 'ms', ceiling: 600_000, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'deleteMs', label: 'Delete', unit: 'ms', ceiling: 600_000, weights: { median: 0, p95: 0, p99: 0 } },
];

const baseConfig = {
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-fs-api',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Filesystem API Throughput',
  concurrency: 1,
  // One sandbox per provider; tasks are single file-size tests interleaved
  // across sizes (task N tests fileSizes[N % len]), so `rounds` rounds per
  // size → rounds * sizes tasks in one sandbox (4 → 20 tests).
  iterations: scheduledTasks,
  participants: providers,
  // Run-level sizing context surfaced in the platform run config.
  dimensions: {
    iterations: String(rounds),
    tasks: String(scheduledTasks),
    file_sizes: fileSizes.map((s) => s.label).join(','),
  },
  customCliFlags: ['--file-size', '--rounds'],
  display: {
    metrics: [
      { key: 'rankScore', label: 'Rank score', unit: 'score', direction: 'higher-better' as const, decimals: 1 },
      { key: 'sweepScore', label: 'Speed', unit: 'score', direction: 'higher-better' as const, decimals: 1 },
      { key: 'sweepCompletion', label: 'Completion', unit: '%', direction: 'higher-better' as const, decimals: 0 },
      { key: 'sizeScore', label: 'Size score', unit: 'score', direction: 'higher-better' as const, decimals: 1 },
      { key: 'rtMs', label: 'Round trip', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'writeMs', label: 'Write', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'readMs', label: 'Read', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'deleteMs', label: 'Delete', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
    ],
    steps: [
      ...fileSizes.map((size) => ({ key: stepKey(size), label: `${stepLabel(size)} files` })),
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' as const },
  },
  scoring: continuousScoring({
    // One test = one record = one pass/fail, so the platform success rate
    // IS the completion rate — a provider that can only do small files
    // shows its fraction, not 100%.
    success: { requireData: { verified: true } },
    metrics: scoringMetrics,
  }),
};

/**
 * Step naming: `stepKey` is the stable key the platform keys columns on;
 * `stepLabel` is the display name ("40k files", "1mb files", ...).
 */
function stepKey(size: SweepSize): string {
  return `files-${size.label}`;
}
function stepLabel(size: SweepSize): string {
  return size.label === '40k' ? '40k' : `${size.label}b`;
}

/**
 * Records are natively per-size: each task is one write/read/verify/delete
 * test of one size, so the legacy per-size results tree just filters on
 * `file_size` — no expansion needed.
 */
async function writeSizeResults(
  outcome: BenchmarkRunOutcome,
  sizeLabel: string,
): Promise<void> {
  const participants: ParticipantRecords[] = outcome.participants.map((p) => ({
    ...p,
    records: p.records.filter(
      (r) => (r.data as { file_size?: string } | undefined)?.file_size === sizeLabel,
    ),
  }));
  await writeSandboxFilesystemLegacyResults(participants, {
    // Repo-root results tree (the collect job merges artifacts from
    // `results/` and commits back to it); __dirname is benchmarks/stealth/sandbox.
    resultsDir: benchmarkResultsDir(`sandbox_fs_api/${sizeLabel}`),
  });
}

export const config = defineBenchmarkConfig({
  ...baseConfig,
  // The legacy results tree is one directory per size, so a run expands its
  // flat sweep records back out into per-size records and writes each size's
  // directory as the old per-size phases did.
  onComplete: async (outcome: BenchmarkRunOutcome) => {
    for (const size of fileSizes) {
      await writeSizeResults(outcome, size.label);
    }
    // Backstop: destroy any shared sandboxes left over from a run cut short.
    const cleanupErrors: unknown[] = [];
    for (const [provider, shared] of sharedSandboxes) {
      try {
        await destroySandbox(shared.sandbox, shared.cleanupTimeout, (message, opts) => {
          console.log(`[${provider}] ${message}`, opts?.meta);
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    sharedSandboxes.clear();
    providerDone.clear();
    providerLastRt.clear();
    providerFailStreak.clear();
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Sandbox cleanup failed');
  },
});

/**
 * One sandbox per provider, shared across that provider's tasks: the first
 * task creates and probes it, every task runs a single file-size test
 * inside it (sizes interleaved round-robin by taskIndex), and the last
 * task destroys it. A sandbox that fails is dropped from the cache — the
 * task that hit the failure still records it, and the next task creates a
 * fresh sandbox.
 */
const sharedSandboxes = new Map<string, { sandbox: SandboxFilesystemSandbox; baseDir: string; cleanupTimeout: number }>();

// Provider-level cumulative state across that provider's tasks — used to
// gate the composite on demonstrated capability and to stop paying timeout
// cost for a size that reliably fails.
const providerDone = new Map<string, Set<string>>();
const providerLastRt = new Map<string, Map<string, number>>();
const providerFailStreak = new Map<string, Map<string, number>>();

// After this many consecutive failures at a size, later tasks at that size
// fail fast instead of paying the full io timeout — still a failed record,
// just without burning minutes on a known ceiling.
const MAX_CONSEC_FAILURES = 3;
const totalTasks = scheduledTasks;
const largestSize = fileSizes[fileSizes.length - 1]!;
const sweepTargetMs = fileSizes.reduce((a, size) => a + size.targetMs, 0);

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure, taskIndex } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? createTimeoutMs;
  const cleanupTimeout = p.destroyTimeoutMs ?? destroyTimeoutMs;

  const size = fileSizes[taskIndex % fileSizes.length]!;
  const label = size.label;

  let failedStage = 'create';
  let destroyMs = 0;
  let failure: { stage: string; message: string } | undefined;
  const meta: Record<string, number | string | boolean> = {
    taskIndex,
    file_size: label,
    fileSizeBytes: size.bytes,
  };
  const asyncErrors: AsyncSdkError[] = [];
  const rStart = performance.now();
  measure({ taskIndex, file_size: label, fileSizeBytes: size.bytes });

  activeTaskErrorSink = (message, source) => {
    asyncErrors.push({ message, source, stage: failedStage });
    console.error(`[${p.name}] async provider-SDK error during ${failedStage} (${source}): ${message}`);
  };

  let shared = sharedSandboxes.get(p.name);

  try {
    if (!shared) {
      const createStart = performance.now();
      // Not a step(): the platform renders every step record, and create/
      // probe/destroy are intentionally not displayed — their timings still
      // land in record data on the tasks where they happen.
      const sandbox = await withTimeout(
        compute.sandbox.create(p.sandboxOptions),
        createTimeout,
        'Sandbox creation timed out',
        async (s) => {
          log('late sandbox created', { meta: { sandboxId: s.sandboxId } });
          await destroySandbox(s, cleanupTimeout, log);
        },
      );
      meta.createMs = performance.now() - createStart;
      // A relative dir, not an absolute path: the provider's fs API
      // resolves it against its own default root (home dir or workspace),
      // which is the path a developer's code actually gets — and lets
      // fs-API-scoped providers (cloudflare, tenki) run the sweep in their
      // canonical root instead of failing the probe on a foreign path.
      shared = { sandbox, baseDir: path.posix.join(p.snapshotWorkdir ?? '', `bench/fs-${p.name}`), cleanupTimeout };
      sharedSandboxes.set(p.name, shared);
      log('sandbox created', { meta: { sandboxId: sandbox.sandboxId, createMs: meta.createMs } });
    }
    meta.sandboxId = shared.sandbox.sandboxId;

    failedStage = 'probe';
    await withTimeout(probeSandbox(shared.sandbox, shared.baseDir), 60_000, 'probe timed out');
    const fs = shared.sandbox.filesystem!;

    // Consecutive-failure breaker: a size that keeps failing would just
    // burn its io timeout on every remaining task — fail the record fast
    // instead. Semantics unchanged: it still counts as a failure.
    const streaks = providerFailStreak.get(p.name) ?? new Map<string, number>();
    providerFailStreak.set(p.name, streaks);
    if ((streaks.get(label) ?? 0) >= MAX_CONSEC_FAILURES) {
      failedStage = `write-${label}`;
      throw new Error(`io_failed: skipped — ${MAX_CONSEC_FAILURES} consecutive failures at ${label}`);
    }

    failedStage = `write-${label}`;
    let writeMs = 0;
    let readMs = 0;
    let deleteMs = 0;

    // One named step per task: this task's file-size test.
    await step(stepKey(size), async () => {
      const filePath = `${shared!.baseDir}/sweep-${label}-t${taskIndex}.bin.b64`;
      let content = crypto.randomBytes(size.bytes).toString('base64');
      const sha = crypto.createHash('sha256').update(content).digest('hex');

      const writeStart = performance.now();
      await withTimeout(fs.writeFile(filePath, content), ioTimeoutMs(size.bytes), 'write timed out');
      writeMs = performance.now() - writeStart;
      content = '';

      failedStage = `read-${label}`;
      const readStart = performance.now();
      const back = await withTimeout(fs.readFile(filePath), ioTimeoutMs(size.bytes), 'read timed out');
      const verifiedRep = crypto.createHash('sha256').update(back).digest('hex') === sha;
      readMs = performance.now() - readStart;
      if (!verifiedRep) {
        throw new Error('verify_mismatch: read-back content hash mismatch');
      }

      failedStage = `delete-${label}`;
      const deleteStart = performance.now();
      await withTimeout(fs.remove(filePath), ioTimeoutMs(size.bytes), 'delete timed out');
      deleteMs = performance.now() - deleteStart;
    });

    const rtMs = writeMs + readMs + deleteMs;
    meta.writeMs = writeMs;
    meta.readMs = readMs;
    meta.deleteMs = deleteMs;
    meta.rtMs = rtMs;
    meta.sizeScore = scoreRoundTripMs(label, rtMs);
    meta.repsCompleted = 1;
    meta.verified = true;
    streaks.set(label, 0);

    // Cumulative provider progress — the composite gate needs to know
    // whether the provider has demonstrated every configured size.
    const done = providerDone.get(p.name) ?? new Set<string>();
    done.add(label);
    providerDone.set(p.name, done);
    const lastRt = providerLastRt.get(p.name) ?? new Map<string, number>();
    lastRt.set(label, rtMs);
    providerLastRt.set(p.name, lastRt);
    meta.completedSizes = done.size;
    meta.sweepCompletion = (done.size / fileSizes.length) * 100;

    // rankScore orders everyone on one axis: completion tier (0-80) while
    // any configured size is undemonstrated, then 100 + full-sweep speed —
    // completers always rank above non-completers, and non-completers
    // order by how much of the sweep they've shown.
    if (done.size === fileSizes.length) {
      const sweepRtMs = fileSizes.reduce((a, fs) => a + (lastRt.get(fs.label) ?? 0), 0);
      meta.sweepRtMs = sweepRtMs;
      meta.sweepScore = 100 / (1 + sweepRtMs / sweepTargetMs);
      meta.rankScore = 100 + meta.sweepScore;
    } else {
      meta.rankScore = meta.sweepCompletion;
      if (size === largestSize) meta.sweepScore = 0;
    }
    meta.sweepTargetMs = sweepTargetMs;
    const candidateRank = performanceFsApiRankScore(done.size, fileSizes.length,
      typeof meta.sweepRtMs === 'number' ? meta.sweepRtMs : undefined, sweepTargetMs);
    if (candidateRank === undefined) throw new TaskError('invalid filesystem rank evidence', { code: 'invalid_rank_evidence' });
    meta.rankScore = candidateRank;
    meta.performanceRankScoreV2 = candidateRank;
    measure({ ...meta });
  } catch (err) {
    const errorMessage = formatError(err);
    console.error(`[${p.name}] sandbox-fs-api task ${taskIndex} (${label}) failed at ${failedStage}: ${errorMessage}`);
    failure = { stage: failedStage, message: errorMessage };
    meta.failedStage = failedStage;
    meta.errorMessage = errorMessage;
    if (/verify|mismatch/i.test(errorMessage)) meta.verified = false;
    // Track consecutive failures at this size for the fast-fail breaker,
    // and record the provider's cumulative completion for the record.
    const streaks = providerFailStreak.get(p.name) ?? new Map<string, number>();
    providerFailStreak.set(p.name, streaks);
    if (/^(write|read|delete)-/.test(failedStage)) {
      streaks.set(label, (streaks.get(label) ?? 0) + 1);
    }
    meta.completedSizes = providerDone.get(p.name)?.size ?? 0;
    meta.sweepCompletion = ((meta.completedSizes as number) / fileSizes.length) * 100;
    meta.sweepScore = 0;
    meta.rankScore = meta.sweepCompletion;
    // The shared sandbox may be dead or poisoned — drop it so the next task
    // recreates. The failure still lands on this record.
    sharedSandboxes.delete(p.name);
    if (shared) {
      const destroyStart = performance.now();
      try {
        await destroySandbox(shared.sandbox, cleanupTimeout, log);
      } catch (error) {
        meta.destroyFailed = true;
        meta.destroyError = formatError(error);
      }
      meta.destroyMs = performance.now() - destroyStart;
    }
    measure({ ...meta });
  } finally {
    // The last task destroys the shared sandbox (onComplete is the backstop
    // for runs cut short). A sandbox dropped on failure is already gone.
    const live = sharedSandboxes.get(p.name);
    if (taskIndex === totalTasks - 1 && live) {
      const destroyStart = performance.now();
      try {
        await destroySandbox(live.sandbox, cleanupTimeout, log);
      } catch (err) {
        meta.destroyFailed = true;
        meta.destroyError = formatError(err);
      }
      destroyMs = performance.now() - destroyStart;
      meta.destroyMs = destroyMs;
      sharedSandboxes.delete(p.name);
      measure({ destroyMs, destroyFailed: meta.destroyFailed === true });
    }
    activeTaskErrorSink = undefined;
  }

  const wallClockMs = performance.now() - rStart;
  meta.wallClockMs = wallClockMs;
  measure({ wallClockMs });

  // An async error leaked out of the provider SDK mid-task corrupts whatever
  // follows it — record it and fail the iteration even if later steps ran.
  if (asyncErrors.length > 0) {
    meta.sdkAsyncErrorCount = asyncErrors.length;
    meta.sdkAsyncError = asyncErrors
      .map((e) => `${e.source} at ${e.stage}: ${e.message}`)
      .join('; ')
      .slice(0, 500);
  }

  const out: JsonObject = Object.fromEntries(
    Object.entries({
      provider: p.name,
      baseDir: shared?.baseDir,
      taskIndex,
      sizes: fileSizes.map((s) => s.label).join(','),
      ...meta,
      wallClockMs,
    }).filter(([, v]) => v !== undefined),
  ) as JsonObject;

  // A sandbox that cannot be torn down is a failed iteration, and so is one
  // whose SDK crashed asynchronously — but the workload timings still get
  // reported alongside the failure.
  if (failure || meta.destroyFailed || asyncErrors.length > 0) {
    const stage = failure?.stage ?? (meta.destroyFailed ? 'destroy' : asyncErrors[0]!.stage);
    const message =
      failure?.message ??
      (meta.destroyFailed
        ? String(meta.destroyError)
        : `provider SDK async error: ${asyncErrors[0]!.message}`);
    throw new TaskError(`sandbox-fs-api workload failed at ${stage}: ${message}`, {
      code: 'sandbox_fs_api_workload_failed',
      data: { ...out, replicateMs: [wallClockMs], failedStage: stage, errorMessage: message } as unknown as JsonObject,
    });
  }

  log('sandbox-fs-api task completed', { level: 'info', meta: out });

  return {
    data: { ...out, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: typeof meta.rtMs === 'number' ? meta.rtMs : wallClockMs,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function destroySandbox(
  sandbox: SandboxFilesystemSandbox,
  timeoutMs: number,
  log: TaskContext<ProviderConfig>['log'],
): Promise<void> {
  const meta = { sandboxId: sandbox.sandboxId };
  log('destroying sandbox', { meta });
  try {
    await withTimeout(sandbox.destroy(), timeoutMs, 'Destroy timeout');
    log('sandbox destroy returned', { meta });
  } catch (error) {
    log('destroy failed', { level: 'warn', meta: { ...meta, error: formatError(error) } });
    throw error;
  }
}

/**
 * Capability gate: the sweep needs a filesystem API and a write/read
 * round-trip. Fails fast with a named reason so a provider shows *why* it
 * scored zero instead of a bare error.
 */
async function probeSandbox(sandbox: SandboxFilesystemSandbox, baseDir: string): Promise<void> {
  if (!sandbox.filesystem) {
    throw new Error('fs_unsupported: sandbox.filesystem is not implemented');
  }
  if (typeof sandbox.filesystem.remove !== 'function') {
    throw new Error('fs_remove_unsupported: sandbox.filesystem.remove is not implemented');
  }
  await sandbox.filesystem.mkdir(baseDir);
  const probeFile = `${baseDir}/.probe`;
  await sandbox.filesystem.writeFile(probeFile, 'probe');
  const readBack = await sandbox.filesystem.readFile(probeFile);
  if (readBack !== 'probe') {
    throw new Error('fs_roundtrip_failed: probe write/read mismatch');
  }
}

export const beforeExit = () => drainLateCleanups();
