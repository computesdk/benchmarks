import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';
import type { ComputePerfBenchmarkResult, ComputePerfProviderConfig, ComputePerfTimingResult } from './types.js';
import { KERNEL_VERSION, WORKLOAD, WORKLOAD_ACRONYM, WORKLOAD_LABEL } from './types.js';

const KERNEL_TARBALL = `linux-${KERNEL_VERSION}.tar.xz`;
const KERNEL_URL = `https://cdn.kernel.org/pub/linux/kernel/v6.x/${KERNEL_TARBALL}`;
const KERNEL_SHA256 = '335aeec4f6af045d958e2dabaf55222349933e396df17b5cd31798f5ec7f8c35';

function parseResultLine(output: string): { buildMs: number; cpuCount?: number; memTotalKb?: number } | null {
  const markerLine = output
    .split('\n')
    .find(line => line.startsWith('__COMPUTE_PERF_RESULT__'));

  if (!markerLine) return null;

  const build = markerLine.match(/buildMs=(\d+)/);
  const cpu = markerLine.match(/cpu=(\d+)/);
  const mem = markerLine.match(/memKb=(\d+)/);

  if (!build) return null;

  return {
    buildMs: Number(build[1]),
    cpuCount: cpu ? Number(cpu[1]) : undefined,
    memTotalKb: mem ? Number(mem[1]) : undefined,
  };
}

function getKernelBuildScript(): string {
  return [
    'set -euo pipefail',
    'WORKDIR=/tmp/compute-perf-linux',
    'rm -rf "$WORKDIR"',
    'mkdir -p "$WORKDIR"',
    'cd "$WORKDIR"',
    'if command -v curl >/dev/null 2>&1; then',
    `  curl -fsSL --retry 3 "${KERNEL_URL}" -o "${KERNEL_TARBALL}"`,
    'elif command -v wget >/dev/null 2>&1; then',
    `  wget -qO "${KERNEL_TARBALL}" "${KERNEL_URL}"`,
    'else',
    '  echo "Missing downloader: curl or wget"',
    '  exit 2',
    'fi',
    `echo "${KERNEL_SHA256}  ${KERNEL_TARBALL}" | sha256sum -c -`,
    `tar -xf "${KERNEL_TARBALL}"`,
    `cd "linux-${KERNEL_VERSION}"`,
    'for cmd in make gcc ld bison flex bc; do',
    '  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing dependency: $cmd"; exit 3; }',
    'done',
    'make defconfig >/dev/null',
    'START_NS=$(date +%s%N)',
    'make -j"$(nproc)" bzImage >/tmp/compute-perf-build.log 2>&1',
    'END_NS=$(date +%s%N)',
    'BUILD_MS=$(( (END_NS - START_NS) / 1000000 ))',
    'CPU_COUNT=$(nproc)',
    "MEM_TOTAL_KB=$(awk '/MemTotal:/ { print $2 }' /proc/meminfo)",
    'echo "__COMPUTE_PERF_RESULT__ buildMs=${BUILD_MS} cpu=${CPU_COUNT} memKb=${MEM_TOTAL_KB}"',
  ].join('\n');
}

async function runComputePerfIteration(
  compute: any,
  timeout: number,
  sandboxOptions?: Record<string, any>,
  destroyTimeoutMs: number = 15_000,
): Promise<ComputePerfTimingResult> {
  let sandbox: any = null;

  try {
    sandbox = await withTimeout(
      compute.sandbox.create(sandboxOptions),
      timeout,
      'Sandbox creation timed out',
    );

    const iterationStart = performance.now();
    const command = [
      "cat <<'__COMPUTE_PERF_SCRIPT__' >/tmp/compute-perf.sh",
      getKernelBuildScript(),
      '__COMPUTE_PERF_SCRIPT__',
      'bash /tmp/compute-perf.sh',
    ].join('\n');

    const result = await withTimeout(
      sandbox.runCommand(command),
      timeout,
      'Kernel build command timed out',
    ) as { exitCode: number; stdout?: string; stderr?: string };

    if (result.exitCode !== 0) {
      const details = [result.stderr, result.stdout]
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(`Command failed with exit code ${result.exitCode}${details ? `: ${details}` : ''}`);
    }

    const totalMs = performance.now() - iterationStart;
    const parsed = parseResultLine(`${result.stdout || ''}\n${result.stderr || ''}`);
    if (!parsed) {
      throw new Error('Unable to parse build metrics from command output');
    }

    return {
      totalMs,
      buildMs: parsed.buildMs,
      cpuCount: parsed.cpuCount,
      memTotalKb: parsed.memTotalKb,
    };
  } finally {
    if (sandbox) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sandbox.destroy(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs);
          }),
        ]);
      } catch (err) {
        console.warn(`    [cleanup] destroy failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}

export async function runComputePerfBenchmark(config: ComputePerfProviderConfig): Promise<ComputePerfBenchmarkResult> {
  const {
    name,
    iterations = 5,
    timeout = 2_700_000,
    requiredEnvVars,
    sandboxOptions,
    destroyTimeoutMs,
  } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'compute-perf',
      workload: WORKLOAD,
      workloadAcronym: WORKLOAD_ACRONYM,
      kernelVersion: KERNEL_VERSION,
      iterations: [],
      summary: {
        buildMs: { median: 0, p95: 0, p99: 0 },
        totalMs: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: ComputePerfTimingResult[] = [];

  console.log(`\n--- ${WORKLOAD_LABEL} (${WORKLOAD_ACRONYM}): ${name} (${iterations} iterations, linux-${KERNEL_VERSION}) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);

    try {
      const iterationResult = await runComputePerfIteration(
        compute,
        timeout,
        sandboxOptions,
        destroyTimeoutMs,
      );
      results.push(iterationResult);
      console.log(
        `    Build: ${(iterationResult.buildMs / 1000).toFixed(2)}s | Total: ${(iterationResult.totalMs / 1000).toFixed(2)}s` +
        `${iterationResult.cpuCount ? ` | CPU: ${iterationResult.cpuCount}` : ''}`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ totalMs: 0, buildMs: 0, error });
    }
  }

  const successful = results.filter(r => !r.error);

  return {
    provider: name,
    mode: 'compute-perf',
    workload: WORKLOAD,
    workloadAcronym: WORKLOAD_ACRONYM,
    kernelVersion: KERNEL_VERSION,
    iterations: results,
    summary: {
      buildMs: successful.length > 0
        ? computeStats(successful.map(r => r.buildMs))
        : { median: 0, p95: 0, p99: 0 },
      totalMs: successful.length > 0
        ? computeStats(successful.map(r => r.totalMs))
        : { median: 0, p95: 0, p99: 0 },
    },
  };
}
