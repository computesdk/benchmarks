/**
 * Fidelity benchmark: same create -> snapshot -> destroy -> downtime -> restore
 * lifecycle as `snapshot`, but the sandbox is populated with several kinds of
 * state and the restore is verified per check — so the result is a matrix of
 * what survived, not just whether a marker file did.
 *
 * Payload (under <workdir>/bench-fidelity-<runId>, on the persistent rootfs):
 *   - payload.txt         text file with per-run content
 *   - large.bin           256KB deterministic file
 *   - run.sh              executable script that echoes the run id
 *   - link.txt            symlink -> payload.txt
 *   - node_modules/       `npm i is-number` (rootfs capture; informational)
 *   - heartbeat-<runId>.log written by a detached loop (process survival; informational)
 *   - mutated-target.txt  deleted AFTER snapshot.create (isolation check)
 *   - /tmp/fidelity-<runId>.txt (tmpfs inclusion; informational)
 *
 * Checks: fileText, fileLarge, executable, symlink, isolationOverwrite,
 * isolationDelete are scored (all must pass for the iteration to pass);
 * tmpfs, package, processAlive are recorded but unscored.
 *
 * Box-identity snapshots (snapshot.id === sandbox.sandboxId — pause/hibernate
 * models) fail the benchmark: pause + resume is not create + restore.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench:sandbox:fidelity
 *   pnpm bench:sandbox:fidelity --provider e2b --iterations 3
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import path from 'node:path';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { reciprocalScoring } from '../src/util/scoring.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { FIDELITY_CEILINGS_MS, SUITE_CONFIG, SCORED_CHECKS, writeFidelityLegacyResults } from './sandbox-fidelity.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import {
  CREATE_TIMEOUT_MS,
  DESTROY_TIMEOUT_MS,
  POPULATE_TIMEOUT_MS,
  buildRestoreOptions,
  deterministicContent,
  newRunId,
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
  sourceKept,
  snapshotCapabilityMeta,
  withSnapshotCreateOptions,
  type Compute,
  type SnapshotSandbox,
} from '../src/util/snapshot.js';


/** miosa's default SOMA runtime has no snapshots; firecracker does. */
const participants: ProviderConfig[] = providers.map((p) =>
  p.name === 'miosa' ? { ...p, sandboxOptions: { ...p.sandboxOptions, runtime: 'firecracker' } } : p,
);

export const config = defineBenchmarkConfig<ProviderConfig>({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (e.g. sandbox-fidelity-daily); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-fidelity',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Fidelity',
  iterations: SUITE_CONFIG.defaultIterations,
  concurrency: 1,
  groupBy: 'round',
  participants,
  scoring: reciprocalScoring({
    metrics: [
      { key: 'createMs', unit: 'ms', ceiling: FIDELITY_CEILINGS_MS.createMs, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'snapshotCreateMs', unit: 'ms', ceiling: FIDELITY_CEILINGS_MS.snapshotCreateMs, weights: { median: 0.35, p95: 0, p99: 0 } },
      { key: 'snapshotRestoreMs', unit: 'ms', ceiling: FIDELITY_CEILINGS_MS.snapshotRestoreMs, weights: { median: 0.45, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: FIDELITY_CEILINGS_MS.destroyMs, weights: { median: 0.1, p95: 0, p99: 0 } },
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
      { key: 'populate', label: 'Populate state payload', order: 1 },
      { key: 'snapshot-create', label: 'Create snapshot', order: 2 },
      { key: 'mutate', label: 'Mutate post-snapshot state', order: 3 },
      { key: 'down', label: 'Take source down', order: 4 },
      { key: 'downtime', label: 'Downtime', order: 5 },
      { key: 'snapshot-restore', label: 'Restore from snapshot', order: 6 },
      { key: 'verify', label: 'Verify checks', order: 7 },
      { key: 'destroy-restored', label: 'Destroy restored box', order: 8 },
      { key: 'destroy', label: 'Destroy source', order: 9 },
      { key: 'snapshot-delete', label: 'Delete snapshot', order: 10 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: (outcome): Promise<void> =>
    writeFidelityLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('sandbox_fidelity'),
      scoring: config.scoring,
    }),
});

interface Checks {
  fileText: boolean;
  fileLarge: boolean;
  executable: boolean;
  symlink: boolean;
  tmpfs: boolean | 'untested';
  package: boolean | 'untested';
  processAlive: boolean;
  isolationOverwrite: boolean;
  isolationDelete: boolean;
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? CREATE_TIMEOUT_MS;
  const populateTimeout = p.timeout ?? POPULATE_TIMEOUT_MS;
  const cleanupTimeout = p.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS;

  const runId = newRunId();
  const payloadContent = `fidelity-content-${runId}`;
  const largeContent = deterministicContent(256 * 1024);
  const tmpFile = `/tmp/fidelity-${runId}.txt`;
  const downtimeMs = resolveDowntimeMs();
  // Use a snapshot-safe persistent workspace accessible through the filesystem API.
  let baseDir = '';
  let markerDirSource: SnapshotDirSource | null = null;
  let payloadFile = '';
  let largeFile = '';
  let mutatedTarget = '';
  let runSh = '';
  let linkFile = '';
  let heartbeatLog = '';

  let sandbox: SnapshotSandbox | undefined;
  let restoredSandbox: SnapshotSandbox | undefined;
  let snapshotId: string | undefined;
  let sourceDestroyed = false;
  /** Post-snapshot mutation needs a live source; stopped/destroyed sources can't leak. */
  let isolationApplicable = true;
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
  let packagePopulate: 'installed' | 'untested' = 'untested';
  let tmpfsPopulate: 'written' | 'untested' = 'untested';
  let checks: Checks | undefined;
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

    // Files via the filesystem API; perms/symlink/package/process via shell.
    // Each op gets its own slice of the populate deadline: one hung op (a
    // provider without npm egress, an exec API that waits for detached
    // children) must name itself instead of burning the whole step budget.
    const populateStart = performance.now();
    const populateDeadline = populateStart + populateTimeout;
    const budget = (opMs: number) => Math.max(1_000, Math.min(opMs, populateDeadline - performance.now()));
    const op = <T>(name: string, opMs: number, run: () => Promise<T>) =>
      withTimeout(run(), budget(opMs), `populate:${name} timed out`);
    await step('populate', () =>
      withTimeout(
        (async () => {
          const { dir: workdir, source } = await op('resolve-workdir', 30_000, () =>
            resolveSnapshotDir(sandbox!, compute, budget(30_000), p.snapshotWorkdir),
          );
          markerDirSource = source;
          baseDir = `${workdir}/bench-fidelity-${runId}`;
          payloadFile = `${baseDir}/payload.txt`;
          largeFile = `${baseDir}/large.bin`;
          mutatedTarget = `${baseDir}/mutated-target.txt`;
          runSh = `${baseDir}/run.sh`;
          linkFile = `${baseDir}/link.txt`;
          heartbeatLog = `${baseDir}/heartbeat-${runId}.log`;
          await op('mkdir', 30_000, () => sandbox!.filesystem.mkdir(baseDir));
          await op('write-files', 120_000, () =>
            Promise.all([
              sandbox!.filesystem.writeFile(payloadFile, payloadContent),
              sandbox!.filesystem.writeFile(largeFile, largeContent),
              sandbox!.filesystem.writeFile(mutatedTarget, `delete-me-${runId}`),
              sandbox!.filesystem.writeFile(runSh, `#!/bin/sh\necho exec-ok-${runId}\n`),
            ]),
          );
          try {
            await op('tmpfs-write', 30_000, () =>
              sandbox!.filesystem.writeFile(tmpFile, `tmpfs-${runId}`),
            );
            tmpfsPopulate = 'written';
          } catch (err) {
            // Informational: /tmp lives outside the workdir, and providers
            // with workdir-scoped filesystems (e.g. tenki) reject the path.
            // /tmp exclusion is a legitimate snapshot boundary — untested.
            log('populate tmpfs-write failed', { level: 'warn', meta: { error: formatError(err) } });
          }
          // One runCommand per operation: some providers
          // reject large multi-line command frames.
          await op('chmod-link', 30_000, () =>
            sandbox!.runCommand(
              `chmod +x ${runSh} && ln -sf ${payloadFile} ${linkFile}`,
              { timeout: budget(30_000) },
            ),
          );
          try {
            const pkgRes = await op('pkg-install', 120_000, () =>
              sandbox!.runCommand(
                `cd ${baseDir} && npm init -y >/dev/null 2>&1 && npm i is-number@7 --no-audit --no-fund >/dev/null 2>&1; echo PKG:$?`,
                { timeout: budget(120_000) },
              ),
            );
            packagePopulate = /\bPKG:0\b/.test(pkgRes.stdout ?? '') ? 'installed' : 'untested';
          } catch (err) {
            // Informational check: a sandbox without npm egress hangs here.
            log('populate pkg-install failed', { level: 'warn', meta: { error: formatError(err) } });
          }
          try {
            await op('heartbeat', 30_000, () =>
              sandbox!.runCommand(
                `nohup sh -c "while :; do echo t >> ${heartbeatLog}; sleep 1; done" >/dev/null 2>&1 &`,
                { timeout: budget(30_000) },
              ),
            );
          } catch (err) {
            // Informational: exec APIs that wait for detached children hang
            // here; the processAlive check reports survival on restore.
            log('populate heartbeat failed', { level: 'warn', meta: { error: formatError(err) } });
          }
        })(),
        populateTimeout,
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

        // Mutate state AFTER the snapshot: overwrite payload and delete a
        // file. A point-in-time snapshot restores the pre-mutation state; a
        // live overlay would leak these mutations into the restore.
        isolationApplicable = sourceKept(compute);
        if (isolationApplicable) await step('mutate', () =>
          withTimeout(
            (async () => {
              await sandbox!.filesystem.writeFile(payloadFile, `MUTATED-${runId}`);
              await sandbox!.runCommand(`rm -f ${mutatedTarget}`);
            })(),
            createTimeout,
            'Mutation timed out',
          ),
        );

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
        checks = await step('verify', () =>
          withTimeout(
            (async (): Promise<Checks> => {
              const [payloadRes, largeRes, linkRes, tmpRes, execRes, isoDelRes, procRes, pkgRes] =
                await Promise.all([
                  restoredSandbox!.filesystem.readFile(payloadFile).catch(() => null),
                  restoredSandbox!.filesystem.readFile(largeFile).catch(() => null),
                  restoredSandbox!.filesystem.readFile(linkFile).catch(() => null),
                  restoredSandbox!.filesystem.readFile(tmpFile).catch(() => null),
                  restoredSandbox!.runCommand(`${runSh}`).catch(() => null),
                  restoredSandbox!.runCommand(`test -e ${mutatedTarget}; echo ISO:$?`).catch(() => null),
                  // A live heartbeat process keeps appending; a disk-only
                  // snapshot restores the file but the count stops growing.
                  restoredSandbox!.runCommand(`wc -l < ${heartbeatLog} 2>/dev/null; sleep 2; wc -l < ${heartbeatLog} 2>/dev/null`).catch(() => null),
                  restoredSandbox!.runCommand(`cd ${baseDir} && node -e "process.stdout.write(String(require('is-number')(42)))" 2>/dev/null`).catch(() => null),
                ]);

              const restoredPayload = payloadRes;
              const pkgOut = pkgRes?.stdout?.trim();
              const hbCounts = (procRes?.stdout ?? '')
                .split(/\s+/)
                .map((s) => parseInt(s, 10))
                .filter((n) => Number.isFinite(n));
              return {
                fileText: restoredPayload === payloadContent,
                fileLarge: largeRes === largeContent,
                executable: (execRes?.stdout ?? '').includes(`exec-ok-${runId}`),
                symlink: linkRes === payloadContent,
                tmpfs:
                  tmpfsPopulate === 'untested'
                    ? 'untested'
                    : tmpRes === `tmpfs-${runId}`,
                package:
                  packagePopulate === 'untested'
                    ? 'untested'
                    : pkgOut === 'true',
                processAlive: hbCounts.length >= 2 && hbCounts[hbCounts.length - 1] > hbCounts[0],
                isolationOverwrite: !isolationApplicable || restoredPayload !== null && restoredPayload !== `MUTATED-${runId}`,
                isolationDelete: !isolationApplicable || /\bISO:0\b/.test(isoDelRes?.stdout ?? ''),
              };
            })(),
            createTimeout,
            'Verify timed out',
          ),
        );
        verifyMs = performance.now() - verifyStart;
        verifyPassed = SCORED_CHECKS.every((k) => checks![k] === true);
        measure({ verifyMs, verifyPassed });

        if (!verifyPassed) {
          const failed = SCORED_CHECKS.filter((k) => checks![k] !== true).join(',');
          throw new Error(`Snapshot fidelity verification failed: ${failed}`);
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
    isolationApplicable,
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
    checks,
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

  log('fidelity workload completed', {
    level: 'info',
    meta,
  });

  return {
    data: { ...meta, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: snapshotSupported ? snapshotRestoreMs || snapshotCreateMs : populateMs,
  };
});

export const beforeExit = () => drainLateCleanups();
