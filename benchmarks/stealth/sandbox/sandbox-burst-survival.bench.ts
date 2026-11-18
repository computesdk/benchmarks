/**
 * Sandbox Burst Survival: when BURST_COUNT sandboxes are created in one burst,
 * how fast does each come up (time to interactive), and are they still alive
 * after sitting idle for IDLE_MS — or does the provider kill/pause them
 * shortly after creation?
 *
 * Timed boundary (matches oci-tti): TTI per box = its sandbox.create() call
 * start → its readiness probe (`echo ready`, exit 0) completing. One probe,
 * no retries — create() resolving early is provider semantics, and the probe
 * is what makes them visible.
 *
 * One iteration: burst_create (N concurrent creates + probes) → idle_wait
 * (sleep, no commands) → liveness (one `echo alive` per box, in parallel)
 * → destroy (all boxes, best-effort). A box that fails to create or answer
 * is recorded per-box, not thrown — partial bursts are the signal.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-burst-survival.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-burst-survival.bench.ts --provider e2b --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import {
  DESTROY_CEILING_MS,
  TTI_MAX_CEILING_MS,
  TTI_MEDIAN_CEILING_MS,
  writeBurstSurvivalLegacyResults,
} from './sandbox-burst-survival-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import { noSurvivorsError, summarizeTti } from './burst-summary.js';
import { reciprocalScoring } from '../src/util/scoring.js';


const createTimeoutMs = 120_000;
const commandTimeoutMs = 30_000;
const destroyTimeoutMs = 15_000;

const DEFAULT_BURST_COUNT = 5;
const DEFAULT_IDLE_MS = 60_000;
const MAX_BURST_COUNT = 64;

const READINESS_COMMAND = 'echo ready';
const LIVENESS_COMMAND = 'echo alive';


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
  };
}

export const config = defineBenchmarkConfig({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. sandbox-burst-survival-stealth); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-burst-survival',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Burst Survival',
  iterations: 3,
  concurrency: 1,
  // Round-interleave participants so back-to-back iterations compare fairly.
  groupBy: 'round',
  participants: providers,
  scoring: reciprocalScoring({
    metrics: [
      // Survival first, speed as tiebreaker: a higher alivePct bucket always
      // outranks a lower one regardless of speed. With the default 5-box
      // burst alivePct moves in 20-point steps, and 20 * 0.85 = 17 exceeds
      // the maximum total speed contribution (0.15 * 100 = 15).
      { key: 'alivePct', unit: '%', ceiling: 100, higherIsBetter: true, weights: { median: 0.85, p95: 0, p99: 0 } },
      { key: 'ttiMaxMs', unit: 'ms', ceiling: TTI_MAX_CEILING_MS, weights: { median: 0.08, p95: 0, p99: 0 } },
      { key: 'ttiMedianMs', unit: 'ms', ceiling: TTI_MEDIAN_CEILING_MS, weights: { median: 0.05, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: DESTROY_CEILING_MS, weights: { median: 0.02, p95: 0, p99: 0 } },
    ],
    // No requireData gate: alivePct's 0.85 weight penalizes reaped boxes
    // proportionally — a provider that loses boxes lands far down the
    // ranking instead of being flattened to zero.
  }, ['ttiMaxMs', 'ttiMedianMs', 'destroyMs']),
  display: {
    metrics: [
      { key: 'ttiMaxMs', label: 'TTI max', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'ttiMedianMs', label: 'TTI median', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'ttiMinMs', label: 'TTI min', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'burstCreateWallClockMs', label: 'Burst create', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'alivePct', label: 'Alive after idle', unit: '%', direction: 'higher-better', decimals: 0 },
      { key: 'livenessMs', label: 'Liveness', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'wallClockMs', label: 'Wall clock', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'burst_create', label: 'Burst create + probes', order: 0 },
      { key: 'idle_wait', label: 'Idle wait', order: 1 },
      { key: 'liveness', label: 'Liveness check', order: 2 },
      { key: 'destroy', label: 'Destroy boxes', order: 3 },
    ],
    overview: { defaultMetric: 'alivePct', defaultLayout: 'ranking' },
  },
  onComplete: (outcome): void =>
    writeBurstSurvivalLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('sandbox_burst_survival'),
      scoring: config.scoring,
    }),
});

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
  // Per-box failures also land in the returned data as `errors` — stepData's
  // errorN keys never reach results files, which leaves a dry run's
  // artifacts unable to explain a failed leg.
  const errors: { step: string; box: number; error: string }[] = [];

  let burstCreateWallClockMs = 0;
  let idleWaitMs = 0;
  let livenessMs = 0;
  let destroyMs = 0;
  const rStart = performance.now();

  // Iterate an index array, not `boxes.map` — `new Array(n)` is sparse and
  // Array.prototype.map skips holes, which would silently drop uncreated
  // indices.
  const indices = Array.from({ length: burstCount }, (_, i) => i);

  try {
    const burstStart = performance.now();
    await step('burst_create', async () => {
      const outcomes = await Promise.all(
        indices.map(async (i) => {
          const start = performance.now();
          try {
            const box = await withTimeout(
              compute.sandbox.create(p.sandboxOptions),
              createTimeout,
              `box ${i} create timed out`,
              (s) => s.destroy(),
            );
            boxes[i] = box;
            const probe = await withTimeout(
              box.runCommand(READINESS_COMMAND),
              commandTimeoutMs,
              `box ${i} readiness probe timed out`,
            );
            if (probe.exitCode !== 0) {
              return {
                i,
                error: `readiness probe exited ${probe.exitCode}: ${(probe.stderr ?? probe.stdout ?? '').trim().slice(0, 200)}`,
              };
            }
            ttiMs[i] = performance.now() - start;
            return { i, ttiMs: ttiMs[i] };
          } catch (err) {
            return { i, error: formatError(err) };
          }
        }),
      );
      const stepData: Record<string, string | number | boolean> = {};
      for (const o of outcomes) {
        stepData[`ready${o.i}`] = o.ttiMs !== undefined;
        if (o.ttiMs !== undefined) stepData[`tti${o.i}Ms`] = Math.round(o.ttiMs);
        if (o.error) {
          stepData[`error${o.i}`] = o.error;
          errors.push({ step: 'burst_create', box: o.i, error: o.error });
        }
      }
      measure(stepData);
      return outcomes;
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
          if (!box) return { i, alive: false, ms: 0, error: 'box was never created' };
          const start = performance.now();
          try {
            const res = await withTimeout(
              box.runCommand(LIVENESS_COMMAND),
              commandTimeoutMs,
              `box ${i} liveness probe timed out`,
            );
            const ok = res.exitCode === 0;
            if (!ok) {
              return { i, alive: false, ms: performance.now() - start, error: `liveness probe exited ${res.exitCode}` };
            }
            return { i, alive: true, ms: performance.now() - start };
          } catch (err) {
            return { i, alive: false, ms: performance.now() - start, error: formatError(err) };
          }
        }),
      );
      const stepData: Record<string, string | number | boolean> = {};
      for (const c of checks) {
        alive[c.i] = c.alive;
        stepData[`alive${c.i}`] = c.alive;
        stepData[`alive${c.i}Ms`] = Math.round(c.ms);
        if (c.error) {
          stepData[`error${c.i}`] = c.error;
          errors.push({ step: 'liveness', box: c.i, error: c.error });
        }
      }
      measure(stepData);
      return checks;
    });
    livenessMs = performance.now() - livenessStart;
  } finally {
    const destroyStart = performance.now();
    await step(
      'destroy',
      () =>
        Promise.all(
          indices.map(async (i) => {
            const box = boxes[i];
            if (!box) return;
            await withTimeout(box.destroy(), cleanupTimeout, `box ${i} destroy timed out`).catch(
              (err: unknown) =>
                log(`box ${i} destroy failed`, { level: 'warn', meta: { error: formatError(err) } }),
            );
          }),
        ),
      { reportConcurrency: false },
    ).catch((err: unknown) =>
      log('destroy step failed', { level: 'warn', meta: { error: formatError(err) } }),
    );
    destroyMs = performance.now() - destroyStart;
    measure({ destroyMs });
  }

  const tti = summarizeTti(ttiMs);
  const { readyCount } = tti;

  const createdCount = boxes.filter(Boolean).length;
  const aliveCount = alive.filter(Boolean).length;
  const alivePct = (aliveCount / burstCount) * 100;
  const allAlive = aliveCount === burstCount;
  const wallClockMs = performance.now() - rStart;

  measure({
    burstCount,
    idleMs,
    createdCount,
    ...tti,
    burstCreateWallClockMs,
    idleWaitMs,
    aliveCount,
    alivePct,
    allAlive,
    livenessMs,
    wallClockMs,
  });

  log('burst-survival iteration completed', {
    level: 'info',
    meta: { provider: p.name, burstCount, ...tti, aliveCount, alivePct, allAlive },
  });

  const data = {
    burstCount,
    idleMs,
    createdCount,
    ...tti,
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
  return { data, latencyMs: tti.ttiMaxMs ?? wallClockMs };
});

export const beforeExit = () => drainLateCleanups();
