/**
 * Filesystem-snapshot sandbox benchmark: creates and populates files inside a
 * fresh sandbox, snapshots it, takes the box down, then spins it back up from
 * the snapshot after a configurable downtime and verifies every file survived.
 * The headline metric is restore latency — how quickly a persistent box comes
 * back after downtime. Providers without snapshot support are recorded as
 * unsupported but still contribute creation, population, and destroy timings.
 *
 * Downtime model: after snapshotting, the source sandbox is destroyed so the
 * restore exercises the snapshot artifact alone. Providers whose snapshot id
 * IS the source sandbox id (pause/hibernate models — the stopped box is the
 * snapshot) skip the destroy, since it would delete the restore point.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/filesystem-snapshot.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/filesystem-snapshot.bench.ts --provider e2b --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { reciprocalScoring } from '../src/util/scoring.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { FILESYSTEM_SNAPSHOT_CEILINGS_MS, SUITE_CONFIG } from './filesystem-snapshot.js';
import { writeFilesystemSnapshotLegacyResults } from './filesystem-snapshot-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import { SNAPSHOT_MATRIX_SPEC, uploadSnapshotMatrix } from '../src/util/snapshot-matrix.js';
import {
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
  type SnapshotSandbox,
} from '../src/util/snapshot.js';


const createTimeoutMs = 120_000;
const destroyTimeoutMs = 15_000;
const defaultDowntimeMs = 60_000;

function resolveDowntimeMs(): number {
  const parsed = Number(process.env.BENCH_DOWNTIME_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultDowntimeMs;
}

interface FilesystemSnapshotSandbox {
  sandboxId: string;
  runCommand(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  filesystem: {
    mkdir(path: string): Promise<void>;
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };
  destroy(): Promise<unknown>;
}

interface Compute {
  sandbox: {
    create(options?: Record<string, any>): Promise<FilesystemSnapshotSandbox>;
  };
  snapshot?: {
    create(sandboxId: string, options?: { name?: string }): Promise<{ id: string }>;
    delete(snapshotId: string): Promise<unknown>;
  };
}

export const config = defineBenchmarkConfig({
  // Index type: the platform renders the run as a providers × stages matrix
  // (built from each leg's `kind: 'matrix'` artifact in onComplete) instead of
  // the forensic step table, so a provider whose API calls return but whose
  // restore fails verification reads as '—'/failed, not green latencies.
  type: 'index',
  index: { layout: 'matrix', spec: SNAPSHOT_MATRIX_SPEC },
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. filesystem-snapshot-daily); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'filesystem-snapshot',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox filesystem snapshot & restore',
  iterations: SUITE_CONFIG.defaultReplicas,
  concurrency: 1,
  groupBy: 'round',
  participants: providers,
  scoring: reciprocalScoring({
    metrics: [
      { key: 'createMs', unit: 'ms', ceiling: FILESYSTEM_SNAPSHOT_CEILINGS_MS.createMs, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'populateMs', unit: 'ms', ceiling: FILESYSTEM_SNAPSHOT_CEILINGS_MS.populateMs, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'snapshotCreateMs', unit: 'ms', ceiling: FILESYSTEM_SNAPSHOT_CEILINGS_MS.snapshotCreateMs, weights: { median: 0.15, p95: 0, p99: 0 } },
      // Restore-after-downtime is the headline metric for the persistent-box
      // use case, so it carries nearly half the composite weight.
      { key: 'snapshotRestoreMs', unit: 'ms', ceiling: FILESYSTEM_SNAPSHOT_CEILINGS_MS.snapshotRestoreMs, weights: { median: 0.45, p95: 0, p99: 0 } },
      { key: 'verifyMs', unit: 'ms', ceiling: FILESYSTEM_SNAPSHOT_CEILINGS_MS.verifyMs, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: FILESYSTEM_SNAPSHOT_CEILINGS_MS.destroyMs, weights: { median: 0.1, p95: 0, p99: 0 } },
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
      { key: 'verify', label: 'Verify files', order: 6 },
      { key: 'destroy-restored', label: 'Destroy restored box', order: 7 },
      { key: 'destroy', label: 'Destroy source', order: 8 },
      { key: 'snapshot-delete', label: 'Delete snapshot', order: 9 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: async (outcome) => {
    await writeFilesystemSnapshotLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('filesystem_snapshot'),
      scoring: config.scoring,
    });
    await uploadSnapshotMatrix(outcome, config.benchmarkSlug);
  },
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? createTimeoutMs;
  const cleanupTimeout = p.destroyTimeoutMs ?? destroyTimeoutMs;

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Resolved after create: the provider's declared snapshot path, else the
  // `pwd` workdir. /tmp is tmpfs on several providers and is not captured.
  let baseDir = '';
  let markerFile = '';
  let markerDirSource: SnapshotDirSource | null = null;
  const markerContent = `verify-content-${runId}`;
  const downtimeMs = resolveDowntimeMs();

  // Deterministic repeated pattern; avoid generating huge random strings client-side.
  const chunk = 'x'.repeat(1024);
  const expectedContent = chunk
    .repeat(Math.ceil(SUITE_CONFIG.fileSizeBytes / chunk.length))
    .slice(0, SUITE_CONFIG.fileSizeBytes);

  let sandbox: FilesystemSnapshotSandbox | undefined;
  let restoredSandbox: FilesystemSnapshotSandbox | undefined;
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
  let verifyPassed = false;
  let filesVerified = 0;
  let verifiedBytes = 0;
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

    const populateStart = performance.now();
    await step('populate', () =>
      withTimeout(
        (async () => {
          const resolved = await resolveSnapshotDir(sandbox as unknown as SnapshotSandbox, compute, createTimeout, p.snapshotWorkdir);
          markerDirSource = resolved.source;
          baseDir = `${resolved.dir}/bench-fs-snapshot-${runId}`;
          markerFile = `${baseDir}/marker.txt`;
          await populateFilesystem(sandbox!, baseDir, SUITE_CONFIG.fileCount, expectedContent, markerFile, markerContent);
        })(),
        createTimeout,
        'Filesystem population timed out',
      ),
    );
    populateMs = performance.now() - populateStart;
    measure({ populateMs, fileCount: SUITE_CONFIG.fileCount, totalBytes: SUITE_CONFIG.fileCount * SUITE_CONFIG.fileSizeBytes, markerDirSource, ...snapshotCapabilityMeta(compute) });

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
            compute.snapshot!.create(sandbox!.sandboxId, { name: `fs-snap-${runId}`, scope: 'full' }),
            createTimeout,
            'Snapshot creation timed out',
          ),
        );
        snapshotCreateMs = performance.now() - snapStart;
        snapshotId = snapshot.id;
        measure({ snapshotCreateMs, snapshotId });

        // Take the box down. When the snapshot id is the source sandbox id
        // (pause/hibernate models), the stopped box IS the restore point —
        // destroying it would delete the snapshot itself.
        snapshotIsBoxIdentity = snapshot.id === sandbox!.sandboxId;

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
        if (!snapshotIsBoxIdentity) {
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
        }

        // Simulated downtime before the box is spun back up.
        if (downtimeMs > 0) {
          await step(
            'downtime',
            () => new Promise<void>((resolve) => setTimeout(resolve, downtimeMs)),
            { reportConcurrency: false },
          );
        }

        // templateId/image select the boot base for a fresh sandbox; the
        // snapshot replaces them on restore (E2B prefers templateId over
        // snapshotId when both are present).
        const restoreOptions: Record<string, any> = { ...p.sandboxOptions, snapshotId: snapshot.id };
        delete restoreOptions.templateId;
        delete restoreOptions.image;


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
            verifyFilesystem(
              restoredSandbox!,
              baseDir,
              SUITE_CONFIG.fileCount,
              expectedContent,
              markerFile,
              markerContent,
            ),
            createTimeout,
            'Verify timed out',
          ),
        );
        verifyMs = performance.now() - verifyStart;
        verifyPassed = verification.allMatched;
        filesVerified = verification.filesVerified;
        verifiedBytes = verification.verifiedBytes;
        measure({ verifyMs, verifyPassed, filesVerified, verifiedBytes });

        if (!verifyPassed) {
          throw new Error(
            `Snapshot verification failed: ${filesVerified}/${SUITE_CONFIG.fileCount + 1} files matched`,
          );
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

    if (snapshotId && compute.snapshot) {
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

  if (snapshotSupported && snapshotError) {
    const data = {
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
      snapshotError,
      verifyPassed,
      filesVerified,
      verifiedBytes,
      fileCount: SUITE_CONFIG.fileCount,
      totalBytes: SUITE_CONFIG.fileCount * SUITE_CONFIG.fileSizeBytes,
      wallClockMs,
      replicateMs: [wallClockMs],
    } as unknown as JsonObject;
    throw new TaskError('filesystem-snapshot workload failed: ' + snapshotError, {
      code: sourceIntact === false ? SOURCE_STOPPED_CODE : 'filesystem_snapshot_workload_failed',
      data,
    });
  }

  measure({ wallClockMs });

  const meta: JsonObject = Object.fromEntries(
    Object.entries({
      provider: p.name,
      snapshotSupported,
      snapshotIsBoxIdentity,
      snapshotError: snapshotError ?? null,
      verifyPassed,
      filesVerified,
      verifiedBytes,
      fileCount: SUITE_CONFIG.fileCount,
      totalBytes: SUITE_CONFIG.fileCount * SUITE_CONFIG.fileSizeBytes,
      wallClockMs,
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
    }).filter(([, v]) => v !== undefined),
  ) as JsonObject;

  log('filesystem-snapshot workload completed', {
    level: 'info',
    meta,
  });

  return {
    data: { ...meta, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: snapshotSupported ? snapshotRestoreMs || snapshotCreateMs : populateMs,
  };
});

async function populateFilesystem(
  sandbox: FilesystemSnapshotSandbox,
  baseDir: string,
  fileCount: number,
  content: string,
  markerFile: string,
  markerContent: string,
): Promise<void> {
  await sandbox.filesystem.mkdir(baseDir);

  await Promise.all(
    Array.from({ length: fileCount }, (_, i) =>
      sandbox.filesystem.writeFile(`${baseDir}/file-${i}.txt`, content),
    ),
  );

  await sandbox.filesystem.writeFile(markerFile, markerContent);
}

async function verifyFilesystem(
  sandbox: FilesystemSnapshotSandbox,
  baseDir: string,
  fileCount: number,
  expectedContent: string,
  markerFile: string,
  markerContent: string,
): Promise<{ allMatched: boolean; filesVerified: number; verifiedBytes: number }> {
  const reads = await Promise.all(
    [
      ...Array.from({ length: fileCount }, (_, i) => `${baseDir}/file-${i}.txt`),
      markerFile,
    ].map(async (filePath) => {
      try {
        const content = await sandbox.filesystem.readFile(filePath);
        const expected = filePath === markerFile ? markerContent : expectedContent;
        return { matched: content === expected, bytes: content.length };
      } catch {
        return { matched: false, bytes: 0 };
      }
    }),
  );

  const filesVerified = reads.filter((r) => r.matched).length;
  const verifiedBytes = reads.reduce((sum, r) => sum + (r.matched ? r.bytes : 0), 0);
  return { allMatched: filesVerified === fileCount + 1, filesVerified, verifiedBytes };
}

export const beforeExit = () => drainLateCleanups();
