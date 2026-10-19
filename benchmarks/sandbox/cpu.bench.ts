/**
 * CPU benchmark: measures raw CPU throughput inside a freshly created sandbox.
 *
 * One iteration = create sandbox → run scripts/cpu-benchmark.sh → destroy.
 * The script hashes a fixed amount of /dev/zero through SHA-256 twice: once on
 * a single core (per-core speed) and once across every logical CPU (whole-box
 * throughput). No network, disk, or package installs touch the clock — the
 * only variable is the CPU the provider actually delivers.
 *
 * Timed boundary: only the in-sandbox hashing phases are scored. Sandbox
 * create/destroy are timed steps but never enter the composite, so TTI and
 * teardown can't pollute the CPU grade.
 *
 * Every provider runs at the standardized 8 vCPU / 16 GiB profile from
 * sizes.ts so the composite score compares CPU to CPU; the script reports the
 * actual logical_cpus/cpu_model it observed so under- or over-provisioning is
 * visible in results rather than silently averaged in.
 *
 * `groupBy: 'round'` lets the task own its measured latency and attach the
 * pre-measured `cpu_single`/`cpu_multi` phases as platform steps.
 *
 * Run:
 *   bench run benchmarks/sandbox/cpu.bench.ts
 *   bench run benchmarks/sandbox/cpu.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { JsonObject, TaskStepRecord } from '@benchsdk/api';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { getSandboxOptionsWithResources } from './sizes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_SCRIPT_PATH = path.resolve(__dirname, '../scripts/cpu-benchmark.sh');

const timeout = 600_000;
const destroyTimeoutMs = 15_000;
const OUTPUT_TAIL_LINES = 40;
const ERROR_MAX_CHARS = 1200;

interface CpuTimingResult {
  totalMs: number;
  /** Wall time of the single-core hashing phase. */
  singleMs?: number;
  /** Wall time of the all-core hashing phase. */
  multiMs?: number;
  /** SHA-256 throughput, MB/s (decimal MB): single core. */
  singleCoreMBps?: number;
  /** SHA-256 throughput, MB/s: all logical CPUs combined. */
  multiCoreMBps?: number;
  /** multiCoreMBps / singleCoreMBps — how close the box gets to N× one core. */
  scalingFactor?: number;
  /** Logical CPUs observed inside the sandbox. */
  vcpus?: number;
  cpuModel?: string;
  architecture?: string;
  kernel?: string;
  memoryKiB?: number;
  done?: boolean;
  error?: string;
}

interface CpuRunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Last `n` non-empty lines of `output`, excluding the script's structured BENCH_* lines. */
function tail(output: string, n: number): string {
  return output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && !l.startsWith('BENCH_'))
    .slice(-n)
    .join('\n');
}

/** Short one-line detail for the `error` string; the full tails go to the log. */
function summarizeFailure(stdout: string, stderr: string): string {
  const parts = [tail(stderr, 5), tail(stdout, 5)].filter(Boolean);
  const summary = parts.join('\n').split('\n').join(' | ');
  return summary.length > ERROR_MAX_CHARS ? summary.slice(0, ERROR_MAX_CHARS - 1) + '…' : summary;
}

export const config = defineBenchmarkConfig({
  // The runner injects BENCHMARK_SLUG/BENCHMARK_NAME env overrides as CLI
  // flags, so cadence variants (-daily/-weekly/-smoke) come from CI env.
  benchmarkSlug: 'sandbox-cpu',
  benchmarkName: 'Sandbox CPU',
  iterations: 3,
  concurrency: 1,
  groupBy: 'round',
  participants: providers,
  scoring: {
    metrics: [
      // Headline: whole-box throughput — what a buyer's workload actually gets.
      // Ceiling/floor are calibrations (MB/s of SHA-256), not SLAs: a modern
      // core with SHA-NI does ~1-3 GB/s, an unaccelerated core ~0.2-0.5 GB/s.
      {
        key: 'multiCoreMBps',
        unit: 'MB/s',
        floor: 500,
        ceiling: 20000,
        higherIsBetter: true,
        weights: { median: 0.45, p95: 0.1, p99: 0.05 },
      },
      // Per-core speed, so a provider can't hide weak cores behind more of them.
      {
        key: 'singleCoreMBps',
        unit: 'MB/s',
        floor: 50,
        ceiling: 3000,
        higherIsBetter: true,
        weights: { median: 0.3, p95: 0.07, p99: 0.03 },
      },
    ],
    success: {
      requireData: { done: true },
    },
  },
  display: {
    metrics: [
      { key: 'multiCoreMBps', label: 'All-core throughput', unit: 'MB/s', direction: 'higher-better', decimals: 0 },
      { key: 'singleCoreMBps', label: 'Single-core throughput', unit: 'MB/s', direction: 'higher-better', decimals: 0 },
      { key: 'vcpus', label: 'vCPUs', direction: 'higher-better', decimals: 0 },
      { key: 'scalingFactor', label: 'Core scaling', unit: 'x', direction: 'higher-better', decimals: 1 },
      { key: 'singleMs', label: 'Single-core phase', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'multiMs', label: 'Multi-core phase', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'totalMs', label: 'Total time', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'cpu', label: 'CPU benchmark' },
      { key: 'cpu_single', label: 'Single-core' },
      { key: 'cpu_multi', label: 'All-core' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
});

/** Runs the benchmark script inside `sandbox` and parses its structured output. */
async function runCpuBenchmark(
  sandbox: any,
  providerName: string,
  runTimeout: number,
): Promise<{ timing: CpuTimingResult; output: CpuRunOutput }> {
  // Upload the script via a single-quoted heredoc so $ and backticks inside it
  // are not expanded; no curl/wget dependency in the sandbox.
  const benchScript = fs.readFileSync(BENCH_SCRIPT_PATH, 'utf8');
  const marker = '__CPU_BENCH_HEREDOC_' + Math.random().toString(36).slice(2) + '__';
  const shellCmd =
    `cat > /tmp/cpu-benchmark.sh <<'${marker}'\n` +
    benchScript +
    `\n${marker}\n` +
    `BENCH_PROVIDER=${providerName} bash /tmp/cpu-benchmark.sh`;

  const totalStart = Date.now();
  let result: { exitCode: number; stdout?: string; stderr?: string };
  try {
    result = await withTimeout(
      sandbox.runCommand(shellCmd, { timeout: runTimeout }),
      runTimeout,
      `CPU benchmark timed out after ${runTimeout}ms`,
    ) as { exitCode: number; stdout?: string; stderr?: string };
  } catch (err) {
    const elapsedMs = Date.now() - totalStart;
    throw new Error(`runCommand failed after ${elapsedMs}ms: ${formatError(err)}`, { cause: err });
  }
  const totalMs = Date.now() - totalStart;

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = result.exitCode;

  const phases: Record<string, number> = {};
  const bytes: Record<string, number> = {};
  const meta: Record<string, string> = {};
  let benchError: string | null = null;
  let done = false;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('BENCH_PHASE\t')) {
      const parts = line.split('\t');
      if (parts.length >= 3) phases[parts[1]] = parseInt(parts[2], 10);
    } else if (line.startsWith('BENCH_BYTES\t')) {
      const parts = line.split('\t');
      if (parts.length >= 3) bytes[parts[1]] = parseInt(parts[2], 10);
    } else if (line.startsWith('BENCH_META\t')) {
      const parts = line.split('\t');
      if (parts.length >= 3) meta[parts[1]] = parts[2];
    } else if (line.startsWith('BENCH_DONE')) {
      done = true;
    }
  }

  for (const line of stderr.split('\n')) {
    if (line.startsWith('BENCH_ERROR\t')) {
      const parts = line.split('\t');
      benchError = parts.slice(1).join(': ');
    }
  }

  const failed = exitCode !== 0 || benchError !== null || !done;
  if (failed && !benchError) {
    const detail = summarizeFailure(stdout, stderr);
    benchError =
      (phases.single === undefined
        ? 'benchmark script did not start'
        : phases.multi === undefined
          ? 'single-core phase completed, multi-core phase failed'
          : 'benchmark script exited before BENCH_DONE') +
      ` (exit code ${exitCode})` +
      (detail ? `: ${detail}` : '');
  }

  const mbps = (phase: string): number | undefined =>
    phases[phase] !== undefined && phases[phase] > 0 && bytes[phase] !== undefined
      ? Math.round((bytes[phase] / 1_000_000 / (phases[phase] / 1000)) * 10) / 10
      : undefined;

  const singleCoreMBps = mbps('single');
  const multiCoreMBps = mbps('multi');
  const vcpus = meta.logical_cpus ? parseInt(meta.logical_cpus, 10) : undefined;
  const memoryKiB = meta.memory_kib ? parseInt(meta.memory_kib, 10) : undefined;

  const timing: CpuTimingResult = {
    totalMs,
    singleMs: phases.single,
    multiMs: phases.multi,
    singleCoreMBps,
    multiCoreMBps,
    scalingFactor:
      singleCoreMBps && multiCoreMBps && singleCoreMBps > 0
        ? Math.round((multiCoreMBps / singleCoreMBps) * 100) / 100
        : undefined,
    vcpus,
    cpuModel: meta.cpu_model,
    architecture: meta.architecture,
    kernel: meta.kernel,
    memoryKiB,
    done,
    ...(benchError ? { error: benchError } : {}),
  };
  return { timing, output: { exitCode, stdout, stderr } };
}

function indent(text: string): string {
  return text.split('\n').map((l) => `    ${l}`).join('\n');
}

/** Emit each measured hashing phase as a pre-measured platform step. */
function cpuPhaseSteps(t: CpuTimingResult): TaskStepRecord[] {
  const single: JsonObject = {};
  if (t.singleCoreMBps !== undefined) single.singleCoreMBps = t.singleCoreMBps;
  const multi: JsonObject = {};
  if (t.multiCoreMBps !== undefined) multi.multiCoreMBps = t.multiCoreMBps;
  const phases: [string, number | undefined, JsonObject][] = [
    ['cpu_single', t.singleMs, single],
    ['cpu_multi', t.multiMs, multi],
  ];
  return phases
    .filter((entry): entry is [string, number, JsonObject] => typeof entry[1] === 'number')
    .map(([name, latencyMs, data]) => ({ name, status: 'success', latencyMs, data }));
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const p = ctx.participant;
  const { log } = ctx;
  const compute = p.createCompute();
  const opts = getSandboxOptionsWithResources(p.name, p.sandboxOptions);

  const createStart = Date.now();
  const sandbox = await ctx.step('create', () =>
    withTimeout<{ destroy(): Promise<unknown> }>(
      compute.sandbox.create(opts),
      p.timeout ?? timeout,
      'Sandbox creation timed out',
    ),
  ).catch((err: unknown) => {
    const message = `sandbox create failed after ${Date.now() - createStart}ms: ${formatError(err)}`;
    log('Sandbox create failed', { level: 'error', meta: { provider: p.name, error: message } });
    console.error(`  [${p.name}] ${message}`);
    throw new TaskError(message, { code: 'create_failed', data: { error: message } });
  });

  let timing: CpuTimingResult;
  let output: CpuRunOutput | undefined;
  try {
    timing = await ctx.step('cpu', async () => {
      const run = await runCpuBenchmark(sandbox, p.name, p.timeout ?? timeout);
      output = run.output;
      const t = run.timing;
      const cpuMetrics: JsonObject = { totalMs: t.totalMs };
      if (t.singleCoreMBps !== undefined) cpuMetrics.singleCoreMBps = t.singleCoreMBps;
      if (t.multiCoreMBps !== undefined) cpuMetrics.multiCoreMBps = t.multiCoreMBps;
      if (t.vcpus !== undefined) cpuMetrics.vcpus = t.vcpus;
      if (t.scalingFactor !== undefined) cpuMetrics.scalingFactor = t.scalingFactor;
      ctx.measure(cpuMetrics);
      return t;
    });
  } finally {
    await ctx
      .step('destroy', () => withTimeout(sandbox.destroy(), p.destroyTimeoutMs ?? destroyTimeoutMs, 'Destroy timeout'), {
        reportConcurrency: false,
      })
      .catch((err: unknown) => log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }));
    log('sandbox', { level: 'info', meta: { provider: p.name, sandboxId: sandboxId(sandbox) } });
  }

  const data = { ...(timing as unknown as JsonObject) };
  const steps = cpuPhaseSteps(timing);

  if (timing.error) {
    const stdoutTail = output ? tail(output.stdout, OUTPUT_TAIL_LINES) : '';
    const stderrTail = output ? tail(output.stderr, OUTPUT_TAIL_LINES) : '';
    log('CPU benchmark failed', {
      level: 'error',
      meta: {
        provider: p.name,
        totalMs: timing.totalMs,
        ...(output ? { exitCode: output.exitCode } : {}),
        error: timing.error,
        ...(stdoutTail ? { stdoutTail } : {}),
        ...(stderrTail ? { stderrTail } : {}),
      },
    });
    console.error(
      [
        `  [${p.name}] CPU benchmark failed (exit ${output?.exitCode ?? 'n/a'}): ${timing.error}`,
        ...(stderrTail ? ['  --- stderr (tail) ---', indent(stderrTail)] : []),
        ...(stdoutTail ? ['  --- stdout (tail) ---', indent(stdoutTail)] : []),
      ].join('\n'),
    );
    throw new TaskError(timing.error, { code: 'cpu_failed', data, steps });
  }

  log('CPU benchmark completed', {
    level: 'info',
    meta: {
      provider: p.name,
      totalMs: timing.totalMs,
      ...(timing.singleCoreMBps !== undefined ? { singleCoreMBps: timing.singleCoreMBps } : {}),
      ...(timing.multiCoreMBps !== undefined ? { multiCoreMBps: timing.multiCoreMBps } : {}),
      ...(timing.vcpus !== undefined ? { vcpus: timing.vcpus } : {}),
      ...(timing.scalingFactor !== undefined ? { scalingFactor: timing.scalingFactor } : {}),
      ...(timing.cpuModel ? { cpuModel: timing.cpuModel } : {}),
      ...(timing.architecture ? { architecture: timing.architecture } : {}),
    },
  });
  // latencyMs = the scored work only (in-sandbox hashing), excluding the
  // runCommand round-trip overhead the platform would otherwise fold in.
  return { data, steps, latencyMs: (timing.singleMs ?? 0) + (timing.multiMs ?? 0) };
});
