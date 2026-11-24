/**
 * Sandbox volumes lifecycle benchmark.
 *
 * Uniform lifecycle per iteration: create a volume → create a sandbox with the
 * volume mounted → data-plane probe (sequential dd throughput, small-file ops,
 * POSIX capabilities) → destroy the sandbox → mount the same volume on a NEW
 * sandbox → byte-verify. The reattach leg is the headline: it proves the
 * storage is independent of any one sandbox.
 *
 * Providers without a volume feature fail with code `volumes_not_supported` —
 * they still appear in the table as a capability record.
 *
 *   bench run benchmarks/stealth/sandbox/volumes.bench.ts --provider daytona,e2b
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key` (see tti.bench.ts).
 */
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { reciprocalScoring } from '../src/util/scoring.js';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { getVolumeAdapter, MOUNT_PATH } from './volumes-adapters.js';
import { NOW_NS_FN } from './shell-timing.js';
import type { VolumeAdapter, VolumeHandle } from './volumes-adapters.js';
import {
  parseStateVolumeNs as parseNs,
  stateVolumeDurationFields,
  stateVolumeMeasurements,
  stateVolumeRateFields,
} from './state-volume-metrics.js';

const CREATE_TIMEOUT_MS = 240_000;
const DATA_TIMEOUT_MS = 300_000;
// Pass a deadline to the SDK as well as the outer step timer. The router's
// buffered-command limit is 290 seconds; leave 10 seconds for the response.
const DATA_COMMAND_TIMEOUT_MS = 290_000;
const PROBE_TIMEOUT_MS = 60_000;
// Window inside mount-verify's probe budget for async mounts (in-VM agent,
// fuse setup) to register before recording realMount=0.
const MOUNT_DETECT_MS = 45_000;
// One hung probe (e.g. flock on a fuse mount) must not eat the whole step.
const PER_PROBE_TIMEOUT_MS = 15_000;
const DESTROY_TIMEOUT_MS = 30_000;
const VOLUME_TIMEOUT_MS = 120_000;

const SEQ_MB = 256;
const SMALL_FILES = 100;
const SMALL_FILE_KB = 64;

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-volumes',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Volumes',
  iterations: 2,
  concurrency: 1,
  participants: providers,
  display: {
    metrics: [
      { key: 'mountedReadyMs', label: 'Mounted create', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'reattachMs', label: 'Reattach', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'seqWriteMBps', label: 'Seq write', unit: 'MB/s', direction: 'higher-better' as const, decimals: 1 },
      { key: 'seqReadMBps', label: 'Seq read', unit: 'MB/s', direction: 'higher-better' as const, decimals: 1 },
      { key: 'smallFileOpsPerSec', label: 'Small files', unit: 'ops/s', direction: 'higher-better' as const, decimals: 1 },
      { key: 'volumeCreateMs', label: 'Volume create', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'verifyMs', label: 'Verify', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
    ],
    steps: [
      { key: 'volume-create', label: 'Create volume' },
      { key: 'create', label: 'Create sandbox + mount' },
      { key: 'mount-verify', label: 'Verify mount' },
      { key: 'seq-write', label: 'Sequential write (256MiB)' },
      { key: 'seq-read', label: 'Sequential read' },
      { key: 'small-files', label: 'Small files (100x64KiB)' },
      { key: 'posix-probes', label: 'POSIX probes' },
      { key: 'multi-attach', label: 'Second concurrent mount' },
      { key: 'destroy', label: 'Destroy sandbox' },
      { key: 'reattach', label: 'Reattach on new sandbox' },
      { key: 'verify', label: 'Byte-verify persisted data' },
      { key: 'volume-destroy', label: 'Destroy volume' },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  scoring: reciprocalScoring({
    // A successful lifecycle whose persisted data fails byte-verify still
    // counts as a failed record — storage that loses bytes isn't working.
    success: { requireData: { verifyPassed: 1 } },
    // Score = timing/throughput (weights sum to 1.0) × success rate — same
    // convention as the other sandbox benches.
    metrics: [
      { key: 'volumeCreateRawMs', unit: 'ms', ceiling: 8_000, weights: { median: 0.05, p95: 0, p99: 0 } },
      { key: 'mountedReadyRawMs', unit: 'ms', ceiling: 8_000, weights: { median: 0.10, p95: 0.05, p99: 0 } },
      { key: 'seqWriteRawMBps', unit: 'MB/s', ceiling: 500, floor: 1, higherIsBetter: true, weights: { median: 0.15, p95: 0, p99: 0 } },
      { key: 'seqReadRawMBps', unit: 'MB/s', ceiling: 1000, floor: 1, higherIsBetter: true, weights: { median: 0.10, p95: 0, p99: 0 } },
      { key: 'smallFileRawOpsPerSec', unit: 'ops/s', ceiling: 500, floor: 0.5, higherIsBetter: true, weights: { median: 0.15, p95: 0, p99: 0 } },
      { key: 'reattachRawMs', unit: 'ms', ceiling: 60_000, weights: { median: 0.25, p95: 0.10, p99: 0 } },
      { key: 'verifyRawMs', unit: 'ms', ceiling: 30_000, weights: { median: 0.05, p95: 0, p99: 0 } },
    ],
  }),
});

/**
 * Timed shell wrapper: prints `NS=<elapsed-nanoseconds>` for parsing and
 * propagates the wrapped command's exit code — without `exit $rc` a failed
 * dd would still print the marker and record throughput for a dead write.
 */
function timed(script: string): string {
  return `${NOW_NS_FN}; start=$(now_ns); ${script}; rc=$?; end=$(now_ns); echo "NS=$((end-start))"; exit $rc`;
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;
  const adapter: VolumeAdapter | undefined = getVolumeAdapter(participant.name);

  const data: Record<string, any> = {
    provider: participant.name,
    volumeSupported: Boolean(adapter),
    storageClass: adapter?.storageClass ?? null,
    mountStyle: adapter?.mountStyle ?? null,
  };

  if (!adapter) {
    throw new TaskError(`${participant.name}: no volume adapter`, {
      code: 'volumes_not_supported',
      data,
    });
  }
  const missingEnv = (adapter.requiredEnv ?? []).filter((name) => !process.env[name]);
  if (missingEnv.length > 0) {
    data.missingEnv = missingEnv;
    throw new TaskError(`${participant.name}: missing env ${missingEnv.join(', ')}`, {
      code: 'volumes_env_missing',
      data,
    });
  }

  const compute = participant.createCompute();
  // Unique per leg — shared disks (archil's ARCHIL_DISK_ID) must not let
  // concurrent legs on different refs erase each other's working dir.
  const runTag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const volumeName = `bench-vol-${runTag}`;
  const marker = `bench-${Date.now().toString(36)}`;
  // Some providers fix their mount root (archil: /mnt/archil in exec mode) —
  // write where the adapter says the volume actually lands.
  const mountPath = adapter.mountPath ?? MOUNT_PATH;
  const dir = `${mountPath}/bench-${runTag}`;

  let volume: VolumeHandle | undefined;
  let sandbox: any;
  let secondSandbox: any;
  let reattachSandbox: any;
  let bodyErr: unknown;

  try {
    const volumeCreateStart = performance.now();
    volume = await step('volume-create', () =>
      withTimeout(adapter.createVolume(volumeName, mountPath, compute), VOLUME_TIMEOUT_MS, 'Volume create timeout'),
    );
    Object.assign(data, stateVolumeDurationFields('volumeCreateMs', performance.now() - volumeCreateStart));
    data.volumeName = volume.name;

    const mounted = await step('create', () =>
      withTimeout(
        adapter.createMounted({
          compute,
          sandboxOptions: participant.sandboxOptions,
          mountPath,
          volume: volume!,
        }),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Sandbox create+mount timeout',
      ),
    );
    sandbox = mounted.sandbox;
    data.sandboxId = (sandbox as any)?.sandboxId ?? null;
    data.createMs = Math.round(mounted.createMs);
    data.mountMs = Math.round(mounted.mountMs);
    Object.assign(data, stateVolumeDurationFields('mountedReadyMs', mounted.createMs + mounted.mountMs));

    data.realMount = await step('mount-verify', () =>
      withTimeout(
        (async () => {
          // A kernel mount is a capability dimension, not a leg-killer:
          // sync/agent-backed volumes (beam, modal, createos)
          // persist files at mountPath without registering a mount —
          // zeroing them lies about storage that works, and the posix
          // probes already show which semantics a non-mount lacks
          // (flock, rename atomicity). Record realMount 1/0 and continue;
          // the marker write/read stays the hard gate.
          //
          // Detect BEFORE writing the marker: mounts land asynchronously on
          // several providers (in-VM agents, fuse setup), and a marker
          // written to the plain dir gets shadowed when the fs mounts on
          // top — reattach then can't read it and a working volume fails
          // byte verification. Poll detection first so the marker always
          // lands on whatever is mounted at the end of the window.
          // mountpoint(8) → /proc/mounts → df device boundary vs the parent
          // dir (vs `/` would accept ANY non-rootfs parent mount, e.g. a
          // tmpfs /mnt). On expiry, dump the mount table tail so the log
          // shows "mounted elsewhere" vs "not a mount at all".
          const check =
            `mountpoint -q ${mountPath} 2>/dev/null ` +
            `|| grep -qs ' ${mountPath} ' /proc/mounts ` +
            `|| [ "$(df -P ${mountPath} | awk 'NR==2{print $1}')" != "$(df -P ${mountPath}/.. | awk 'NR==2{print $1}')" ]`;
          const detectDeadline = Date.now() + MOUNT_DETECT_MS;
          let mounted = false;
          do {
            mounted = (await sandbox.runCommand(check)).exitCode === 0;
            if (!mounted) await new Promise((r) => setTimeout(r, 2_000));
          } while (!mounted && Date.now() < detectDeadline);
          if (!mounted) {
            const t = await sandbox.runCommand(
              `awk '{print $2}' /proc/mounts 2>/dev/null | tail -4 | tr '\\n' ' '`,
            );
            log('mount-verify: storage present, not a kernel mount', {
              level: 'warn',
              meta: { mounts: (t.stdout || '').trim() },
            });
          }
          const w = await sandbox.runCommand(
            `mkdir -p ${dir} && echo -n ${marker} > ${dir}/marker.txt && cat ${dir}/marker.txt`,
          );
          if (w.exitCode !== 0 || !w.stdout.includes(marker)) {
            throw new Error(`mount write/read probe failed: ${w.stderr || w.stdout}`);
          }
          return mounted ? 1 : 0;
        })(),
        PROBE_TIMEOUT_MS,
        'Mount verify timeout',
      ),
    );

    const writeNs = await step('seq-write', () =>
      withTimeout(
        (async () => {
          // head -c + sync, not dd: some providers' storage policies block
          // the dd binary outright (403 "command blocked (storage access): dd")
          // while ordinary byte writes are allowed — the probe measures
          // sequential write throughput, not dd availability.
          const r = await sandbox.runCommand(
            timed(`head -c ${SEQ_MB * 1048576} /dev/zero > ${dir}/seq.bin && sync`),
            { timeout: DATA_COMMAND_TIMEOUT_MS },
          );
          if (r.exitCode !== 0) throw new Error(`seq write failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Sequential write timeout',
      ),
    );
    Object.assign(data, stateVolumeRateFields('seqWriteMBps', SEQ_MB, writeNs));

    const readNs = await step('seq-read', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(`cat ${dir}/seq.bin > /dev/null`),
            { timeout: DATA_COMMAND_TIMEOUT_MS },
          );
          if (r.exitCode !== 0) throw new Error(`seq read failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Sequential read timeout',
      ),
    );
    Object.assign(data, stateVolumeRateFields('seqReadMBps', SEQ_MB, readNs));

    const smallNs = await step('small-files', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(
              // Per-file fsync like rootfs — one trailing sync would score
              // buffered writes, not what a small-file op costs on the mount.
              `mkdir -p ${dir}/small && cd ${dir}/small && for i in $(seq 1 ${SMALL_FILES}); do head -c ${SMALL_FILE_KB * 1024} /dev/zero > f$i && (command -v fsync >/dev/null 2>&1 && fsync f$i || sync) || exit 1; done`,
            ),
            { timeout: DATA_COMMAND_TIMEOUT_MS },
          );
          if (r.exitCode !== 0) throw new Error(`small files failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Small files timeout',
      ),
    );
    Object.assign(data, stateVolumeRateFields('smallFileOpsPerSec', SMALL_FILES, smallNs));

    data.posix = await step('posix-probes', () =>
      withTimeout(
        (async () => {
          // Each probe is its own command with its own timeout — a hanging
          // op (flock on network fuse is the classic) records 0 instead of
          // timing out the whole step and zeroing the leg.
          const probes: Array<[string, string]> = [
            // append: S3-mounted volumes often can't
            ['append', `echo -n x >> ${dir}/marker.txt && [ "$(cat ${dir}/marker.txt)" = "${marker}x" ] && echo "append=1" || echo "append=0"`],
            ['rename', `mv ${dir}/marker.txt ${dir}/marker2.txt && echo "rename=1" || echo "rename=0"`],
            ['symlink', `ln -s ${dir}/marker2.txt ${dir}/link.txt 2>/dev/null && [ -L ${dir}/link.txt ] && echo "symlink=1" || echo "symlink=0"`],
            ['chmod', `chmod 600 ${dir}/marker2.txt 2>/dev/null && [ "$(stat -c%a ${dir}/marker2.txt 2>/dev/null || stat -f%Lp ${dir}/marker2.txt)" = "600" ] && echo "chmod=1" || echo "chmod=0"`],
            ['flock', `command -v flock >/dev/null && flock -n ${dir}/marker2.txt -c true 2>/dev/null && echo "flock=1" || echo "flock=0"`],
          ];
          const result: Record<string, number> = {};
          for (const [key, cmd] of probes) {
            try {
              const pr = await withTimeout(
                sandbox.runCommand(cmd),
                PER_PROBE_TIMEOUT_MS,
                `${key} probe timeout`,
              );
              result[key] = ((pr as any).stdout ?? '').includes(`${key}=1`) ? 1 : 0;
            } catch {
              result[key] = 0;
            }
          }
          // Content manifest for the byte-verify leg: a size/count check
          // can't see silent corruption on object-backed volumes. The verify
          // step falls back to markers when this is missing.
          try {
            const mr = await withTimeout(
              sandbox.runCommand(`sha256sum ${dir}/seq.bin ${dir}/small/* | sha256sum | cut -d' ' -f1`),
              PROBE_TIMEOUT_MS,
              'manifest timeout',
            );
            data.manifestSha = ((mr as any).stdout ?? '').match(/[0-9a-f]{64}/)?.[0] ?? null;
          } catch {
            data.manifestSha = null;
          }
          return result;
        })(),
        // Inner timers bound the worst case; pad so the outer deadline never
        // races the manifest's own catch.
        PER_PROBE_TIMEOUT_MS * 5 + PROBE_TIMEOUT_MS + 15_000,
        'POSIX probes timeout',
      ),
    );

    // RWX probe: same volume on a second live sandbox.
    data.multiAttach = await step('multi-attach', () =>
      withTimeout(
        (async () => {
          try {
            const m2 = await adapter.createMounted({
              compute,
              sandboxOptions: participant.sandboxOptions,
              mountPath,
              volume: volume!,
            });
            secondSandbox = m2.sandbox;
            // marker2.txt only exists when the rename probe succeeded —
            // fall back like verify does so a probe timeout can't downgrade
            // a readable mount to 'mounted'.
            const r = await secondSandbox.runCommand(`cat ${dir}/marker2.txt 2>/dev/null || cat ${dir}/marker.txt`);
            const readable = r.exitCode === 0 && r.stdout.includes(marker);
            return readable ? 'rw' : 'mounted';
          } catch (err) {
            log('multi-attach failed', { level: 'warn', meta: { error: formatError(err) } });
            return 'no';
          }
        })(),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Multi-attach timeout',
      ),
    );

    await step('destroy', () =>
      withTimeout(
        Promise.all([
          sandbox.destroy(),
          secondSandbox ? secondSandbox.destroy() : Promise.resolve(),
        ]),
        participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS,
        'Destroy timeout',
      ),
    );
    // Cleared so the finally block doesn't retry destroyed sandboxes.
    sandbox = undefined;
    secondSandbox = undefined;

    const remounted = await step('reattach', () =>
      withTimeout(
        adapter.createMounted({
          compute,
          sandboxOptions: participant.sandboxOptions,
          mountPath,
          volume: volume!,
        }),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Reattach timeout',
      ),
    );
    reattachSandbox = remounted.sandbox;
    Object.assign(data, stateVolumeDurationFields('reattachMs', remounted.createMs + remounted.mountMs));

    const verifyStart = performance.now();
    data.verifyPassed = await step('verify', () =>
      withTimeout(
        (async () => {
          // marker2.txt only exists when the rename probe succeeded and only
          // carries the trailing x when append worked — both are optional
          // capabilities, so persistence verify must not depend on them.
          // marker files are written with `echo -n` — no trailing newline,
          // so cat's output would join the sha line. `; echo` forces the
          // separator; the third line re-checks the small-file count so a
          // file lost before manifest capture can't hash-verify clean.
          const r = await reattachSandbox.runCommand(
            `(cat ${dir}/marker2.txt 2>/dev/null || cat ${dir}/marker.txt; echo); sha256sum ${dir}/seq.bin ${dir}/small/* | sha256sum | cut -d' ' -f1; ls ${dir}/small | wc -l; stat -c%s ${dir}/seq.bin 2>/dev/null || echo 0`,
            { timeout: DATA_COMMAND_TIMEOUT_MS },
          );
          const lines = (r.stdout ?? '').trim().split('\n');
          const markerOk = (lines[0] ?? '').startsWith(marker);
          // manifestSha is null when hashing timed out — skip the digest
          // check rather than fail an intact volume (marker+count still gate).
          const shaOk = data.manifestSha == null || lines[1] === data.manifestSha;
          const countOk = Number(lines[2]) === SMALL_FILES;
          // stat is cheap even on congested fs — a missing or truncated
          // seq.bin can't sneak past while the digest check is skipped.
          const seqOk = Number(lines[3]) === SEQ_MB * 1048576;
          const ok = r.exitCode === 0 && markerOk && shaOk && countOk && seqOk;
          if (!ok) {
            log('verify mismatch', {
              level: 'error',
              meta: {
                exitCode: r.exitCode,
                stdout: r.stdout,
                stderr: r.stderr,
                expectedSha: data.manifestSha,
              },
            });
          }
          return ok ? 1 : 0;
        })(),
        DATA_TIMEOUT_MS,
        'Verify timeout',
      ),
    );

    Object.assign(data, stateVolumeDurationFields('verifyMs', performance.now() - verifyStart));
  } catch (err) {
    bodyErr = err;
    throw err;
  } finally {
    // Free the volume while a mount is still live — shared disks (archil)
    // are never destroyed, so leftover bench data must not accumulate.
    // Runs on every exit (early failures leave partial files too) and lives
    // outside verifyMs so deletion speed isn't scored as verify time.
    for (const s of [reattachSandbox, secondSandbox, sandbox]) {
      if (s) {
        await s.runCommand(`rm -rf ${dir}`).catch(() => {});
        break;
      }
    }
    // Sandboxes from a failed step still run — leaked boxes keep billing and
    // hold the volume open, which can block its deletion below.
    for (const s of [sandbox, secondSandbox, reattachSandbox]) {
      if (!s) continue;
      // Bounded like the destroy step — a stalled destroy must not hang
      // cleanup (and the volume delete that follows).
      await withTimeout(
        s.destroy() as Promise<unknown>,
        participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS,
        'Cleanup destroy timeout',
      ).catch((err: unknown) =>
        log('sandbox destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
    }
    if (volume) {
      try {
        await step('volume-destroy', () =>
          withTimeout(adapter.destroyVolume(volume!, compute), VOLUME_TIMEOUT_MS, 'Volume destroy timeout'),
        );
      } catch (err) {
        // A failed destroy leaks the volume — a provider scoring 100% while
        // leaking every volume is a lie. Fail the task unless it already
        // failed earlier (don't mask the primary error).
        if (bodyErr === undefined) throw err;
        log('volume destroy failed', { level: 'warn', meta: { error: formatError(err) } });
      }
    }
  }

  // v1 continues using the same rounded keys. Full-precision companion data
  // is returned for a future, separately versioned methodology; it is unscored.
  measure(stateVolumeMeasurements(data));

  return { data };
});
