/**
 * Sandbox Burst TTI 1k: the public "Sandbox TTI (Burst)" benchmark at
 * 1000-way scale, with the whole fleet HELD concurrently. When BURST_COUNT
 * (default 1000) sandboxes are created in one burst, how fast does each come
 * up, and is the full fleet genuinely alive at the same time?
 *
 * Timed boundary (identical to the public sandbox-tti bench): TTI per box =
 * its sandbox.create() call start → its first command (`node -v`, exit 0)
 * completing. One probe, no retries.
 *
 * One iteration: burst_create (N concurrent creates + one probe each) →
 * idle_wait (hold every box, no commands) → liveness (one `echo alive` per
 * box, in parallel — every box is still up at once, so the fleet really was
 * concurrent) → destroy (all boxes, best-effort). A box that fails to create
 * or answer is recorded, not thrown — partial bursts are the signal.
 *
 * Per-box detail is aggregated (TTI percentiles + grouped error messages)
 * rather than written as tti<i>/error<i> keys: 1000 boxes × several keys
 * would bloat every step record and results file.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-burst-tti-1k.bench.ts --provider e2b --iterations 1
 *   BURST_COUNT=10 IDLE_MS=5000 pnpm bench benchmarks/stealth/sandbox/sandbox-burst-tti-1k.bench.ts --provider e2b --iterations 1 --no-ingest
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import {
  TTI_MEDIAN_CEILING_MS,
  TTI_P95_CEILING_MS,
  TTI_P99_CEILING_MS,
  writeBurstTti1kLegacyResults,
} from './sandbox-burst-tti-1k-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { noSurvivorsError, summarizeTti } from './burst-summary.js';
import { drainLateCleanups, trackLateCleanup, withTimeout } from '../src/util/timeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Wider than the public bench's 120s/30s: 1000 creates queue behind each
// other at the provider API, and a box that is merely slow should still count.
const createTimeoutMs = 300_000;
const commandTimeoutMs = 60_000;
const destroyTimeoutMs = 30_000;
// Deletes run in a bounded pool, not all 1000 at once: a synchronous delete
// API (e.g. createos) backs up under an unbounded wave exactly when its
// control plane is already saturated by the burst.
const destroyConcurrency = (() => {
  const parsed = Number(process.env.DESTROY_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 32;
})();
// Total budget for destroy+sweep. Each destroy attempt still times out at
// destroyTimeoutMs, but failures are retried until this deadline — a slow
// delete is retried instead of writing the box off as orphaned.
const destroyBudgetMs = (() => {
  const parsed = Number(process.env.DESTROY_BUDGET_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
})();

const DEFAULT_BURST_COUNT = 1000;
const DEFAULT_IDLE_MS = 60_000;
// 1000 is the point of the bench, so it is also the cap: smokes can go lower,
// but a typo'd dispatch can't launch (and risk orphaning) more than 1000 boxes.
const MAX_BURST_COUNT = 1000;

const READINESS_COMMAND = 'node -v';
const LIVENESS_COMMAND = 'echo alive';

/** Keep at most this many distinct error messages per iteration. */
const MAX_ERROR_GROUPS = 20;
/** Box indices kept per error group, for spot-checking. */
const MAX_ERROR_SAMPLE_BOXES = 5;


const burstCount = (() => {
  const parsed = Number(process.env.BURST_COUNT);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BURST_COUNT;
  return Math.min(Math.floor(parsed), MAX_BURST_COUNT);
})();

const idleMs = (() => {
  const parsed = Number(process.env.IDLE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_MS;
})();

interface BurstSandbox {
  sandboxId: string;
  runCommand(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  destroy(): Promise<unknown>;
}

interface Compute {
  sandbox: {
    create(options?: Record<string, any>): Promise<BurstSandbox>;
    list?(): Promise<any[]>;
    destroy?(instanceId: string): Promise<unknown>;
  };
}

interface ErrorGroup {
  step: string;
  error: string;
  count: number;
  boxes: number[];
}

export const config = defineBenchmarkConfig({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. sandbox-burst-tti-1k-stealth); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-burst-tti-1k',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Burst TTI 1k',
  // One iteration is already 1000 sandboxes per provider.
  iterations: 1,
  concurrency: 1,
  groupBy: 'round',
  // createos is parked: its synchronous create/delete control plane saturates
  // under a 1000-box wave. It stays in providers.ts for the rest of the suite.
  participants: providers.filter((p) => p.name !== 'createos'),
  scoring: {
    metrics: [
      // Survival first: the share of the 1000-box fleet that came up AND is
      // still answering after the hold. Speed splits the remaining 0.15 in the
      // public bench's median/p95/p99 proportions (0.60/0.25/0.15).
      { key: 'alivePct', unit: '%', ceiling: 100, higherIsBetter: true, weights: { median: 0.85, p95: 0, p99: 0 } },
      { key: 'ttiMedianMs', unit: 'ms', ceiling: TTI_MEDIAN_CEILING_MS, weights: { median: 0.09, p95: 0, p99: 0 } },
      { key: 'ttiP95Ms', unit: 'ms', ceiling: TTI_P95_CEILING_MS, weights: { median: 0.04, p95: 0, p99: 0 } },
      { key: 'ttiP99Ms', unit: 'ms', ceiling: TTI_P99_CEILING_MS, weights: { median: 0.02, p95: 0, p99: 0 } },
    ],
    // No requireData gate: alivePct penalizes lost boxes proportionally; a
    // burst with no survivor fails the iteration (noSurvivorsError).
  },
  display: {
    metrics: [
      { key: 'alivePct', label: 'Alive after hold', unit: '%', direction: 'higher-better', decimals: 1 },
      { key: 'readyPct', label: 'Ready in burst', unit: '%', direction: 'higher-better', decimals: 1 },
      { key: 'ttiMedianMs', label: 'TTI median', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'ttiP95Ms', label: 'TTI p95', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'ttiP99Ms', label: 'TTI p99', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'ttiMaxMs', label: 'TTI max', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'ttiMinMs', label: 'TTI min', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'burstCreateWallClockMs', label: 'Burst create', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'livenessMs', label: 'Liveness', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'wallClockMs', label: 'Wall clock', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'burst_create', label: 'Burst create + first command', order: 0 },
      { key: 'idle_wait', label: 'Hold fleet', order: 1 },
      { key: 'liveness', label: 'Fleet liveness check', order: 2 },
      { key: 'destroy', label: 'Destroy fleet', order: 3 },
      { key: 'sweep', label: 'Sweep strays', order: 4 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writeBurstTti1kLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/sandbox_burst_tti_1k'),
    }),
});

function groupErrors(entries: { step: string; box: number; error: string }[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const e of entries) {
    // Box indices inside messages ("box 17 create timed out") would make every
    // message unique; strip them so identical failures group together.
    const error = e.error.replace(/\bbox \d+\b/g, 'box N').slice(0, 300);
    const key = `${e.step}\u0000${error}`;
    const g = groups.get(key) ?? { step: e.step, error, count: 0, boxes: [] };
    g.count += 1;
    if (g.boxes.length < MAX_ERROR_SAMPLE_BOXES) g.boxes.push(e.box);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, MAX_ERROR_GROUPS);
}

function errorStepData(groups: ErrorGroup[]): Record<string, string | number> {
  const data: Record<string, string | number> = {};
  groups.forEach((g, i) => {
    data[`error${i}`] = `${g.count}x ${g.error}`;
  });
  return data;
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? createTimeoutMs;
  const cleanupTimeout = p.destroyTimeoutMs ?? destroyTimeoutMs;

  measure({ burstCount, idleMs });

  const boxes: (BurstSandbox | undefined)[] = new Array<BurstSandbox | undefined>(burstCount);
  const ttiMs: (number | undefined)[] = new Array<number | undefined>(burstCount);
  const alive: boolean[] = new Array<boolean>(burstCount).fill(false);
  const rawErrors: { step: string; box: number; error: string }[] = [];
  // Set once destroy starts: a create that resolves after its timeout is
  // destroyed on arrival instead of leaking past the run.
  let tearingDown = false;

  // Run-scoped name prefix: providers with `supportsCreateNameOption` get a
  // `name` per box, so the sweep can find (and delete) strays created by this
  // run even when create() errored or timed out client-side.
  const runTag = String(process.env.RUN_KEY ?? Date.now()).replace(/[^A-Za-z0-9-]/g, '-');
  const sweepPrefix = `tti1k-${runTag}-`;
  // Sail's default sandbox is 8 vCPU and counts against an account vCPU
  // quota, so each box in the burst takes its 1 vCPU size instead.
  const baseOptions = p.name === 'sail' ? { ...p.sandboxOptions, sizeClass: 'sm' } : p.sandboxOptions;
  const createOptions = (i: number): Record<string, any> | undefined =>
    p.supportsCreateNameOption ? { ...baseOptions, name: `${sweepPrefix}i${i}` } : baseOptions;

  let burstCreateWallClockMs = 0;
  let idleWaitMs = 0;
  let livenessMs = 0;
  let destroyMs = 0;
  const rStart = performance.now();

  // Iterate an index array, not `boxes.map` — `new Array(n)` is sparse and
  // Array.prototype.map skips holes.
  const indices = Array.from({ length: burstCount }, (_, i) => i);

  try {
    const burstStart = performance.now();
    await step('burst_create', async () => {
      const outcomes = await Promise.all(
        indices.map(async (i) => {
          const start = performance.now();
          const createPromise = compute.sandbox.create(createOptions(i));
          try {
            const box = await withTimeout(createPromise, createTimeout, `box ${i} create timed out`);
            boxes[i] = box;
            const probe = await withTimeout(
              box.runCommand(READINESS_COMMAND),
              commandTimeoutMs,
              `box ${i} first command timed out`,
            );
            if (probe.exitCode !== 0) {
              return {
                i,
                error: `first command exited ${probe.exitCode}: ${(probe.stderr ?? probe.stdout ?? '').trim().slice(0, 200)}`,
              };
            }
            ttiMs[i] = performance.now() - start;
            return { i, ttiMs: ttiMs[i] };
          } catch (err) {
            if (!boxes[i]) {
              // Timed out (or failed) before create resolved: adopt a late box
              // so it is held/destroyed with the fleet, never orphaned.
              trackLateCleanup(() =>
                createPromise.then((late) => {
                  if (tearingDown) {
                    return withTimeout(late.destroy(), cleanupTimeout, `box ${i} late destroy timed out`);
                  }
                  boxes[i] = late;
                }, () => {}),
              );
            }
            return { i, error: formatError(err) };
          }
        }),
      );
      const failures = outcomes.flatMap((o) => (o.error ? [{ step: 'burst_create', box: o.i, error: o.error }] : []));
      rawErrors.push(...failures);
      const measured = outcomes.filter((o) => o.ttiMs !== undefined).length;
      measure({ readyCount: measured, failedCount: failures.length, ...errorStepData(groupErrors(failures)) });
      return { readyCount: measured, failedCount: failures.length };
    });
    burstCreateWallClockMs = performance.now() - burstStart;

    const idleStart = performance.now();
    await step(
      'idle_wait',
      () => new Promise<void>((resolve) => setTimeout(resolve, idleMs)),
      { reportConcurrency: false },
    );
    idleWaitMs = performance.now() - idleStart;

    const livenessStart = performance.now();
    await step('liveness', async () => {
      const checks = await Promise.all(
        indices.map(async (i) => {
          const box = boxes[i];
          // A box adopted late (after its create timeout) never passed the
          // first-command probe, so it doesn't count toward the fleet.
          if (!box || ttiMs[i] === undefined) return { i, alive: false, error: undefined };
          try {
            const res = await withTimeout(
              box.runCommand(LIVENESS_COMMAND),
              commandTimeoutMs,
              `box ${i} liveness probe timed out`,
            );
            if (res.exitCode !== 0) return { i, alive: false, error: `liveness probe exited ${res.exitCode}` };
            return { i, alive: true, error: undefined };
          } catch (err) {
            return { i, alive: false, error: formatError(err) };
          }
        }),
      );
      const failures: { step: string; box: number; error: string }[] = [];
      for (const c of checks) {
        alive[c.i] = c.alive;
        if (c.error) failures.push({ step: 'liveness', box: c.i, error: c.error });
      }
      rawErrors.push(...failures);
      const aliveCount = checks.filter((c) => c.alive).length;
      measure({ aliveCount, lostCount: failures.length, ...errorStepData(groupErrors(failures)) });
      return { aliveCount, lostCount: failures.length };
    });
    livenessMs = performance.now() - livenessStart;
  } finally {
    tearingDown = true;
    const destroyStart = performance.now();
    const destroyDeadline = destroyStart + destroyBudgetMs;
    let destroyFailedCount = 0;
    let destroyRetryCount = 0;
    let sweptCount = 0;
    let sweepFailedCount = 0;

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const mapWithConcurrency = async <T>(items: T[], fn: (item: T) => Promise<void>) => {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(destroyConcurrency, items.length) }, async () => {
          while (next < items.length) await fn(items[next++]);
        }),
      );
    };

    // Retry each delete until the shared budget runs out. A timed-out attempt
    // doesn't cancel the in-flight request, but the provider may not have
    // honored it — a fresh DELETE each attempt is the only reliable signal.
    const destroyWithRetry = async (box: number, label: string, fn: () => Promise<unknown>) => {
      for (;;) {
        try {
          await withTimeout(fn(), cleanupTimeout, `${label} destroy timed out`);
          return true;
        } catch (err) {
          if (performance.now() >= destroyDeadline) {
            rawErrors.push({ step: 'destroy', box, error: formatError(err) });
            return false;
          }
          destroyRetryCount += 1;
          await sleep(500 + Math.floor(Math.random() * 1500));
        }
      }
    };

    await step(
      'destroy',
      () =>
        mapWithConcurrency(indices, async (i) => {
          const box = boxes[i];
          if (!box) return;
          if (!(await destroyWithRetry(i, `box ${i}`, () => box.destroy()))) destroyFailedCount += 1;
        }),
      { reportConcurrency: false },
    ).catch((err: unknown) =>
      log('destroy step failed', { level: 'warn', meta: { error: formatError(err) } }),
    );

    // Sweep: anything still listed under this run's name prefix is a stray —
    // typically a box whose create() timed out or errored client-side but was
    // provisioned provider-side anyway. Only run-tagged boxes are deleted.
    await step('sweep', async () => {
      const manager = compute.sandbox;
      if (!p.supportsCreateNameOption || typeof manager.list !== 'function') return { sweptCount: 0 };
      const listed = await withTimeout(manager.list(), 60_000, 'sweep list timed out');
      const strays = (listed as any[]).filter((e) => {
        const name = e?.instance?.name ?? e?.name;
        return typeof name === 'string' && name.startsWith(sweepPrefix);
      });
      await mapWithConcurrency(strays, async (entry: any) => {
        const inst = entry?.instance ?? entry;
        const id = entry?.instanceId ?? inst?.id;
        const label = `stray ${inst?.name ?? id ?? '?'}`;
        let ok = false;
        if (typeof inst?.destroy === 'function') {
          ok = await destroyWithRetry(-1, label, () => inst.destroy());
        } else if (id != null && typeof manager.destroy === 'function') {
          ok = await destroyWithRetry(-1, label, () => manager.destroy!(id));
        }
        if (ok) sweptCount += 1;
        else sweepFailedCount += 1;
      });
      return { sweptCount, sweepFailedCount };
    }, { reportConcurrency: false }).catch((err: unknown) =>
      log('sweep step failed', { level: 'warn', meta: { error: formatError(err) } }),
    );

    destroyMs = performance.now() - destroyStart;
    if (destroyFailedCount > 0 || sweepFailedCount > 0) {
      log(`${destroyFailedCount} box destroys failed, ${sweepFailedCount} sweeps failed`, {
        level: 'warn',
        meta: { errors: groupErrors(rawErrors.filter((e) => e.step === 'destroy')) as unknown as JsonObject[] },
      });
    }
    if (sweptCount > 0) {
      log(`sweep removed ${sweptCount} stray boxes tagged ${sweepPrefix}*`, { level: 'info' });
    }
    measure({ destroyMs, destroyFailedCount, destroyRetryCount, sweptCount, sweepFailedCount });
  }

  const tti = summarizeTti(ttiMs);
  const { readyCount } = tti;

  const createdCount = boxes.filter(Boolean).length;
  const aliveCount = alive.filter(Boolean).length;
  const pct = (n: number) => Math.round((n / burstCount) * 1000) / 10;
  const readyPct = pct(readyCount);
  const alivePct = pct(aliveCount);
  const allAlive = aliveCount === burstCount;
  const wallClockMs = performance.now() - rStart;
  const errors = groupErrors(rawErrors);

  measure({
    burstCount,
    idleMs,
    createdCount,
    ...tti,
    readyPct,
    burstCreateWallClockMs,
    idleWaitMs,
    aliveCount,
    alivePct,
    allAlive,
    livenessMs,
    wallClockMs,
  });

  log('burst-tti-1k iteration completed', {
    level: 'info',
    meta: { provider: p.name, burstCount, ...tti, aliveCount, alivePct, allAlive },
  });

  const data = {
    burstCount,
    idleMs,
    createdCount,
    ...tti,
    readyPct,
    burstCreateWallClockMs,
    idleWaitMs,
    aliveCount,
    alivePct,
    allAlive,
    livenessMs,
    destroyMs,
    wallClockMs,
    errors,
    replicateMs: [wallClockMs],
  } as unknown as JsonObject;
  const noSurvivors = noSurvivorsError(aliveCount, burstCount, data);
  if (noSurvivors) throw noSurvivors;
  return { data, latencyMs: tti.ttiP99Ms ?? wallClockMs };
});

export const beforeExit = () => drainLateCleanups();
