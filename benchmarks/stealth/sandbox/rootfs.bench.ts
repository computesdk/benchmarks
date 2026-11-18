/**
 * Sandbox rootfs IO benchmark.
 *
 * The sandbox-volumes data plane run against the provider's ROOT disk — no
 * volume involved. Uniform lifecycle per iteration: create a sandbox →
 * write/read probe → sequential dd throughput → small-file ops → POSIX
 * capability probes → destroy. Every provider participates: every sandbox
 * has a root disk, so there are no adapters and no capability-matrix skips.
 *
 * Metric names match sandbox-volumes where they overlap (seqWriteMBps,
 * seqReadMBps, smallFileOpsPerSec) so results compare directly: for a
 * provider, `sandbox-rootfs` is the baseline and `sandbox-volumes` is what
 * mounting a real volume costs (or buys).
 *
 *   bench run benchmarks/stealth/sandbox/rootfs.bench.ts --provider daytona,e2b
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key` (see tti.bench.ts).
 */
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { continuousScoring } from './performance-runtime-scoring.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import { NOW_NS_FN } from './shell-timing.js';
import type { ProviderConfig } from './types.js';

const CREATE_TIMEOUT_MS = 240_000;
const DATA_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 60_000;
const DESTROY_TIMEOUT_MS = 30_000;

const SEQ_MB = 256;
const SMALL_FILES = 100;
const SMALL_FILE_KB = 64;

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-rootfs',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Rootfs',
  iterations: 2,
  concurrency: 1,
  participants: providers,
  display: {
    metrics: [
      { key: 'createMs', label: 'Sandbox create', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'seqWriteMBps', label: 'Seq write', unit: 'MB/s', direction: 'higher-better' as const, decimals: 1 },
      { key: 'seqReadMBps', label: 'Seq read', unit: 'MB/s', direction: 'higher-better' as const, decimals: 1 },
      { key: 'smallFileOpsPerSec', label: 'Small files', unit: 'ops/s', direction: 'higher-better' as const, decimals: 1 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'write-verify', label: 'Write/read probe' },
      { key: 'seq-write', label: 'Sequential write (256MiB)' },
      { key: 'seq-read', label: 'Sequential read' },
      { key: 'small-files', label: 'Small files (100x64KiB)' },
      { key: 'posix-probes', label: 'POSIX probes' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  scoring: continuousScoring({
    // Score = timing/throughput (weights sum to 1.0) × success rate — same
    // convention as the other sandbox benches. destroyPassed gates success:
    // a sandbox that fails to destroy leaked infra — the iteration keeps its
    // measured IO medians (metrics sample regardless) but is not a clean run.
    success: { requireData: { destroyPassed: 1 } },
    metrics: [
      { key: 'createMs', unit: 'ms', ceiling: 4_000, weights: { median: 0.10, p95: 0.05, p99: 0 } },
      { key: 'seqWriteMBps', unit: 'MB/s', ceiling: 500, floor: 1, higherIsBetter: true, weights: { median: 0.30, p95: 0, p99: 0 } },
      { key: 'seqReadMBps', unit: 'MB/s', ceiling: 1000, floor: 1, higherIsBetter: true, weights: { median: 0.25, p95: 0, p99: 0 } },
      { key: 'smallFileOpsPerSec', unit: 'ops/s', ceiling: 500, floor: 0.5, higherIsBetter: true, weights: { median: 0.25, p95: 0, p99: 0 } },
      { key: 'destroyMs', unit: 'ms', ceiling: 3_000, weights: { median: 0.05, p95: 0, p99: 0 } },
    ],
  }, { createMs: 4000, seqWriteMBps: 500, seqReadMBps: 1000, smallFileOpsPerSec: 500, destroyMs: 3000 }),
});

/** Timed shell wrapper: prints `NS=<elapsed-nanoseconds>` for parsing. */
function timed(script: string): string {
  // Propagate the inner command's exit code — ending on `echo` would mask a
  // failed write and record throughput for a write that never happened.
  return `${NOW_NS_FN}; start=$(now_ns); ${script}; rc=$?; end=$(now_ns); echo "NS=$((end-start))"; exit $rc`;
}

// dd is deliberately avoided: some providers' exec gateways block the `dd`
// name outright (403 "storage access"). `head -c` streams the
// same bytes and is portable everywhere. Flush each write the way
// `conv=fsync` would: util-linux `fsync` when present, `sync` otherwise.
const FSYNC = `((command -v fsync >/dev/null 2>&1 && fsync "$f") || sync)`;
function zeroFill(path: string, bytes: number): string {
  return `f=${path} && head -c ${bytes} /dev/zero > "$f" && ${FSYNC}`;
}

function parseNs(stdout: string): number {
  const m = stdout.match(/NS=(\d+)/);
  if (!m) throw new Error(`missing NS marker in output: ${stdout.slice(0, 200)}`);
  const ns = Number(m[1]);
  if (!Number.isFinite(ns) || ns <= 0) throw new Error('invalid nonpositive or nonfinite NS duration');
  return ns;
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;

  const data: Record<string, any> = {
    provider: participant.name,
  };

  const compute = participant.createCompute();
  // Write under the login user's home dir — the provider's root disk. Deliberately
  // not /tmp: on several providers /tmp is a tmpfs RAM disk, which would measure
  // memory bandwidth instead of storage.
  const dir = 'bench-rootfs';
  const marker = `bench-${Date.now().toString(36)}`;

  let sandbox: any;

  try {
    const createStart = performance.now();
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create(participant.sandboxOptions ?? {}),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Sandbox create timeout',
        (s: any) => s.destroy(),
      ),
    );
    data.createMs = performance.now() - createStart;
    data.sandboxId = sandbox.sandboxId ?? null;

    await step('write-verify', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            `mkdir -p ${dir} && echo -n ${marker} > ${dir}/marker.txt && cat ${dir}/marker.txt`,
          );
          if (r.exitCode !== 0 || !r.stdout.includes(marker)) {
            throw new Error(`rootfs write/read probe failed: ${r.stderr || r.stdout}`);
          }
        })(),
        PROBE_TIMEOUT_MS,
        'Write probe timeout',
      ),
    );

    const writeNs = await step('seq-write', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(zeroFill(`${dir}/seq.bin`, SEQ_MB * 1048576)),
          );
          if (r.exitCode !== 0) throw new Error(`seq write failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Sequential write timeout',
      ),
    );
    data.seqWriteMBps = SEQ_MB / (writeNs / 1e9);

    const readNs = await step('seq-read', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(`cat ${dir}/seq.bin > /dev/null`),
          );
          if (r.exitCode !== 0) throw new Error(`seq read failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Sequential read timeout',
      ),
    );
    data.seqReadMBps = SEQ_MB / (readNs / 1e9);

    const smallNs = await step('small-files', () =>
      withTimeout(
        (async () => {
          const r = await sandbox.runCommand(
            timed(
              `mkdir -p ${dir}/small && cd ${dir}/small && for i in $(seq 1 ${SMALL_FILES}); do ${zeroFill('f$i', SMALL_FILE_KB * 1024)} || exit 1; done`,
            ),
          );
          if (r.exitCode !== 0) throw new Error(`small files failed: ${r.stderr}`);
          return parseNs(r.stdout);
        })(),
        DATA_TIMEOUT_MS,
        'Small files timeout',
      ),
    );
    data.smallFileOpsPerSec = SMALL_FILES / (smallNs / 1e9);

    data.posix = await step('posix-probes', () =>
      withTimeout(
        (async () => {
          const probes = [
            `echo -n x >> ${dir}/marker.txt && [ "$(cat ${dir}/marker.txt)" = "${marker}x" ] && echo "append=1" || echo "append=0"`,
            `mv ${dir}/marker.txt ${dir}/marker2.txt && echo "rename=1" || echo "rename=0"`,
            // Same-dir relative target: bench-rootfs is itself relative, so
            // `ln -s ${dir}/marker2.txt` would resolve to dir/dir/marker2.txt.
            // -e (not -L): the link must resolve — a dangling symlink still
            // passes -L on filesystems where rename didn't produce marker2.
            `ln -s marker2.txt ${dir}/link.txt 2>/dev/null && [ -e ${dir}/link.txt ] && echo "symlink=1" || echo "symlink=0"`,
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
  } finally {
    if (sandbox) {
      const destroyStart = performance.now();
      try {
        await step('destroy', () =>
          withTimeout(
            sandbox.destroy(),
            participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS,
            'Destroy timeout',
          ),
        );
        data.destroyMs = performance.now() - destroyStart;
        data.destroyPassed = 1;
      } catch (err) {
        // A failed destroy is not a latency datapoint — flag it and keep
        // destroyMs out of the measured metrics (a fast-rejecting destroy
        // would otherwise score near-perfect). destroyPassed gates the
        // success flag so a leaked sandbox never counts as a clean run.
        data.destroyFailed = 1;
        data.destroyPassed = 0;
        log('sandbox destroy failed', { level: 'warn', meta: { error: formatError(err) } });
      }
      log('sandbox', { level: 'info', meta: { provider: participant.name, sandboxId: (sandbox as any)?.sandboxId ?? null } });
    }
  }

  measure({
    latencyMs: Number(data.createMs) || 0,
    createMs: Number(data.createMs) || 0,
    seqWriteMBps: Number(data.seqWriteMBps) || 0,
    seqReadMBps: Number(data.seqReadMBps) || 0,
    smallFileOpsPerSec: Number(data.smallFileOpsPerSec) || 0,
    ...(data.destroyMs !== undefined ? { destroyMs: Number(data.destroyMs) } : {}),
  });

  return { data };
});

export const beforeExit = () => drainLateCleanups();
