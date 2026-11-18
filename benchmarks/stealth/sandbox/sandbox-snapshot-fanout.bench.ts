/**
 * Snapshot-fanout benchmark: once a snapshot exists, how fast and how
 * reliably can a provider stamp out N concurrent clones from it?
 *
 * Each iteration creates a sandbox, writes a marker file, snapshots it,
 * destroys the source box (so restores exercise the snapshot artifact
 * alone), then launches FANOUT_COUNT sandboxes concurrently from the
 * snapshot — each restore timed individually — and verifies the marker on
 * every clone. The gate is strict: an iteration passes only when every
 * clone launches and verifies; providers that pass are ranked by speed.
 * `fanoutSuccessRate` is recorded for observability but unscored.
 *
 * Downtime model: same as sandbox-snapshot — the source is destroyed before
 * restore. Providers whose snapshot id IS the source sandbox id
 * (pause/hibernate models) fail: pause + resume is not create + restore.
 *
 * Providers without snapshot support are recorded as unsupported but still
 * contribute creation and destroy timings.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-snapshot-fanout.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-snapshot-fanout.bench.ts --provider e2b --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import path from 'node:path';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { reciprocalScoring } from '../src/util/scoring.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import {
  DEFAULT_FANOUT_COUNT,
  SNAPSHOT_FANOUT_CEILINGS_MS,
  SUITE_CONFIG,
  writeSnapshotFanoutLegacyResults,
} from './sandbox-snapshot-fanout.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import {
  CREATE_TIMEOUT_MS,
  DESTROY_TIMEOUT_MS,
  buildExpectedFiles,
  buildRestoreOptions,
  newRunId,
  populateFilesystem,
  resolveSnapshotDir,
  SNAPSHOT_READY_TIMEOUT_MS,
  snapshotCapabilityMeta,
  snapshotSource,
  checkSourceIntact,
  SOURCE_STOPPED_CODE,
  startSourceHeartbeat,
  type SourceHeartbeat,
  waitForSnapshotReady,
  withSnapshotCreateOptions,
  type SnapshotDirSource,
  verifyFiles,
  type Compute,
  type FileExpectation,
  type SnapshotSandbox,
  type VerifyOutcome,
} from '../src/util/snapshot.js';


function resolveFanoutCount(): number {
  const parsed = Number(process.env.BENCH_FANOUT_COUNT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FANOUT_COUNT;
}

export const config = defineBenchmarkConfig<ProviderConfig>({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. sandbox-snapshot-fanout-stealth); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-snapshot-fanout',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Snapshot Fanout',
  iterations: SUITE_CONFIG.defaultIterations,
  concurrency: 1,
  groupBy: 'round',
  participants: providers,
  scoring: reciprocalScoring({
    metrics: [
      { key: 'createMs', unit: 'ms', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.createMs, weights: { median: 0.05, p95: 0, p99: 0 } },
      { key: 'snapshotCreateMs', unit: 'ms', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.snapshotCreateMs, weights: { median: 0.2, p95: 0, p99: 0 } },
      { key: 'restoreMaxMs', unit: 'ms', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.restoreMaxMs, weights: { median: 0.35, p95: 0, p99: 0 } },
      { key: 'fanoutWallClockMs', unit: 'ms', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.fanoutWallClockMs, weights: { median: 0.3, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.destroyMs, weights: { median: 0.1, p95: 0, p99: 0 } },
    ],
    // The gate is strict — an iteration counts only when EVERY clone
    // launched and verified; providers that pass are then ranked by speed.
    // Unsupported providers (verifyPassed: false) score 0 and their timings
    // stay on the record but out of the composite.
    success: {
      requireData: { verifyPassed: true },
    },
  }),
  display: {
    metrics: [
      { key: 'createMs', label: 'Create', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'populateMs', label: 'Populate', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'snapshotCreateMs', label: 'Snapshot create', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'snapshotFreezeMs', label: 'Source freeze during snapshot', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'downMs', label: 'Source down', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'fanoutCount', label: 'Fanout', direction: 'higher-better', decimals: 0 },
      { key: 'restoreMinMs', label: 'Restore min', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'restoreMedianMs', label: 'Restore median', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'restoreMaxMs', label: 'Restore max', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'fanoutWallClockMs', label: 'Fanout wall clock', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'verifiedCount', label: 'Verified', direction: 'higher-better', decimals: 0 },
      { key: 'fanoutSuccessRate', label: 'Fanout success', unit: 'ratio', direction: 'higher-better', decimals: 2 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'wallClockMs', label: 'Wall clock', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox', order: 0 },
      { key: 'populate', label: 'Populate filesystem', order: 1 },
      { key: 'snapshot_create', label: 'Create snapshot', order: 2 },
      { key: 'source_down', label: 'Destroy source box', order: 3 },
      { key: 'fanout_restore', label: 'Fanout restore', order: 4 },
      { key: 'verify', label: 'Verify clones', order: 5 },
      { key: 'destroy', label: 'Destroy all', order: 6 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: (outcome): Promise<void> =>
    writeSnapshotFanoutLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('sandbox_snapshot_fanout'),
      scoring: config.scoring,
    }),
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? CREATE_TIMEOUT_MS;
  const cleanupTimeout = p.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS;
  const fanoutCount = resolveFanoutCount();

  const runId = newRunId();
  const markerContent = `verify-content-${runId}`;
  // Marker lives under the sandbox workdir (resolved after create): writable
  // and in-scope on every provider, and on the persistent rootfs — same
  // reasoning as sandbox-snapshot.
  let expected: FileExpectation[] = [];

  let sandbox: SnapshotSandbox | undefined;
  const fannedBoxes: SnapshotSandbox[] = [];
  let snapshotId: string | undefined;
  let sourceDestroyed = false;
  let snapshotIsBoxIdentity = false;
  let createMs = 0;
  let populateMs = 0;
  let snapshotCreateMs = 0;
  let downMs = 0;
  let markerDirSource: SnapshotDirSource | null = null;
  /** `snapshot.waitUntilReady` wait for eventual-readiness providers; not in restore time. */
  let snapshotReadyMs: number | null = null;
  let launchedCount = 0;
  let restoreMinMs = 0;
  let restoreMedianMs = 0;
  let restoreMaxMs = 0;
  let fanoutWallClockMs = 0;
  let verifiedCount = 0;
  let fanoutSuccessRate = 0;
  let destroyMs = 0;
  let snapshotSupported = false;
  let snapshotError: string | undefined;
  let sourceIntact: boolean | null = null;
  let snapshotFreezeMs: number | null = null;
  let sourceGone = false;
  let heartbeat: SourceHeartbeat | undefined;
  let verifyPassed = false;
  const rStart = performance.now();

  try {
    const createStart = performance.now();
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create(withSnapshotCreateOptions(compute, p.sandboxOptions)),
        createTimeout,
        'Sandbox creation timed out',
        (s) => s.destroy(),
      ),
    );
    createMs = performance.now() - createStart;
    measure({ createMs });

    // Marker file only — enough to prove the snapshot preserved state on
    // every clone.
    const populateStart = performance.now();
    await step('populate', () =>
      withTimeout(
        (async () => {
          const { dir: workdir, source } = await resolveSnapshotDir(sandbox!, compute, createTimeout, p.snapshotWorkdir);
          markerDirSource = source;
          const baseDir = `${workdir}/bench-snapshot-fanout-${runId}`;
          expected = buildExpectedFiles(baseDir, 0, 0, `${baseDir}/marker.txt`, markerContent);
          await populateFilesystem(sandbox!, baseDir, expected);
        })(),
        createTimeout,
        'Filesystem population timed out',
      ),
    );
    populateMs = performance.now() - populateStart;
    measure({ populateMs });

    if (compute.snapshot) {
      snapshotSupported = true;
      try {
        heartbeat = await step(
          'source-heartbeat',
          () => withTimeout(startSourceHeartbeat(sandbox!, runId), createTimeout, 'Source heartbeat start timed out'),
          { reportConcurrency: false },
        );
        const snapStart = performance.now();
        const snapshot = await step('snapshot_create', () =>
          withTimeout(
            // @ts-expect-error - 'scope' lands in @computesdk/microsandbox >= 0.1.27 types
            compute.snapshot!.create(sandbox!.sandboxId, { name: `snap-fanout-${runId}`, scope: 'full' }),
            createTimeout,
            'Snapshot creation timed out',
          ),
        );
        snapshotCreateMs = performance.now() - snapStart;
        snapshotId = snapshot.id;
        measure({ snapshotCreateMs, snapshotId });

        // Box-identity snapshots (pause/hibernate models) are not
        // create + restore — the stopped box IS the restore point, and
        // fanning out from it would just resume copies of a live box.
        snapshotIsBoxIdentity = snapshot.id === sandbox!.sandboxId;
        if (snapshotIsBoxIdentity) {
          throw new Error('box-identity snapshot (pause/resume) is not create+restore');
        }

        const readyMs = await withTimeout(
          waitForSnapshotReady(compute, snapshot.id, SNAPSHOT_READY_TIMEOUT_MS),
          SNAPSHOT_READY_TIMEOUT_MS + 5_000,
          'Snapshot ready timeout',
        );
        if (readyMs !== null) {
          snapshotReadyMs = readyMs;
          measure({ snapshotReadyMs });
        }

        // In-guest source check, whatever the provider declares: a snapshot
        // that stops or kills the source fails here, before teardown.
        const integrity = await step(
          'source-check',
          () => withTimeout(checkSourceIntact(compute, sandbox!, heartbeat!), createTimeout, 'Source check timed out'),
          { reportConcurrency: false },
        );
        sourceIntact = integrity.sourceIntact;
        snapshotFreezeMs = integrity.snapshotFreezeMs;
        sourceGone = integrity.sourceGone;
        if (sourceGone) sourceDestroyed = true;
        measure({ sourceIntact, ...(snapshotFreezeMs !== null ? { snapshotFreezeMs } : {}) });
        if (!sourceIntact) throw new Error(`${SOURCE_STOPPED_CODE}: ${integrity.reason}`);

        // Destroy the source so the fanout exercises the snapshot artifact
        // alone. A destroy failure logs a warning and continues — the
        // restore attempt still happens.
        const downStart = performance.now();
        try {
          await step(
            'source_down',
            () =>
              sourceGone
                ? Promise.resolve()
                : withTimeout(sandbox!.destroy(), cleanupTimeout, 'Source destroy timeout'),
            { reportConcurrency: false },
          );
          sourceDestroyed = true;
        } catch (err) {
          log('source destroy failed; continuing to fanout', {
            level: 'warn',
            meta: { error: formatError(err) },
          });
        }
        downMs = performance.now() - downStart;
        measure({ downMs });

        // Launch all clones concurrently, each timed individually. A clone
        // that fails to launch is recorded with its elapsed time + error
        // rather than rejecting the batch — the fanout question is about
        // the whole group, including partial failures.
        const restoreOptions = buildRestoreOptions(p.sandboxOptions, snapshot.id);

        const fanoutStart = performance.now();
        const restores = await step('fanout_restore', async () => {
          const results = await Promise.all(
            Array.from({ length: fanoutCount }, async (_, i) => {
              const t0 = performance.now();
              try {
                const box = await withTimeout(
                  compute.sandbox.create(restoreOptions),
                  createTimeout,
                  'Fanout restore timed out',
                  (s) => s.destroy(),
                );
                return { index: i, box, ms: performance.now() - t0 };
              } catch (err) {
                return { index: i, error: formatError(err), ms: performance.now() - t0 };
              }
            }),
          );
          // step.data: per-box restore timings (+ per-box errors when a
          // launch failed).
          const stepData: Record<string, number | string> = {};
          for (const r of results) {
            stepData[`restore${r.index}Ms`] = Math.round(r.ms);
            if ('error' in r && r.error) stepData[`restore${r.index}Error`] = r.error;
          }
          measure(stepData);
          return results;
        });

        for (const r of restores) {
          if ('box' in r && r.box) fannedBoxes.push(r.box);
        }
        launchedCount = fannedBoxes.length;
        const times = restores.map((r) => r.ms).sort((a, b) => a - b);
        restoreMinMs = times[0] ?? 0;
        restoreMaxMs = times[times.length - 1] ?? 0;
        restoreMedianMs =
          times.length % 2 === 1
            ? times[Math.floor(times.length / 2)]
            : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
        measure({ fanoutCount, restoreMinMs, restoreMedianMs, restoreMaxMs });

        // Verify the marker on EVERY clone; all must launch and match for
        // the iteration to pass.
        const verifications = await step('verify', () =>
          withTimeout(
            Promise.all(
              fannedBoxes.map((box) =>
                verifyFiles(box, expected).catch(
                  (err): VerifyOutcome => ({
                    allMatched: false,
                    filesVerified: 0,
                    verifiedBytes: 0,
                    mismatched: expected.map((f) => f.path),
                    unexpectedlyPresent: [`verify error: ${formatError(err)}`],
                  }),
                ),
              ),
            ),
            createTimeout,
            'Verify timed out',
          ),
        );
        verifiedCount = verifications.filter((v) => v.allMatched).length;
        fanoutSuccessRate = verifiedCount / fanoutCount;
        verifyPassed = launchedCount === fanoutCount && verifiedCount === fanoutCount;
        fanoutWallClockMs = performance.now() - fanoutStart;
        measure({ verifiedCount, fanoutSuccessRate, verifyPassed, fanoutWallClockMs });

        if (!verifyPassed) {
          throw new Error(
            `fanout verification failed: ${verifiedCount}/${fanoutCount} clones verified` +
              (launchedCount < fanoutCount ? ` (${launchedCount} launched)` : ''),
          );
        }
      } catch (err) {
        snapshotError = formatError(err);
        log('snapshot fanout lifecycle failed', { level: 'warn', meta: { error: snapshotError } });
      }
    } else {
      snapshotSupported = false;
      log('snapshot not supported by provider', { level: 'info' });
    }
  } finally {
    // Best-effort cleanup: destroy every fanned clone, the source box (if
    // still up), and the snapshot. Single `destroy` step; failures warn and
    // continue so one stuck clone doesn't leak the rest.
    const destroyStart = performance.now();
    await step(
      'destroy',
      async () => {
        await Promise.all(
          fannedBoxes.map((box) =>
            withTimeout(box.destroy(), cleanupTimeout, 'Destroy clone timeout').catch(
              (err: unknown) =>
                log('destroy clone failed', { level: 'warn', meta: { error: formatError(err) } }),
            ),
          ),
        );
        if (sandbox && !sourceDestroyed) {
          await withTimeout(sandbox.destroy(), cleanupTimeout, 'Destroy timeout').catch(
            (err: unknown) =>
              log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
          );
        }
        if (snapshotId && compute.snapshot && !snapshotIsBoxIdentity) {
          await withTimeout(
            compute.snapshot.delete(snapshotId),
            cleanupTimeout,
            'Snapshot delete timeout',
          ).catch((err: unknown) =>
            log('snapshot delete failed', { level: 'warn', meta: { error: formatError(err) } }),
          );
        }
      },
      { reportConcurrency: false },
    ).catch((err: unknown) =>
      log('cleanup failed', { level: 'warn', meta: { error: formatError(err) } }),
    );
    destroyMs = performance.now() - destroyStart;
    measure({ destroyMs });
  }

  const wallClockMs = performance.now() - rStart;

  const baseMeta = {
    markerDirSource,
    snapshotReadyMs,
    sourceIntact,
    snapshotFreezeMs,
    ...snapshotCapabilityMeta(compute),
    createMs,
    populateMs,
    snapshotCreateMs,
    downMs,
    fanoutCount,
    launchedCount,
    restoreMinMs,
    restoreMedianMs,
    restoreMaxMs,
    fanoutWallClockMs,
    verifiedCount,
    fanoutSuccessRate,
    destroyMs,
    snapshotSupported,
    snapshotIsBoxIdentity,
    verifyPassed,
    wallClockMs,
  };

  if (snapshotSupported && snapshotError) {
    const data = {
      ...baseMeta,
      snapshotError,
      replicateMs: [wallClockMs],
    } as unknown as JsonObject;
    throw new TaskError('snapshot fanout workload failed: ' + snapshotError, {
      code: sourceIntact === false ? SOURCE_STOPPED_CODE : 'snapshot_fanout_workload_failed',
      data,
    });
  }

  measure({ wallClockMs });

  const meta: JsonObject = Object.fromEntries(
    Object.entries({
      provider: p.name,
      ...baseMeta,
      snapshotError: snapshotError ?? null,
    }).filter(([, v]) => v !== undefined),
  ) as JsonObject;

  log('snapshot fanout workload completed', {
    level: 'info',
    meta,
  });

  return {
    data: { ...meta, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: snapshotSupported ? restoreMedianMs || snapshotCreateMs : populateMs,
  };
});

export const beforeExit = () => drainLateCleanups();
