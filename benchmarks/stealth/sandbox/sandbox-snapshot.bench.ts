/**
 * Snapshot benchmark: creates a sandbox, writes a marker file, snapshots it
 * (timed), takes the box down, then spins it back up from the snapshot after
 * a configurable downtime (timed) and verifies the marker survived.
 *
 * Downtime model: after snapshotting, the source sandbox is destroyed so the
 * restore exercises the snapshot artifact alone. Providers whose snapshot id
 * IS the source sandbox id (pause/hibernate models — the stopped box is the
 * snapshot) fail the benchmark: pause + resume is not create + restore.
 *
 * Providers without snapshot support are recorded as unsupported but still
 * contribute creation and destroy timings.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench:sandbox:snapshot
 *   pnpm bench:sandbox:snapshot --provider e2b --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { reciprocalScoring } from '../src/util/scoring.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { SNAPSHOT_CEILINGS_MS, SUITE_CONFIG, writeSnapshotLegacyResults } from './sandbox-snapshot.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import {
  CREATE_TIMEOUT_MS,
  DESTROY_TIMEOUT_MS,
  buildExpectedFiles,
  buildRestoreOptions,
  newRunId,
  populateFilesystem,
  resolveDowntimeMs,
  resolveSnapshotDir,
  SNAPSHOT_READY_TIMEOUT_MS,
  snapshotSource,
  checkSourceIntact,
  SOURCE_STOPPED_CODE,
  startSourceHeartbeat,
  type SourceHeartbeat,
  waitForSnapshotReady,
  type SnapshotDirSource,
  snapshotCapabilityMeta,
  withSnapshotCreateOptions,
  verifyFiles,
  type Compute,
  type FileExpectation,
  type SnapshotSandbox,
} from '../src/util/snapshot.js';
import { SNAPSHOT_MATRIX_SPEC, uploadSnapshotMatrix } from '../src/util/snapshot-matrix.js';


/** miosa's default SOMA runtime has no snapshots; firecracker does. */
const participants: ProviderConfig[] = providers.map((p) =>
  p.name === 'miosa' ? { ...p, sandboxOptions: { ...p.sandboxOptions, runtime: 'firecracker' } } : p,
);

export const config = defineBenchmarkConfig({
  // Index type: the platform renders the run as a providers × stages matrix
  // (built from each leg's `kind: 'matrix'` artifact in onComplete) instead of
  // the forensic step table, so a provider whose API calls return but whose
  // restore fails verification reads as '—'/failed, not green latencies.
  type: 'index',
  index: { layout: 'matrix', spec: SNAPSHOT_MATRIX_SPEC },
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. sandbox-snapshot-daily); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-snapshot',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Snapshot',
  iterations: SUITE_CONFIG.defaultIterations,
  concurrency: 1,
  groupBy: 'round',
  participants,
  scoring: reciprocalScoring({
    metrics: [
      { key: 'createMs', unit: 'ms', ceiling: SNAPSHOT_CEILINGS_MS.createMs, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'snapshotCreateMs', unit: 'ms', ceiling: SNAPSHOT_CEILINGS_MS.snapshotCreateMs, weights: { median: 0.35, p95: 0, p99: 0 } },
      { key: 'snapshotRestoreMs', unit: 'ms', ceiling: SNAPSHOT_CEILINGS_MS.snapshotRestoreMs, weights: { median: 0.45, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: SNAPSHOT_CEILINGS_MS.destroyMs, weights: { median: 0.1, p95: 0, p99: 0 } },
    ],
    // A provider without a verified restore is not a successful snapshot run:
    // unsupported providers (verifyPassed: false) score 0 and their timings
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
      { key: 'snapshotRestoreMs', label: 'Snapshot restore', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'verifyMs', label: 'Verify', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'wallClockMs', label: 'Wall clock', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox', order: 0 },
      { key: 'populate', label: 'Populate filesystem', order: 1 },
      { key: 'snapshot-create', label: 'Create snapshot', order: 2 },
      { key: 'down', label: 'Take source down', order: 3 },
      { key: 'downtime', label: 'Downtime', order: 4 },
      { key: 'snapshot-restore', label: 'Restore from snapshot', order: 5 },
      { key: 'verify', label: 'Verify marker', order: 6 },
      { key: 'destroy-restored', label: 'Destroy restored box', order: 7 },
      { key: 'destroy', label: 'Destroy source', order: 8 },
      { key: 'snapshot-delete', label: 'Delete snapshot', order: 9 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: async (outcome) => {
    await writeSnapshotLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('sandbox_snapshot'),
      scoring: config.scoring,
    });
    await uploadSnapshotMatrix(outcome, config.benchmarkSlug);
  },
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? CREATE_TIMEOUT_MS;
  const cleanupTimeout = p.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS;

  const runId = newRunId();
  const markerContent = `verify-content-${runId}`;
  const downtimeMs = resolveDowntimeMs();
  // Marker lives under the sandbox workdir (resolved after create): writable
  // and in-scope on every provider (unlike root-owned /opt or tmpfs /tmp) and
  // on the persistent rootfs. tmpfs exclusion is a legitimate snapshot
  // boundary measured by the fidelity benchmark, not a create+restore failure.
  let expected: FileExpectation[] = [];

  let sandbox: SnapshotSandbox | undefined;
  let restoredSandbox: SnapshotSandbox | undefined;
  let snapshotId: string | undefined;
  let sourceDestroyed = false;
  let snapshotIsBoxIdentity = false;
  let createMs = 0;
  let populateMs = 0;
  let snapshotCreateMs = 0;
  let downMs = 0;
  let snapshotRestoreMs = 0;
  /** `snapshot.waitUntilReady` wait for eventual-readiness providers; not in restore time. */
  let snapshotReadyMs: number | null = null;
  let verifyMs = 0;
  let destroyMs = 0;
  let snapshotSupported = false;
  let snapshotError: string | undefined;
  let sourceIntact: boolean | null = null;
  let snapshotFreezeMs: number | null = null;
  let sourceGone = false;
  let heartbeat: SourceHeartbeat | undefined;
  let markerDirSource: SnapshotDirSource | null = null;
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

    // Marker file only — enough to prove the snapshot preserved state.
    const populateStart = performance.now();
    await step('populate', () =>
      withTimeout(
        (async () => {
          const { dir: workdir, source } = await resolveSnapshotDir(sandbox!, compute, createTimeout, p.snapshotWorkdir);
          markerDirSource = source;
          const baseDir = `${workdir}/bench-snapshot-${runId}`;
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
        const snapshot = await step('snapshot-create', () =>
          withTimeout(
            // @ts-expect-error - 'scope' lands in @computesdk/microsandbox >= 0.1.27 types
            compute.snapshot!.create(sandbox!.sandboxId, { name: `snap-${runId}`, scope: 'full' }),
            createTimeout,
            'Snapshot creation timed out',
          ),
        );
        snapshotCreateMs = performance.now() - snapStart;
        snapshotId = snapshot.id;
        measure({ snapshotCreateMs, snapshotId });

        // Take the box down. When the snapshot id is the source sandbox id
        // (pause/hibernate models), the stopped box IS the restore point —
        // pause + resume is not create + restore, so it fails the benchmark.
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

        const downStart = performance.now();
        try {
          await step(
            'down',
            () =>
              sourceGone
                ? Promise.resolve()
                : withTimeout(sandbox!.destroy(), cleanupTimeout, 'Source destroy timeout'),
            { reportConcurrency: false },
          );
          sourceDestroyed = true;
        } catch (err) {
          log('source destroy failed; continuing to restore', {
            level: 'warn',
            meta: { error: formatError(err) },
          });
        }
        downMs = performance.now() - downStart;
        measure({ downMs });

        // Simulated downtime before the box is spun back up.
        if (downtimeMs > 0) {
          await step(
            'downtime',
            () => new Promise<void>((resolve) => setTimeout(resolve, downtimeMs)),
            { reportConcurrency: false },
          );
        }

        const restoreOptions = buildRestoreOptions(p.sandboxOptions, snapshot.id);

        const restoreStart = performance.now();
        restoredSandbox = await step('snapshot-restore', () =>
          withTimeout(
            compute.sandbox.create(restoreOptions),
            createTimeout,
            'Snapshot restore timed out',
            (s) => s.destroy(),
          ),
        );
        snapshotRestoreMs = performance.now() - restoreStart;
        measure({ snapshotRestoreMs });

        const verifyStart = performance.now();
        const verification = await step('verify', () =>
          withTimeout(
            verifyFiles(restoredSandbox!, expected),
            createTimeout,
            'Verify timed out',
          ),
        );
        verifyMs = performance.now() - verifyStart;
        verifyPassed = verification.allMatched;
        measure({ verifyMs, verifyPassed });

        if (!verifyPassed) {
          throw new Error('Snapshot verification failed: marker file did not survive restore');
        }
      } catch (err) {
        snapshotError = formatError(err);
        log('snapshot lifecycle failed', { level: 'warn', meta: { error: snapshotError } });
      }
    } else {
      snapshotSupported = false;
      log('snapshot not supported by provider', { level: 'info' });
    }
  } finally {
    if (restoredSandbox) {
      const destroyStart = performance.now();
      await step(
        'destroy-restored',
        () => withTimeout(restoredSandbox!.destroy(), cleanupTimeout, 'Destroy restored timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('destroy restored failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      destroyMs = performance.now() - destroyStart;
      measure({ destroyMs });
    }

    if (sandbox && !sourceDestroyed) {
      const destroyStart = performance.now();
      await step(
        'destroy',
        () => withTimeout(sandbox!.destroy(), cleanupTimeout, 'Destroy timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
      if (destroyMs === 0) {
        destroyMs = performance.now() - destroyStart;
        measure({ destroyMs });
      }
    }

    if (snapshotId && compute.snapshot && !snapshotIsBoxIdentity) {
      await step(
        'snapshot-delete',
        () => withTimeout(compute.snapshot!.delete(snapshotId!), cleanupTimeout, 'Snapshot delete timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) =>
        log('snapshot delete failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
    }
  }

  const wallClockMs = performance.now() - rStart;

  const baseMeta = {
    ...snapshotCapabilityMeta(compute),
    markerDirSource,
    createMs,
    populateMs,
    snapshotCreateMs,
    downMs,
    downtimeMs,
    snapshotRestoreMs,
    snapshotReadyMs,
    sourceIntact,
    snapshotFreezeMs,
    verifyMs,
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
    throw new TaskError('snapshot workload failed: ' + snapshotError, {
      code: sourceIntact === false ? SOURCE_STOPPED_CODE : 'snapshot_workload_failed',
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

  log('snapshot workload completed', {
    level: 'info',
    meta,
  });

  return {
    data: { ...meta, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: snapshotSupported ? snapshotRestoreMs || snapshotCreateMs : populateMs,
  };
});

export const beforeExit = () => drainLateCleanups();
