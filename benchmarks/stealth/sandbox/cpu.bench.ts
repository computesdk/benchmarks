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
 * The benchmark declares one `phases` arm per market size tier
 * (small/medium/large/xlarge — see sizes.ts), so every provider is graded per
 * size at the same shape a buyer picks in the market. Providers that can only
 * provision some tiers get no grade for the rest — the tier fails as
 * `size_not_supported` instead of silently substituting a wrong-size box.
 * `scoring.groupBy: 'phase'` produces one composite per size per provider.
 * The script reports the actual logical_cpus/cpu_model it observed so
 * under- or over-provisioning is visible in results rather than silently
 * averaged in.
 *
 * `groupBy: 'round'` lets the task own its measured latency and attach the
 * pre-measured `cpu_single`/`cpu_multi` phases as platform steps.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/cpu.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/cpu.bench.ts --provider e2b,modal
 */
import fs from 'node:fs';
import { continuousScoring } from './performance-runtime-scoring.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { JsonObject, TaskStepRecord } from '@benchsdk/client';
import { drainLateCleanups, trackLateCleanup, withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { templateNotProvisionedReason } from './size-templates.js';
import { getSandboxOptionsWithResources, MARKET_SIZES, MARKET_SIZE_NAMES, PROVIDER_SIZE_OPTIONS, type MarketSize } from './sizes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_SCRIPT_PATH = path.resolve(__dirname, '../scripts/cpu-benchmark.sh');

const timeout = 600_000;
const destroyTimeoutMs = 15_000;
const OUTPUT_TAIL_LINES = 40;
const ERROR_MAX_CHARS = 1200;
// Match the script's default workload. Guest env overrides must not silently
// shorten a scored benchmark; unexpected byte totals are invalid measurements.
const SINGLE_BYTES = 4096 * 1048576;
const CHUNK_BYTES = 2048 * 1048576;

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
  /** multiCoreMBps / expected tier vCPUs — per-core throughput at the
   *  purchased size; under-delivering cores costs score. */
  multiCorePerVcpuMBps?: number;
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

interface ParsedBenchOutput {
  phases: Record<string, number>;
  bytes: Record<string, number>;
  meta: Record<string, string>;
  done: boolean;
  benchError: string | null;
}

/** Phases that carry the scored metrics — both must be present for a valid result. */
const SCORED_PHASES = ['single', 'multi'];

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseBenchOutput(output: string): ParsedBenchOutput {
  const parsed: ParsedBenchOutput = { phases: {}, bytes: {}, meta: {}, done: false, benchError: null };
  const store = <T extends string | number>(record: Record<string, T>, name: string, value: T) => {
    if (Object.hasOwn(record, name) && record[name] !== value) {
      parsed.benchError ??= `conflicting benchmark record: ${name}`;
    }
    record[name] = value;
  };
  for (const raw of output.split('\n')) {
    // Strip CR — some providers return CRLF line endings (codesandbox).
    const line = raw.replace(/\r+$/, '');
    if (line.startsWith('BENCH_PHASE\t') || line.startsWith('BENCH_BYTES\t')) {
      const parts = line.split('\t');
      const value = positiveInteger(parts[2]);
      if (parts.length !== 3 || !SCORED_PHASES.includes(parts[1]) || value === undefined) {
        parsed.benchError ??= `invalid ${parts[0]} record`;
      } else {
        store(parts[0] === 'BENCH_PHASE' ? parsed.phases : parsed.bytes, parts[1], value);
      }
    } else if (line.startsWith('BENCH_META\t')) {
      const parts = line.split('\t');
      if (parts[1] === 'logical_cpus' && parts.length !== 3) {
        parsed.benchError ??= 'invalid logical_cpus record';
      } else if (parts.length >= 3) {
        store(parsed.meta, parts[1], parts[2]);
      }
    } else if (line.startsWith('BENCH_DONE')) {
      if (line === 'BENCH_DONE') parsed.done = true;
      else parsed.benchError ??= 'invalid BENCH_DONE record';
    } else if (line === 'BENCH_ERROR' || line.startsWith('BENCH_ERROR\t')) {
      parsed.benchError ??= line.split('\t').slice(1).join(': ') || 'benchmark reported BENCH_ERROR';
    }
  }
  return parsed;
}

function benchOutputComplete(parsed: ParsedBenchOutput): boolean {
  return parsed.done && parsed.meta.logical_cpus !== undefined &&
    SCORED_PHASES.every((ph) => parsed.phases[ph] !== undefined && parsed.bytes[ph] !== undefined);
}

function mergeBenchOutput(stream: ParsedBenchOutput, file: ParsedBenchOutput): ParsedBenchOutput {
  let conflict: string | null = null;
  for (const group of ['phases', 'bytes', 'meta'] as const) {
    for (const [key, value] of Object.entries(file[group])) {
      if (Object.hasOwn(stream[group], key) && stream[group][key] !== value) {
        conflict ??= `conflicting benchmark ${group} record between stdout and results file: ${key}`;
      }
    }
  }
  return {
    phases: { ...stream.phases, ...file.phases },
    bytes: { ...stream.bytes, ...file.bytes },
    meta: { ...stream.meta, ...file.meta },
    done: stream.done || file.done,
    benchError: stream.benchError ?? file.benchError ?? conflict,
  };
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

function benchStderrError(stderr: string): string | null {
  // Bash expansion errors can leave a zero outer exit and no BENCH_ERROR.
  if (/value too great for base|division by 0|invalid arithmetic operator|syntax error.*(?:operand|operator)/i.test(stderr)) {
    return `benchmark timer arithmetic failed: ${summarizeFailure('', stderr)}`;
  }
  return parseBenchOutput(stderr).benchError;
}

export const config = defineBenchmarkConfig({
  // The runner injects BENCHMARK_SLUG/BENCHMARK_NAME env overrides as CLI
  // flags, so cadence variants (-daily/-weekly/-smoke) come from CI env.
  benchmarkSlug: 'sandbox-cpu',
  benchmarkName: 'Sandbox CPU',
  // One arm per market size tier: every provider is graded per size.
  phases: MARKET_SIZE_NAMES.map((name) => ({ name, iterations: 3 })),
  concurrency: 1,
  groupBy: 'round',
  participants: providers,
  scoring: continuousScoring({
    // One composite per size tier per provider (records carry data.phase).
    groupBy: 'phase',
    metrics: [
      // Headline: per-vCPU throughput at the purchased tier —
      // multiCoreMBps divided by the tier's expected core count, so a box
      // that under-delivers cores scores worse while tiers are comparable
      // to each other. Ceiling/floor are calibrations (MB/s of SHA-256 per
      // core), not SLAs: a good virtualized SHA-NI core does ~1.5-2 GB/s, an
      // unaccelerated or oversubscribed core ~0.05-0.5 GB/s.
      {
        key: 'multiCorePerVcpuMBps',
        // Must match display.metrics[].unit — the runner rejects a mismatch.
        unit: 'MB/s',
        floor: 50,
        ceiling: 2000,
        higherIsBetter: true,
        weights: { median: 0.45, p95: 0.1, p99: 0.05 },
      },
      // Per-core speed, so a provider can't hide weak cores behind more of them.
      {
        key: 'singleCoreMBps',
        unit: 'MB/s',
        floor: 50,
        ceiling: 2000,
        higherIsBetter: true,
        weights: { median: 0.3, p95: 0.07, p99: 0.03 },
      },
    ],
    success: {
      requireData: { done: true },
    },
  }, { multiCorePerVcpuMBps: 2000, singleCoreMBps: 2000 }),
  display: {
    metrics: [
      { key: 'multiCoreMBps', label: 'All-core throughput', unit: 'MB/s', direction: 'higher-better', decimals: 0 },
      { key: 'multiCorePerVcpuMBps', label: 'Per-vCPU throughput', unit: 'MB/s', direction: 'higher-better', decimals: 0 },
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
  const runOnce = (note: string) =>
    withTimeout(
      sandbox.runCommand(shellCmd, { timeout: runTimeout }),
      runTimeout,
      `CPU benchmark timed out after ${runTimeout}ms${note}`,
    ) as Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  try {
    result = await runOnce('');
  } catch (err) {
    // A thrown runCommand is transport-level (provider 5xx, dropped
    // connection) — the benchmark may never have started. One retry absorbs
    // a transient flake; real bench failures come back as a nonzero
    // exitCode or BENCH_ERROR and are never retried.
    result = await runOnce(' (retry)').catch((retryErr: unknown) => {
      const elapsedMs = Date.now() - totalStart;
      throw new Error(
        `runCommand failed after ${elapsedMs}ms (retried once): ${formatError(retryErr)}`,
        { cause: retryErr },
      );
    });
  }
  const totalMs = Date.now() - totalStart;

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = result.exitCode;

  let parsed = parseBenchOutput(stdout);

  // Exec streams on several providers intermittently drop a mid-stream chunk,
  // which loses BENCH_* lines the script definitely printed. The script
  // mirrors every line to /tmp/cpu-bench-results.txt; when the streamed output
  // is incomplete, re-read the file via a second exec and union it over the
  // streamed parse. Skipped entirely when the stream already has everything.
  if (!benchOutputComplete(parsed)) {
    try {
      const fileRead = (await withTimeout(
        sandbox.runCommand('cat /tmp/cpu-bench-results.txt 2>/dev/null || true', { timeout: 60_000 }),
        60_000,
        'results file read timed out',
      )) as { exitCode: number; stdout?: string; stderr?: string };
      if (fileRead.exitCode !== 0) {
        parsed.benchError ??= `results file recovery failed (exit code ${fileRead.exitCode})`;
      } else {
        parsed.benchError ??= benchStderrError(fileRead.stderr || '');
        if (fileRead.stdout) parsed = mergeBenchOutput(parsed, parseBenchOutput(fileRead.stdout));
      }
    } catch (error) {
      parsed.benchError ??= `results file recovery failed: ${formatError(error)}`;
    }
  }

  const { phases, bytes, meta, done } = parsed;
  let benchError = benchStderrError(stderr) ?? parsed.benchError;
  if (!benchError && exitCode !== 0) {
    benchError = `benchmark command exited with code ${exitCode}: ${summarizeFailure(stdout, stderr)}`;
  }
  if (!benchError && !benchOutputComplete(parsed)) {
    benchError = 'incomplete benchmark output: expected BENCH_DONE, both phase timings/bytes and logical_cpus';
  }
  const vcpus = positiveInteger(meta.logical_cpus);
  const expectedMultiBytes = vcpus === undefined ? NaN : vcpus * CHUNK_BYTES;
  if (!benchError && (vcpus === undefined || !Number.isSafeInteger(expectedMultiBytes))) {
    benchError = 'invalid logical_cpus or expected multi byte count';
  }
  if (!benchError && (bytes.single !== SINGLE_BYTES || bytes.multi !== expectedMultiBytes)) {
    benchError = `unexpected benchmark bytes: single=${bytes.single}, multi=${bytes.multi}; expected ${SINGLE_BYTES}/${expectedMultiBytes}`;
  }

  const mbps = (phase: string): number | undefined =>
    phases[phase] !== undefined && phases[phase] > 0 && bytes[phase] !== undefined
      ? bytes[phase] / 1_000_000 / (phases[phase] / 1000)
      : undefined;

  const singleCoreMBps = mbps('single');
  const multiCoreMBps = mbps('multi');
  const scalingFactor = singleCoreMBps && multiCoreMBps
    ? Math.round((multiCoreMBps / singleCoreMBps) * 100) / 100
    : undefined;
  if (!benchError && [singleCoreMBps, multiCoreMBps, scalingFactor].some(
    (value) => value === undefined || !Number.isFinite(value) || value <= 0,
  )) {
    benchError = 'invalid nonpositive or nonfinite benchmark throughput/scaling';
  }
  const memoryKiB = meta.memory_kib ? parseInt(meta.memory_kib, 10) : undefined;

  const timing: CpuTimingResult = {
    totalMs,
    singleMs: phases.single,
    multiMs: phases.multi,
    ...(!benchError ? { singleCoreMBps, multiCoreMBps, scalingFactor } : {}),
    vcpus,
    cpuModel: meta.cpu_model,
    architecture: meta.architecture,
    kernel: meta.kernel,
    memoryKiB,
    done: done && !benchError,
    ...(benchError ? { error: benchError } : {}),
  };
  return { timing, output: { exitCode, stdout, stderr } };
}

function indent(text: string): string {
  return text.split('\n').map((l) => `    ${l}`).join('\n');
}

/** Emit each measured hashing phase as a pre-measured platform step. */
function cpuPhaseSteps(t: CpuTimingResult): TaskStepRecord[] {
  if (t.error || !t.done) return [];
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
  const size = (ctx.phase ?? 'xlarge') as MarketSize;
  const compute = p.createCompute();
  const opts = getSandboxOptionsWithResources(p.name, p.sandboxOptions, size);
  if (opts === undefined) {
    throw new TaskError(`provider has no '${size}' size offering`, {
      code: 'size_not_supported',
      // Unsupported, not failed: the provider has no offering at this tier.
      data: { size, supported: false, skipped: true, skipReason: `no ${size} offering` },
    });
  }

  const createStart = Date.now();
  const createPromise = compute.sandbox.create(opts) as Promise<{ destroy(): Promise<unknown> }>;
  const sandbox = await ctx.step('create', () =>
    withTimeout<{ destroy(): Promise<unknown> }>(
      createPromise,
      p.timeout ?? timeout,
      'Sandbox creation timed out',
    ),
  ).catch((err: unknown) => {
    // The create call can still resolve after our timeout — destroy whatever
    // shows up late so the iteration doesn't leak a live sandbox.
    trackLateCleanup(() => createPromise.then((late) => late.destroy(), () => {}));
    const notProvisioned = templateNotProvisionedReason(p.name, opts, err);
    const message = notProvisioned
      ? `${notProvisioned} (create: ${formatError(err)})`
      : `sandbox create failed after ${Date.now() - createStart}ms: ${formatError(err)}`;
    log('Sandbox create failed', { level: 'error', meta: { provider: p.name, size, error: message } });
    console.error(`  [${p.name}] ${message}`);
    throw new TaskError(message, {
      code: notProvisioned ? 'template_not_provisioned' : 'create_failed',
      data: { size, error: message },
    });
  });

  let timing: CpuTimingResult;
  let output: CpuRunOutput | undefined;
  const expected = MARKET_SIZES[size];
  try {
    timing = await ctx.step('cpu', async () => {
      const run = await runCpuBenchmark(sandbox, p.name, p.timeout ?? timeout);
      output = run.output;
      const t = run.timing;
      // Normalize at the purchased tier, then validate before emitting metrics.
      t.multiCorePerVcpuMBps = t.multiCoreMBps !== undefined
        ? t.multiCoreMBps / expected.cpus
        : undefined;
      if (!t.error && (t.multiCorePerVcpuMBps === undefined ||
        !Number.isFinite(t.multiCorePerVcpuMBps) || t.multiCorePerVcpuMBps <= 0)) {
        t.error = 'invalid nonpositive or nonfinite per-vCPU throughput';
        t.done = false;
      }
      if (t.error) return t;
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
    log('sandbox', { level: 'info', meta: { provider: p.name, size, sandboxId: sandboxId(sandbox) } });
  }

  // The market tier is the claim under test: flag when the sandbox's own
  // report falls materially short of it (e.g. cloud-run's xlarge coming back
  // at 5 vCPU / 4 GiB). Over-reporting — host-level nproc/meminfo — is never
  // a shortfall. The throughput score already punishes the miss; this names
  // it instead of leaving it to inference.
  const provisionedUnder =
    (timing.vcpus !== undefined && timing.vcpus < expected.cpus * 0.8) ||
    (timing.memoryKiB !== undefined && timing.memoryKiB < expected.memoryMb * 1024 * 0.8);
  if (provisionedUnder) {
    log('sandbox under-provisioned for tier', {
      level: 'warn',
      meta: { provider: p.name, size, deliveredVcpus: timing.vcpus ?? null, deliveredMemoryKiB: timing.memoryKiB ?? null, expected },
    });
  }

  // Floored tiers can resolve to a smaller spec than the tier name implies
  // (tensorlake small is 1c/1G under the account cap) — record the resolved
  // spec so a score never claims a shape it wasn't.
  const data = {
    size,
    sizeSpec: PROVIDER_SIZE_OPTIONS[p.name]?.[size] ?? null,
    ...(provisionedUnder ? { provisionedUnder: true } : {}),
    ...(timing as unknown as JsonObject),
  };
  const steps = cpuPhaseSteps(timing);

  if (timing.error) {
    const stdoutTail = output ? tail(output.stdout, OUTPUT_TAIL_LINES) : '';
    const stderrTail = output ? tail(output.stderr, OUTPUT_TAIL_LINES) : '';
    log('CPU benchmark failed', {
      level: 'error',
      meta: {
        provider: p.name,
        size,
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
      size,
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

export const beforeExit = () => drainLateCleanups();
