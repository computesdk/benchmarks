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
 *   bench run benchmarks/sandbox/volumes.bench.ts --provider daytona,e2b
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key` (see tti.bench.ts).
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { getVolumeAdapter, MOUNT_PATH } from './volumes-adapters.js';
import type { VolumeAdapter, VolumeHandle } from './volumes-adapters.js';

const CREATE_TIMEOUT_MS = 240_000;
const DATA_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 60_000;
const DESTROY_TIMEOUT_MS = 30_000;
const VOLUME_TIMEOUT_MS = 120_000;

const SEQ_MB = 256;
const SMALL_FILES = 100;
const SMALL_FILE_KB = 64;

export const config = defineBenchmarkConfig({
  benchmarkSlug: `sandbox-volumes${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Sandbox Volumes${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  iterations: 2,
  concurrency: 1,
  participants: providers,
  display: {
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
  // Score = timing (weights sum to 1.0) × success rate — same convention as
  // the other sandbox benches. Throughput metrics score higher-is-better.
  onScore: (lowerIsBetter, higherIsBetter) => ({
    metrics: [
      lowerIsBetter('volumeCreateMs', {
        unit: 'ms',
        ceiling: 60_000,
        value: (record) => Number(record.data?.volumeCreateMs) || 0,
        weights: { median: 0.05, p95: 0, p99: 0 },
      }),
      lowerIsBetter('mountedReadyMs', {
        unit: 'ms',
        ceiling: 120_000,
        value: (record) => Number(record.data?.mountedReadyMs) || 0,
        weights: { median: 0.10, p95: 0.05, p99: 0 },
      }),
      higherIsBetter('seqWriteMBps', {
        unit: 'MB/s',
        ceiling: 500,
        floor: 1,
        value: (record) => Number(record.data?.seqWriteMBps) || 0,
        weights: { median: 0.15, p95: 0, p99: 0 },
      }),
      higherIsBetter('seqReadMBps', {
        unit: 'MB/s',
        ceiling: 1000,
        floor: 1,
        value: (record) => Number(record.data?.seqReadMBps) || 0,
        weights: { median: 0.10, p95: 0, p99: 0 },
      }),
      higherIsBetter('smallFileOpsPerSec', {
        unit: 'ops/s',
        ceiling: 500,
        floor: 0.5,
        value: (record) => Number(record.data?.smallFileOpsPerSec) || 0,
        weights: { median: 0.15, p95: 0, p99: 0 },
      }),
      lowerIsBetter('reattachMs', {
        unit: 'ms',
        ceiling: 120_000,
        value: (record) => Number(record.data?.reattachMs) || 0,
        weights: { median: 0.25, p95: 0.10, p99: 0 },
      }),
      lowerIsBetter('verifyMs', {
        unit: 'ms',
        ceiling: 60_000,
        value: (record) => Number(record.data?.verifyMs) || 0,
        weights: { median: 0.05, p95: 0, p99: 0 },
      }),
    ],
  }),
});

/** Timed shell wrapper: prints `NS=<elapsed-nanoseconds>` for parsing. */
function timed(script: string): string {
  return `start=$(date +%s%N); ${script}; end=$(date +%s%N); echo "NS=$((end-start))"`;
}

function parseNs(stdout: string): number {
  const m = stdout.match(/NS=(\d+)/);
  if (!m) throw new Error(`missing NS marker in output: ${stdout.slice(0, 200)}`);
  return Number(m[1]);
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
  const volumeName = `bench-vol-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = `bench-${Date.now().toString(36)}`;
  const dir = `${MOUNT_PATH}/bench`;

  let volume: VolumeHandle | undefined;
  let sandbox: any;
  let secondSandbox: any;
  let reattachSandbox: any;

  try {
    const volumeCreateStart = performance.now();
    volume = await step('volume-create', () =>
      withTimeout(adapter.createVolume(volumeName, MOUNT_PATH), VOLUME_TIMEOUT_MS, 'Volume create timeout'),
    );
    data.volumeCreateMs = Math.round(performance.now() - volumeCreateStart);
    data.volumeName = volume.name;

    const mounted = await step('create', () =>
      withTimeout(
        adapter.createMounted({
          compute,
          sandboxOptions: participant.sandboxOptions,
          mountPath: MOUNT_PATH,
          volume: volume!,
        }),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Sandbox create+mount timeout',
      ),
    );
    sandbox = mounted.sandbox;
    data.createMs = Math.round(mounted.createMs);
    data.mountMs = Math.round(mounted.mountMs);
    data.mountedReadyMs = Math.round(mounted.createMs + mounted.mountMs);

    await step('mount-verify', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            `mkdir -p ${dir} && echo -n ${marker} > ${dir}/marker.txt && cat ${dir}/marker.txt`,
          );
          if (r.exitCode !== 0 || !r.stdout.includes(marker)) {
            throw new Error(`mount write/read probe failed: ${r.stderr || r.stdout}`);
          }
        })(),
        PROBE_TIMEOUT_MS,
        'Mount verify timeout',
      ),
    );

    const writeNs = await step('seq-write', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(`dd if=/dev/zero of=${dir}/seq.bin bs=1M count=${SEQ_MB} conv=fsync 2>/dev/null`),
          );
          if (r.exitCode !== 0) throw new Error(`dd write failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Sequential write timeout',
      ),
    );
    data.seqWriteMBps = Math.round(((SEQ_MB * 1048576) / (writeNs / 1e9) / 1048576) * 10) / 10;

    const readNs = await step('seq-read', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(`dd if=${dir}/seq.bin of=/dev/null bs=1M 2>/dev/null`),
          );
          if (r.exitCode !== 0) throw new Error(`dd read failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Sequential read timeout',
      ),
    );
    data.seqReadMBps = Math.round(((SEQ_MB * 1048576) / (readNs / 1e9) / 1048576) * 10) / 10;

    const smallNs = await step('small-files', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(
              `mkdir -p ${dir}/small && cd ${dir}/small && for i in $(seq 1 ${SMALL_FILES}); do dd if=/dev/zero of=f$i bs=${SMALL_FILE_KB}k count=1 conv=fsync 2>/dev/null; done`,
            ),
          );
          if (r.exitCode !== 0) throw new Error(`small files failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Small files timeout',
      ),
    );
    data.smallFileOpsPerSec = Math.round((SMALL_FILES / (smallNs / 1e9)) * 10) / 10;

    data.posix = await step('posix-probes', () =>
      withTimeout(
        (async () => {
          const probes = [
            // append: S3-mounted volumes often can't
            `echo -n x >> ${dir}/marker.txt && [ "$(cat ${dir}/marker.txt)" = "${marker}x" ] && echo "append=1" || echo "append=0"`,
            `mv ${dir}/marker.txt ${dir}/marker2.txt && echo "rename=1" || echo "rename=0"`,
            `ln -s ${dir}/marker2.txt ${dir}/link.txt 2>/dev/null && [ -L ${dir}/link.txt ] && echo "symlink=1" || echo "symlink=0"`,
            `chmod 600 ${dir}/marker2.txt 2>/dev/null && [ "$(stat -c%a ${dir}/marker2.txt 2>/dev/null || stat -f%Lp ${dir}/marker2.txt)" = "600" ] && echo "chmod=1" || echo "chmod=0"`,
            `command -v flock >/dev/null && flock -n ${dir}/marker2.txt -c true 2>/dev/null && echo "flock=1" || echo "flock=0"`,
          ];
          const r = await sandbox.runCommand(probes.join('; '));
          const out = r.stdout ?? '';
          const flag = (k: string) => (out.includes(`${k}=1`) ? 1 : 0);
          return {
            append: flag('append'),
            rename: flag('rename'),
            symlink: flag('symlink'),
            chmod: flag('chmod'),
            flock: flag('flock'),
          };
        })(),
        PROBE_TIMEOUT_MS,
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
              mountPath: MOUNT_PATH,
              volume: volume!,
            });
            secondSandbox = m2.sandbox;
            const r = await secondSandbox.runCommand(`cat ${dir}/marker2.txt`);
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

    const remounted = await step('reattach', () =>
      withTimeout(
        adapter.createMounted({
          compute,
          sandboxOptions: participant.sandboxOptions,
          mountPath: MOUNT_PATH,
          volume: volume!,
        }),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Reattach timeout',
      ),
    );
    reattachSandbox = remounted.sandbox;
    data.reattachMs = Math.round(remounted.createMs + remounted.mountMs);

    const verifyStart = performance.now();
    data.verifyPassed = await step('verify', () =>
      withTimeout(
        (async () => {
          const r = await reattachSandbox.runCommand(
            `cat ${dir}/marker2.txt && wc -c < ${dir}/seq.bin && ls ${dir}/small | wc -l`,
          );
          const lines = (r.stdout ?? '').trim().split('\n');
          const markerOk = lines[0]?.includes(marker + 'x') ?? false; // append probe mutated it
          const bytes = Number(lines[1]);
          const files = Number(lines[2]);
          const ok =
            r.exitCode === 0 &&
            markerOk &&
            bytes === SEQ_MB * 1048576 &&
            files === SMALL_FILES;
          if (!ok) {
            log('verify mismatch', {
              level: 'error',
              meta: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
            });
          }
          return ok ? 1 : 0;
        })(),
        DATA_TIMEOUT_MS,
        'Verify timeout',
      ),
    );
    data.verifyMs = Math.round(performance.now() - verifyStart);
  } finally {
    if (reattachSandbox) {
      await reattachSandbox.destroy().catch((err: unknown) =>
        log('reattach sandbox destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
    }
    if (sandbox) {
      log('sandbox', { level: 'info', meta: { provider: participant.name, sandboxId: sandboxId(sandbox) } });
    }
    if (volume) {
      await step('volume-destroy', () =>
        withTimeout(adapter.destroyVolume(volume!), VOLUME_TIMEOUT_MS, 'Volume destroy timeout'),
      ).catch((err: unknown) =>
        log('volume destroy failed', { level: 'warn', meta: { error: formatError(err) } }),
      );
    }
  }

  measure({
    latencyMs: Number(data.mountedReadyMs) || 0,
    volumeCreateMs: Number(data.volumeCreateMs) || 0,
    mountedReadyMs: Number(data.mountedReadyMs) || 0,
    seqWriteMBps: Number(data.seqWriteMBps) || 0,
    seqReadMBps: Number(data.seqReadMBps) || 0,
    smallFileOpsPerSec: Number(data.smallFileOpsPerSec) || 0,
    reattachMs: Number(data.reattachMs) || 0,
    verifyMs: Number(data.verifyMs) || 0,
  });

  return { data };
});
