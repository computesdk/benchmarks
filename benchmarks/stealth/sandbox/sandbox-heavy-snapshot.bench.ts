/**
 * Heavy snapshot benchmark: creates a sandbox, loads GBs of incompressible
 * data onto its disk plus a detached process holding ~1GB of dirty memory,
 * snapshots it (timed), takes the box down, restores from the snapshot after
 * a configurable downtime (timed), then re-verifies the whole payload
 * byte-for-byte and probes whether the memory-resident process survived.
 *
 * Motivation: long-horizon agent workloads accumulate heavy environments —
 * GBs of dependencies, browser installs, large file trees — and snapshot +
 * restore cost grows with that weight. This measures snapshot create and
 * restore time under a realistic multi-GB payload rather than a single
 * marker file (the marker-file variant is sandbox-snapshot's job).
 *
 * Payload model (in-guest, `dd` from /dev/urandom so snapshot backends
 * cannot compress the weight away):
 *   - `deps/`   — ~25% of BENCH_HEAVY_DISK_MB as 128KB files (the
 *                 "node_modules" analog: many small files)
 *   - `blobs/`  — ~75% as 64MB blobs (large binaries: browsers, toolchains)
 *   - `manifest.txt` — sha256 of every payload file, verified with
 *                 `sha256sum -c` on the restored box
 *   - a detached interpreter process (python3 > node > none) that allocates
 *     and dirties BENCH_HEAVY_MEM_MB of RAM and ticks a heartbeat file each
 *     second. After restore the beat is sampled twice; a still-advancing
 *     beat means the process — and its memory — survived the snapshot
 *     round trip. Rootfs-only snapshots legitimately lose it:
 *     `memoryPersisted` is recorded, not scored.
 *
 * Downtime model, box-identity rejection, source-intact check and capability
 * metadata are identical to sandbox-snapshot.
 *
 * Knobs: BENCH_HEAVY_DISK_MB (2048), BENCH_HEAVY_MEM_MB (1024),
 * BENCH_HEAVY_POPULATE_TIMEOUT_MS (15m), BENCH_HEAVY_RESTORE_TIMEOUT_MS
 * (15m), BENCH_DOWNTIME_MS.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/sandbox/sandbox-heavy-snapshot.bench.ts
 *   pnpm bench benchmarks/sandbox/sandbox-heavy-snapshot.bench.ts --provider e2b --iterations 1
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { reciprocalScoring } from '../src/util/scoring.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import {
  HEAVY_SNAPSHOT_CEILINGS_MS,
  SUITE_CONFIG,
  resolveHeavyDiskMb,
  resolveHeavyMemMb,
  resolveHeavyPopulateTimeoutMs,
  resolveHeavyRestoreTimeoutMs,
  writeHeavySnapshotLegacyResults,
} from './sandbox-heavy-snapshot.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import {
  CREATE_TIMEOUT_MS,
  DESTROY_TIMEOUT_MS,
  buildRestoreOptions,
  newRunId,
  resolveDowntimeMs,
  resolveSnapshotDir,
  SNAPSHOT_READY_TIMEOUT_MS,
  checkSourceIntact,
  SOURCE_STOPPED_CODE,
  startSourceHeartbeat,
  type SourceHeartbeat,
  waitForSnapshotReady,
  type SnapshotDirSource,
  snapshotCapabilityMeta,
  withSnapshotCreateOptions,
  type Compute,
  type SnapshotSandbox,
} from '../src/util/snapshot.js';
import { SNAPSHOT_MATRIX_SPEC, uploadSnapshotMatrix } from '../src/util/snapshot-matrix.js';


/** miosa's default SOMA runtime has no snapshots; firecracker does. */
const participants: ProviderConfig[] = providers.map((p) =>
  p.name === 'miosa' ? { ...p, sandboxOptions: { ...p.sandboxOptions, runtime: 'firecracker' } } : p,
);

/** Memory-dirty guest programs, tried in order; first available interpreter wins. */
const MEM_PROGRAMS: Record<string, { file: string; body: string }> = {
  python3: {
    file: 'heavy-mem.py',
    body: `import os, sys, time, hashlib
mb, beat = int(sys.argv[1]), sys.argv[2]
# Fresh entropy per chunk: repeating one block lets providers that
# compress/dedup pages snapshot far less memory than requested.
n = mb * 1024 * 1024
buf = bytearray(n)
for o in range(0, n, 65536):
    buf[o:o + 65536] = os.urandom(65536)
with open(beat + '.sha', 'w') as f:
    f.write(hashlib.sha256(buf).hexdigest())
i = 0
while True:
    with open(beat, 'w') as f:
        f.write(str(i))
    i += 1
    time.sleep(1)
`,
  },
  node: {
    file: 'heavy-mem.js',
    body: `const fs = require('fs'), crypto = require('crypto');
const mb = +process.argv[2], beat = process.argv[3];
const buf = Buffer.alloc(mb * 1024 * 1024);
// Fresh entropy per chunk (no shared block, see python variant).
for (let o = 0; o < buf.length; o += 65536) crypto.randomBytes(65536).copy(buf, o);
fs.writeFileSync(beat + '.sha', crypto.createHash('sha256').update(buf).digest('hex'));
let i = 0;
// The callback must capture buf — uncaptured module locals are collectible
// once the script finishes evaluating, which would free the payload.
setInterval(() => fs.writeFileSync(beat, String(i++) + ':' + buf.length), 1000);
`,
  },
};

interface HeavyPopulateResult {
  /** Interpreter backing the memory process; null when none was found. */
  memInterp: 'python3' | 'node' | null;
  /** Wall time for the memory buffer to be fully allocated (poll for .sha). */
  memReadyMs: number | null;
  /** MB actually requested from the guest process (clamped to guest RAM). */
  memMb: number;
}

/**
 * Writes the heavy payload entirely in-guest — streaming GBs through the
 * filesystem API would make populate latency measure the API, not the
 * snapshot. `dd` from /dev/urandom keeps the data incompressible.
 */
async function populateHeavy(
  sandbox: SnapshotSandbox,
  baseDir: string,
  diskMb: number,
  memMb: number,
  timeoutMs: number,
): Promise<HeavyPopulateResult> {
  const diskScript = [
    'set -eu',
    `D='${baseDir}'`,
    'mkdir -p "$D/deps" "$D/blobs"',
    // Many small files (deps analog): a quarter of the payload, 128KB each.
    `SMALL_MB=$(( ${diskMb} / 4 )); [ "$SMALL_MB" -lt 1 ] && SMALL_MB=1`,
    'i=0',
    'while [ $((i * 128)) -lt $((SMALL_MB * 1024)) ]; do',
    '  dd if=/dev/urandom of="$D/deps/file-$i.dat" bs=128k count=1 2>/dev/null',
    '  i=$((i + 1))',
    'done',
    // Large binaries: the rest, in <=64MB blobs.
    `BLOB_MB=$(( ${diskMb} - SMALL_MB ))`,
    'i=0; n=$(( (BLOB_MB + 63) / 64 ))',
    'while [ $i -lt $n ]; do',
    '  c=64; [ $((BLOB_MB - i * 64)) -lt 64 ] && c=$((BLOB_MB - i * 64))',
    '  dd if=/dev/urandom of="$D/blobs/blob-$i.dat" bs=1M count=$c 2>/dev/null',
    '  i=$((i + 1))',
    'done',
    'cd "$D" && find deps blobs -type f | sort | xargs sha256sum > manifest.txt',
    'echo populated',
  ].join('\n');
  const diskRes = await sandbox.runCommand(diskScript, { timeout: timeoutMs });
  if (diskRes.exitCode !== 0) {
    throw new Error(`heavy disk populate failed: ${JSON.stringify(diskRes)}`);
  }

  if (memMb <= 0) return { memInterp: null, memReadyMs: null, memMb: 0 };

  // Clamp the dirty target to what the guest can actually hold: providers
  // that size the box small (e.g. sandbox0's 128 MiB) must still run the
  // disk legs instead of failing allocation before 'unsupported' is scored.
  // Skip the memory leg below 64 MB of headroom rather than OOM the box.
  const memInfo = await sandbox.runCommand("awk '/MemTotal/{print int($2/1024)}' /proc/meminfo", {
    timeout: CREATE_TIMEOUT_MS,
  });
  const guestMemMb = Number((memInfo.stdout ?? '').trim());
  const effMemMb = Number.isFinite(guestMemMb) && guestMemMb > 0
    ? Math.min(memMb, Math.floor(guestMemMb * 0.6))
    : memMb;
  // Skip only when the guest can't hold a meaningful payload: an honored
  // small request (e.g. 32 MB on a big box) still runs the memory leg.
  if (effMemMb < Math.min(memMb, 64)) return { memInterp: null, memReadyMs: null, memMb: 0 };

  // Pick an interpreter for the memory-dirty process.
  let interp: 'python3' | 'node' | null = null;
  for (const candidate of Object.keys(MEM_PROGRAMS) as Array<'python3' | 'node'>) {
    const probe = await sandbox.runCommand(`command -v ${candidate}`, { timeout: CREATE_TIMEOUT_MS });
    if (probe.exitCode === 0) {
      interp = candidate;
      break;
    }
  }
  if (!interp) return { memInterp: null, memReadyMs: null, memMb: 0 };

  const program = MEM_PROGRAMS[interp];
  await sandbox.filesystem.writeFile(`${baseDir}/${program.file}`, program.body);
  const beat = `${baseDir}/membeat.txt`;
  const spawn =
    `S=; command -v setsid >/dev/null 2>&1 && S=setsid; ` +
    `$S nohup ${interp} '${baseDir}/${program.file}' ${effMemMb} '${beat}' ` +
    `>'${baseDir}/memproc.log' 2>&1 < /dev/null & ` +
    // The .sha file appears only after the whole buffer is allocated —
    // that's the "dirty memory resident" commit point for the snapshot.
    `i=0; while [ ! -f '${beat}.sha' ] && [ $i -lt ${Math.ceil(timeoutMs / 500)} ]; do sleep 0.5; i=$((i + 1)); done; ` +
    `[ -f '${beat}.sha' ] && echo ready || { echo alloc-timeout; cat '${baseDir}/memproc.log' 2>/dev/null; }`;
  const memStart = performance.now();
  const memRes = await sandbox.runCommand(spawn, { timeout: timeoutMs });
  const out = (memRes.stdout ?? '').trim();
  if (memRes.exitCode !== 0 || !out.startsWith('ready')) {
    throw new Error(`heavy memory populate failed: ${out || JSON.stringify(memRes)}`);
  }
  return { memInterp: interp, memReadyMs: performance.now() - memStart, memMb: effMemMb };
}

interface HeavyVerifyResult {
  allMatched: boolean;
  /** Payload files whose sha256 matched. */
  filesVerified: number;
  /** Payload files in the manifest. */
  fileCount: number;
  /** Did the detached memory process keep ticking after restore? null = untested. */
  memoryPersisted: boolean | null;
}

async function verifyHeavy(
  sandbox: SnapshotSandbox,
  baseDir: string,
  memInterp: 'python3' | 'node' | null,
  timeoutMs: number,
): Promise<HeavyVerifyResult> {
  const check = await sandbox.runCommand(
    `cd '${baseDir}' && out=$(sha256sum -c manifest.txt 2>/dev/null); ec=$?; ` +
      `ok=$(echo "$out" | grep -c ': OK$'); total=$(wc -l < manifest.txt 2>/dev/null || echo 0); ` +
      // Files present on disk the manifest no longer lists (truncated
      // manifest) must fail verification, not pass un-checked.
      `actual=$(find deps blobs -type f | wc -l); ` +
      `echo "exit=$ec ok=$ok total=$total actual=$actual"`,
    { timeout: timeoutMs },
  );
  const kv = Object.fromEntries(
    ((check.stdout ?? '').trim().split('\n').pop() ?? '').split(' ').map((p) => p.split('=')),
  );
  const fileCount = Number(kv.total) || 0;
  const filesVerified = Number(kv.ok) || 0;
  const filesPresent = Number(kv.actual) || 0;
  const allMatched =
    check.exitCode === 0 && kv.exit === '0' && filesVerified === fileCount && fileCount === filesPresent && fileCount > 0;

  let memoryPersisted: boolean | null = null;
  if (memInterp) {
    const beat = `${baseDir}/membeat.txt`;
    // Heartbeats are 'counter' (python) or 'counter:bytes' (node); the
    // counter field is what must advance.
    const probe =
      `pgrep -f '${baseDir}/${MEM_PROGRAMS[memInterp].file}' >/dev/null 2>&1 || exit 1; ` +
      `c1=$(cat '${beat}' 2>/dev/null); sleep 1.5; c2=$(cat '${beat}' 2>/dev/null); ` +
      `n1=\${c1%%:*}; n2=\${c2%%:*}; ` +
      `[ -n "$n1" ] && [ -n "$n2" ] && [ "$n2" -gt "$n1" ]`;
    const memProbe = await sandbox.runCommand(probe, { timeout: CREATE_TIMEOUT_MS }).catch(() => null);
    memoryPersisted = memProbe !== null && memProbe.exitCode === 0;
  }

  return {
    allMatched,
    filesVerified,
    // verifyDetail renders `filesVerified/(fileCount+1)` for the marker
    // model; fileCount-1 keeps the label honest here ("N/N files matched").
    fileCount: fileCount - 1,
    memoryPersisted,
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
  // (e.g. sandbox-heavy-snapshot-daily); the literals keep local runs working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-heavy-snapshot',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Heavy Snapshot',
  iterations: SUITE_CONFIG.defaultIterations,
  concurrency: 1,
  groupBy: 'round',
  participants,
  scoring: reciprocalScoring({
    metrics: [
      { key: 'createMs', unit: 'ms', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.createMs, weights: { median: 0.1, p95: 0, p99: 0 } },
      { key: 'snapshotCreateMs', unit: 'ms', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.snapshotCreateMs, weights: { median: 0.35, p95: 0, p99: 0 } },
      { key: 'snapshotRestoreMs', unit: 'ms', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.snapshotRestoreMs, weights: { median: 0.45, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.destroyMs, weights: { median: 0.1, p95: 0, p99: 0 } },
    ],
    // A provider without a verified heavy restore is not a successful run:
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
      { key: 'populate', label: 'Populate heavy payload', order: 1 },
      { key: 'snapshot-create', label: 'Create snapshot', order: 2 },
      { key: 'down', label: 'Take source down', order: 3 },
      { key: 'downtime', label: 'Downtime', order: 4 },
      { key: 'snapshot-restore', label: 'Restore from snapshot', order: 5 },
      { key: 'verify', label: 'Verify payload', order: 6 },
      { key: 'destroy-restored', label: 'Destroy restored box', order: 7 },
      { key: 'destroy', label: 'Destroy source', order: 8 },
      { key: 'snapshot-delete', label: 'Delete snapshot', order: 9 },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  onComplete: async (outcome) => {
    await writeHeavySnapshotLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('sandbox_heavy_snapshot'),
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
  const populateTimeout = resolveHeavyPopulateTimeoutMs();
  const restoreTimeout = resolveHeavyRestoreTimeoutMs();

  const runId = newRunId();
  const diskMb = resolveHeavyDiskMb();
  const memMb = resolveHeavyMemMb();
  const downtimeMs = resolveDowntimeMs();
  let baseDir: string | undefined;

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
  let memInterp: 'python3' | 'node' | null = null;
  let memReadyMs: number | null = null;
  /** memMb after clamping to guest MemTotal (0 when the leg was skipped). */
  let memMbEffective = 0;
  let memoryPersisted: boolean | null = null;
  let filesVerified: number | null = null;
  let fileCount: number | null = null;
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

    const populateStart = performance.now();
    await step('populate', () =>
      withTimeout(
        (async () => {
          const { dir: workdir, source } = await resolveSnapshotDir(sandbox!, compute, createTimeout, p.snapshotWorkdir);
          markerDirSource = source;
          baseDir = `${workdir}/bench-heavy-${runId}`;
          const res = await populateHeavy(sandbox!, baseDir, diskMb, memMb, populateTimeout);
          memInterp = res.memInterp;
          memReadyMs = res.memReadyMs;
          memMbEffective = res.memMb;
        })(),
        populateTimeout,
        'Heavy populate timed out',
      ),
    );
    populateMs = performance.now() - populateStart;
    const populateMeta: JsonObject = { populateMs, heavyDiskMb: diskMb, heavyMemMb: memMbEffective };
    if (memMbEffective !== memMb) populateMeta.heavyMemMbRequested = memMb;
    if (memReadyMs !== null) populateMeta.memReadyMs = memReadyMs;
    measure(populateMeta);

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
            populateTimeout,
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
            restoreTimeout,
            'Snapshot restore timed out',
            (s) => s.destroy(),
          ),
        );
        snapshotRestoreMs = performance.now() - restoreStart;
        measure({ snapshotRestoreMs });

        const verifyStart = performance.now();
        const verification = await step('verify', () =>
          withTimeout(
            verifyHeavy(restoredSandbox!, baseDir!, memInterp, populateTimeout),
            populateTimeout,
            'Verify timed out',
          ),
        );
        verifyMs = performance.now() - verifyStart;
        verifyPassed = verification.allMatched;
        memoryPersisted = verification.memoryPersisted;
        filesVerified = verification.filesVerified;
        fileCount = verification.fileCount;
        const verifyMeta: JsonObject = {
          verifyMs,
          verifyPassed,
          filesVerified,
          fileCount,
        };
        if (memoryPersisted !== null) verifyMeta.memoryPersisted = memoryPersisted;
        measure(verifyMeta);

        if (!verifyPassed) {
          throw new Error('Heavy snapshot verification failed: payload checksums did not survive restore');
        }
      } catch (err) {
        snapshotError = formatError(err);
        log('heavy snapshot lifecycle failed', { level: 'warn', meta: { error: snapshotError } });
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
    heavyDiskMb: diskMb,
    heavyMemMb: memInterp ? memMb : 0,
    memInterp: memInterp ?? null,
    memReadyMs,
    memoryPersisted,
    filesVerified,
    fileCount,
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
    throw new TaskError('heavy snapshot workload failed: ' + snapshotError, {
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

  log('heavy snapshot workload completed', {
    level: 'info',
    meta,
  });

  return {
    data: { ...meta, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: snapshotSupported ? snapshotRestoreMs || snapshotCreateMs : populateMs,
  };
});

export const beforeExit = () => drainLateCleanups();
