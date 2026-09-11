
/**
 * Dax benchmark: runs the OpenCode build (scripts/dax-benchmark.sh) inside a
 * freshly created sandbox once per iteration and measures its build phases
 * (prepare / bun-download / bun-unpack / clone / install / typecheck).
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint and
 * platform orchestration. The legacy `results/sandbox-dax/` JSON shape is
 * preserved verbatim via the legacy-results adapter (TEMPORARY local-JSON
 * bridge — see legacy-results); its summarizer/writer lives in ./dax.ts.
 *
 * `groupBy: 'round'` is used so the task owns its own measured `latencyMs`
 * (the build's totalMs) and can attach pre-measured phase steps; the local
 * bridge reconstructs the full DaxTimingResult from `record.data`.
 *
 * Run:
 *   bench run benchmarks/sandbox/dax.bench.ts
 *   bench run benchmarks/sandbox/dax.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { JsonObject, TaskStepRecord } from '@benchsdk/api';
import { VMTier } from '@codesandbox/sdk';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { BENCH_SCRIPT_PATH } from './dax.js';
import type { DaxTimingResult } from './dax.js';
import { writeDaxLegacyResults } from './dax-legacy-results.js';

/** Raw build output kept alongside the timing so failures can be diagnosed from the logs. */
interface DaxBuildOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  failedPhase?: string;
}

const OUTPUT_TAIL_LINES = 40;
const ERROR_MAX_CHARS = 1200;

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const timeout = 600_000;
const destroyTimeoutMs = 15_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: `sandbox-dax${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Sandbox Dax${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  iterations: 3,
  concurrency: 1,
  groupBy: 'round',
  defaultProviders: ['e2b', 'modal', 'tensorlake'],
  participants: providers,
  display: {
    metrics: [
      { key: 'totalMs', label: 'Total build time', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'prepareMs', label: 'Prepare', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'cacheClearMs', label: 'Cache clear', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'bunDownloadMs', label: 'Bun download', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'bunUnpackMs', label: 'Bun unpack', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'cloneMs', label: 'Clone', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'installMs', label: 'Install', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'typecheckMs', label: 'Typecheck', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'phasesCompleted', label: 'Phases completed', direction: 'higher-better', decimals: 0 },
      { key: 'phasesTotal', label: 'Phases total', direction: 'higher-better', decimals: 0 },
      { key: 'diskAfterClone', label: 'Disk after clone', unit: 'bytes', direction: 'lower-better', decimals: 0 },
      { key: 'diskAfterInstall', label: 'Disk after install', unit: 'bytes', direction: 'lower-better', decimals: 0 },
      { key: 'diskAfterTypecheck', label: 'Disk after typecheck', unit: 'bytes', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'build', label: 'Build' },
      { key: 'destroy', label: 'Destroy sandbox' },
      { key: 'prepare', label: 'Prepare' },
      { key: 'cache_clear', label: 'Cache clear' },
      { key: 'bun_download', label: 'Bun download' },
      { key: 'bun_unpack', label: 'Bun unpack' },
      { key: 'clone', label: 'Clone' },
      { key: 'install', label: 'Install' },
      { key: 'typecheck', label: 'Typecheck' },
    ],
    overview: { defaultMetric: 'task', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writeDaxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/sandbox-dax'),
    }),
});

// Standardized resource sizing for fair comparison across providers.
// Target: 8 vCPU, 16 GiB RAM.
// Each provider uses different parameter names and units, so we map per-provider.
// Providers not listed here don't support CPU/memory configuration at sandbox creation time.
// Note: E2B sets CPU/memory at template build time, not at sandbox creation.
// Note: lightning is sized via LIGHTNING_INSTANCE_TYPE=cpu-8 (8 vCPU / 16 GiB), applied on
// the provider factory in providers.ts — the SDK ignores an instanceType passed to create().
const DAX_RESOURCE_OPTIONS: Record<string, Record<string, any>> = {
  arker:        { templateId: 'ubuntu-full-8' },           // 8 vCPU / 16 GiB golden
  modal:        { cpu: 4, cpuLimit: 4, memoryMiB: 16384 }, // Modal: 1 core = 2 vCPUs, so 4 cores = 8 vCPUs
  tenki:        { cpuCores: 8, memoryMb: 16384, diskSizeGb: 20 }, // default disk cannot hold the OpenCode install
  tensorlake:   { cpus: 8, memoryMb: 16384 },
  isorun:       { vcpus: 8, memMiB: 16384 },
  runloop:      { launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: 8, custom_gb_memory: 16 } },
  upstash:      { size: 'large' },                          // large = 8 cores, 16 GB
  vercel:       { resources: { vcpus: 8 } },               // no memory control
  blaxel:       {
    memory: 16384,                                          // CPU derived: cores = memory_MB / 2048 = 8
    timeout: 900_000,                                       // Server-side TTL backstop if client cleanup cannot run
    volumes: [
      {
        name: 'dax-root',
        type: 'ephemeral',
        sizeMb: 16384,
        mountPath: '/',                                     // Keep the writable root off RAM
      },
    ],
  },
  beam:         { cpu: 8, memory: 16384 },                   // cpu = cores, memory = MiB
  codesandbox:  { vmTier: VMTier.Small },                  // Small = 8 CPU, 16 GiB
  northflank:   { deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN || 'nf-compute-50', ephemeralStorageSize: 5120 },  // 5 GiB ephemeral storage
  declaw:       { templateId: 'node-large' },              // node-large template: 8 vCPU / 16 GiB RAM / 8 GiB disk
  superserve:   { templateId: 'node22-8cpu-16gb' },           // 8 vCPU / 16 GiB template built in the pre-step
  createos:     { shape: 's-8vcpu-16gb', ephemeralDiskMb: 61440 }, // 8 vCPU, 16 GiB RAM, 60 GiB disk
  opencomputer: { cpuCount: 4, memoryMB: 16384, timeout: 600_000 },
  microsandbox: { cpus: 8, memoryMib: 16384 },
  mosaic:       { vcpus: 8, memoryMb: 16384 },
  miosa:        { vcpus: 8, memory: 16384 },               // maps to MIOSA size contract "large" (8 vCPU / 16 GiB)
  // givemeanode has no 8 vCPU / 16 GiB named shape; asking for 8 vCPU and 16 GiB
  // selects sandbox-lg (8 vCPU / 32 GiB). The actual memory is reported by the
  // benchmark script, so the mismatch is visible in results.
  givemeanode:  { vcpus: 8, memoryMiB: 16384 },
  // Sandbox0 exposes only memory. Override the 128 MiB TTI size;
  // getSandboxOptionsWithResources preserves hardTtl from providers.ts.
  sandbox0:     { memory: 16384 },
  sail:         { size: 'l' },
};

function getSandboxOptionsWithResources(providerName: string, baseOptions?: Record<string, any>): Record<string, any> {
  const resourceOpts = DAX_RESOURCE_OPTIONS[providerName];
  if (!resourceOpts) return baseOptions ?? {};
  return { ...baseOptions, ...resourceOpts };
}

/** Runs the build script inside `sandbox` and parses its structured output. */
async function runDaxBuild(
  sandbox: any,
  providerName: string,
  buildTimeout: number,
): Promise<{ timing: DaxTimingResult; output: DaxBuildOutput }> {
  // Load the benchmark script from the local filesystem rather than fetching
  // it over HTTP inside the sandbox. This eliminates a curl dependency
  // (several providers don't ship curl in their sandboxes).
  const benchScript = fs.readFileSync(BENCH_SCRIPT_PATH, 'utf8');

  // Write the benchmark script to /tmp inside the sandbox via a single-quoted
  // heredoc (so $ and backticks in the script are not expanded) and execute it
  // directly with bash. A random marker avoids collisions with anything
  // appearing on its own line inside the script. Running the benchmark script
  // directly (without a Node.js wrapper) lets providers that ship a different
  // Node.js version pre-installed (e.g. Vercel) reuse their own binary.
  const marker = '__DAX_BENCH_HEREDOC_' + Math.random().toString(36).slice(2) + '__';
  const shellCmd =
    `cat > /tmp/dax-benchmark.sh <<'${marker}'\n` +
    benchScript +
    `\n${marker}\n` +
    `BENCH_PROVIDER=${providerName} BENCH_REGION=unknown bash /tmp/dax-benchmark.sh`;

  const totalStart = Date.now();
  let result: { exitCode: number; stdout?: string; stderr?: string };
  try {
    result = await withTimeout(
      sandbox.runCommand(shellCmd, { timeout: buildTimeout }),
      buildTimeout,
      `Dax benchmark timed out after ${buildTimeout}ms`,
    ) as { exitCode: number; stdout?: string; stderr?: string };
  } catch (err) {
    const elapsedMs = Date.now() - totalStart;
    throw new Error(`runCommand failed after ${elapsedMs}ms: ${formatError(err)}`, { cause: err });
  }
  const totalMs = Date.now() - totalStart;

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = result.exitCode;

  // Parse structured output lines emitted by the benchmark script.
  const phases: Record<string, number> = {};
  const meta: Record<string, string> = {};
  const disk: Record<string, number> = {};
  let benchError: string | null = null;
  let doneCommit: string | null = null;
  // BENCH_FAIL\t<phase> is printed by phase() when the measured command fails.
  let failedPhase: string | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('BENCH_PHASE\t')) {
      const parts = line.split('\t');
      if (parts.length >= 3) phases[parts[1]] = parseInt(parts[2], 10);
    } else if (line.startsWith('BENCH_META\t')) {
      const parts = line.split('\t');
      if (parts.length >= 3) meta[parts[1]] = parts[2];
    } else if (line.startsWith('BENCH_DISK\t')) {
      const parts = line.split('\t');
      if (parts.length >= 3) disk[parts[1]] = parseInt(parts[2], 10);
    } else if (line.startsWith('BENCH_DONE\t')) {
      const parts = line.split('\t');
      if (parts.length >= 2) doneCommit = parts[1];
    } else if (line.startsWith('BENCH_FAIL\t')) {
      const parts = line.split('\t');
      if (parts.length >= 2 && parts[1]) failedPhase = parts[1];
    }
  }

  for (const line of stderr.split('\n')) {
    if (line.startsWith('BENCH_ERROR\t')) {
      const parts = line.split('\t');
      if (!failedPhase && parts[1]) failedPhase = parts[1];
      benchError = parts.slice(1).join(': ');
    }
  }

  // Count completed phases
  const phaseKeys = ['prepare', 'cache_clear', 'bun_download', 'bun_unpack', 'clone', 'install', 'typecheck'];
  const rawPhasesCompleted = phaseKeys.filter(k => phases[k] !== undefined).length;
  const failed = exitCode !== 0 || benchError !== null || doneCommit === null;
  // phase() prints BENCH_PHASE (timing) before BENCH_FAIL, so the failed phase's
  // timing must be dropped and not counted as completed.
  const failedPhaseKey = failedPhase && phases[failedPhase] !== undefined ? failedPhase : null;
  const phasesCompleted = failedPhaseKey ? rawPhasesCompleted - 1 : rawPhasesCompleted;

  if (failed) {
    const detail = summarizeFailure(stdout, stderr);
    const where = failedPhase
      ? `${failedPhase} phase failed`
      : rawPhasesCompleted === 0
        ? 'no benchmark phases ran (script did not start)'
        : `script failed after ${phaseKeys[rawPhasesCompleted - 1]}`;
    benchError = `${where} (exit code ${exitCode}, ${phasesCompleted}/${phaseKeys.length} phases completed)` +
      (benchError ? `: ${benchError}` : '') + (detail ? `: ${detail}` : '');
  }

  const output: DaxBuildOutput = { exitCode, stdout, stderr, ...(failedPhase ? { failedPhase } : {}) };

  const timing: DaxTimingResult = {
    totalMs,
    phasesCompleted,
    phasesTotal: phaseKeys.length,
    prepareMs: failedPhaseKey === 'prepare' ? undefined : phases.prepare,
    cacheClearMs: failedPhaseKey === 'cache_clear' ? undefined : phases.cache_clear,
    bunDownloadMs: failedPhaseKey === 'bun_download' ? undefined : phases.bun_download,
    bunUnpackMs: failedPhaseKey === 'bun_unpack' ? undefined : phases.bun_unpack,
    cloneMs: failedPhaseKey === 'clone' ? undefined : phases.clone,
    installMs: failedPhaseKey === 'install' ? undefined : phases.install,
    typecheckMs: failedPhaseKey === 'typecheck' ? undefined : phases.typecheck,
    diskAfterClone: disk.after_clone,
    diskAfterInstall: disk.after_install,
    diskAfterTypecheck: disk.after_typecheck,
    commit: doneCommit || meta.commit,
    bunVersion: meta.bun_version,
    nodeVersion: meta.node_version,
    architecture: meta.architecture,
    kernel: meta.kernel,
    logicalCpus: meta.logical_cpus,
    cpuModel: meta.cpu_model,
    memoryKib: meta.memory_kib,
    ...(benchError ? { error: benchError } : {}),
  };
  return { timing, output };
}

function indent(text: string): string {
  return text.split('\n').map((l) => `    ${l}`).join('\n');
}

/** Emit each measured build phase as a pre-measured platform step. */
function daxPhaseSteps(t: DaxTimingResult): TaskStepRecord[] {
  const phases: [string, number | undefined][] = [
    ['prepare', t.prepareMs],
    ['cache_clear', t.cacheClearMs],
    ['bun_download', t.bunDownloadMs],
    ['bun_unpack', t.bunUnpackMs],
    ['clone', t.cloneMs],
    ['install', t.installMs],
    ['typecheck', t.typecheckMs],
  ];
  return phases
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, latencyMs]) => {
      const metricKey = name.replace(/_(.)/g, (_, c) => c.toUpperCase()) + 'Ms';
      return { name, status: 'success', latencyMs, data: { [metricKey]: latencyMs } };
    });
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

  let timing: DaxTimingResult;
  let output: DaxBuildOutput | undefined;
  try {
    timing = await ctx.step('build', async () => {
      const build = await runDaxBuild(sandbox, p.name, p.timeout ?? timeout);
      output = build.output;
      const t = build.timing;
      const buildMetrics: JsonObject = { totalMs: t.totalMs };
      if (t.phasesCompleted !== undefined) buildMetrics.phasesCompleted = t.phasesCompleted;
      if (t.phasesTotal !== undefined) buildMetrics.phasesTotal = t.phasesTotal;
      if (t.diskAfterClone !== undefined) buildMetrics.diskAfterClone = t.diskAfterClone;
      if (t.diskAfterInstall !== undefined) buildMetrics.diskAfterInstall = t.diskAfterInstall;
      if (t.diskAfterTypecheck !== undefined) buildMetrics.diskAfterTypecheck = t.diskAfterTypecheck;
      ctx.measure(buildMetrics);
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

  const data = { ...(timing as unknown as JsonObject), ...(output?.failedPhase ? { failedPhase: output.failedPhase } : {}) };
  const steps = daxPhaseSteps(timing);

  if (timing.error) {
    const stdoutTail = output ? tail(output.stdout, OUTPUT_TAIL_LINES) : '';
    const stderrTail = output ? tail(output.stderr, OUTPUT_TAIL_LINES) : '';
    log('Dax build failed', {
      level: 'error',
      meta: {
        provider: p.name,
        totalMs: timing.totalMs,
        phasesCompleted: `${timing.phasesCompleted}/${timing.phasesTotal}`,
        ...(output?.failedPhase ? { failedPhase: output.failedPhase } : {}),
        ...(output ? { exitCode: output.exitCode } : {}),
        error: timing.error,
        ...(stdoutTail ? { stdoutTail } : {}),
        ...(stderrTail ? { stderrTail } : {}),
      },
    });
    console.error(
      [
        `  [${p.name}] Dax build failed${output?.failedPhase ? ` in ${output.failedPhase}` : ''}` +
          ` (${timing.phasesCompleted}/${timing.phasesTotal} phases, exit ${output?.exitCode ?? 'n/a'}): ${timing.error}`,
        ...(stderrTail ? ['  --- stderr (tail) ---', indent(stderrTail)] : []),
        ...(stdoutTail ? ['  --- stdout (tail) ---', indent(stdoutTail)] : []),
      ].join('\n'),
    );
    throw new TaskError(timing.error, { code: 'dax_failed', data, steps });
  }

  log('Dax build completed', {
    level: 'info',
    meta: {
      provider: p.name,
      totalMs: timing.totalMs,
      phasesCompleted: `${timing.phasesCompleted}/${timing.phasesTotal}`,
      ...(timing.commit ? { commit: timing.commit } : {}),
      ...(timing.bunVersion ? { bunVersion: timing.bunVersion } : {}),
      ...(timing.nodeVersion ? { nodeVersion: timing.nodeVersion } : {}),
      ...(timing.architecture ? { architecture: timing.architecture } : {}),
    },
  });
  return { data, steps, latencyMs: timing.totalMs };
});