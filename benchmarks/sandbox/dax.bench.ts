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
import type { JsonObject, TaskStepRecord } from '@benchsdk/client';
import { VMTier } from '@codesandbox/sdk';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import { BENCH_SCRIPT_PATH } from './dax.js';
import type { DaxTimingResult } from './dax.js';
import { writeDaxLegacyResults } from './dax-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const timeout = 600_000;
const destroyTimeoutMs = 15_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-dax-local',
  benchmarkName: 'Dax sandbox benchmark (local)',
  benchmarkKind: 'sandbox',
  iterations: 3,
  concurrency: 1,
  groupBy: 'round',
  defaultProviders: ['e2b', 'modal', 'tensorlake'],
  participants: providers,
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
  blaxel:       { memory: 16384 },                          // CPU derived: cores = memory_MB / 2048 = 8
  beam:         { cpu: 8, memory: 16384 },                   // cpu = cores, memory = MiB
  codesandbox:  { vmTier: VMTier.Small },                  // Small = 8 CPU, 16 GiB
  daytona:      { resources: { cpu: 8, memory: 16 } },     // memory in GiB; requires image-based creation (see providers.ts)
  northflank:   { deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN || 'nf-compute-50', ephemeralStorageSize: 5120 },  // 5 GiB ephemeral storage
  declaw:       { templateId: 'node-large' },              // node-large template: 8 vCPU / 16 GiB RAM / 8 GiB disk
  superserve:   { templateId: 'node22-8cpu-16gb' },           // 8 vCPU / 16 GiB template built in the pre-step
  createos:     { shape: 's-8vcpu-16gb', ephemeralDiskMb: 61440 }, // 8 vCPU, 16 GiB RAM, 60 GiB disk
  opencomputer: { cpuCount: 4, memoryMB: 16384, timeout: 600_000 },
  sandbox0:    { memory: 16384 },  // Sandbox0 exposes only `memory`
};

function getSandboxOptionsWithResources(providerName: string, baseOptions?: Record<string, any>): Record<string, any> {
  const resourceOpts = DAX_RESOURCE_OPTIONS[providerName];
  if (!resourceOpts) return baseOptions ?? {};
  return { ...baseOptions, ...resourceOpts };
}

/** Runs the build script inside `sandbox` and parses its structured output. */
async function runDaxBuild(sandbox: any, providerName: string, buildTimeout: number): Promise<DaxTimingResult> {
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
  const result = await withTimeout(
    sandbox.runCommand(shellCmd, { timeout: buildTimeout }),
    buildTimeout,
    'Dax benchmark timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };
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
    }
  }

  for (const line of stderr.split('\n')) {
    if (line.startsWith('BENCH_ERROR\t')) {
      const parts = line.split('\t');
      benchError = parts.slice(1).join(': ');
    }
  }

  if (exitCode !== 0 && !benchError) {
    // Include last few lines of stderr for diagnostics
    const tail = stderr.trim().split('\n').slice(-3).join(' | ');
    benchError = 'Script exited with code ' + exitCode + (tail ? ': ' + tail : '');
  }

  // Count completed phases
  const phaseKeys = ['prepare', 'cache_clear', 'bun_download', 'bun_unpack', 'clone', 'install', 'typecheck'];
  const rawPhasesCompleted = phaseKeys.filter(k => phases[k] !== undefined).length;
  // The script's phase() function emits BENCH_PHASE even for the failing phase (it prints timing before checking exit code).
  // When there's an error, the last phase that emitted a BENCH_PHASE line is the one that failed, so don't count it.
  const phasesCompleted = benchError ? Math.max(0, rawPhasesCompleted - 1) : rawPhasesCompleted;
  // Determine which phase failed so we can exclude its timing from the result.
  // The failed phase is the last one that emitted BENCH_PHASE (index rawPhasesCompleted - 1).
  const failedPhaseKey = benchError && rawPhasesCompleted > 0 ? phaseKeys[rawPhasesCompleted - 1] : null;

  // If no phases completed, the script didn't actually run (e.g. heredoc failure)
  if (phasesCompleted === 0 && !benchError) {
    const tail = stderr.trim().split('\n').slice(-2).join(' | ');
    benchError = 'No benchmark phases completed' + (tail ? ': ' + tail : '');
  }

  return {
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
    .map(([name, latencyMs]) => ({ name, status: 'success', latencyMs }));
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const p = ctx.participant;
  const compute = p.createCompute();
  const opts = getSandboxOptionsWithResources(p.name, p.sandboxOptions);

  const sandbox = await ctx.step('create', () =>
    withTimeout<{ destroy(): Promise<unknown> }>(
      compute.sandbox.create(opts),
      p.timeout ?? timeout,
      'Sandbox creation timed out',
    ),
  );

  let timing: DaxTimingResult;
  try {
    timing = await ctx.step('build', () => runDaxBuild(sandbox, p.name, p.timeout ?? timeout));
  } finally {
    await ctx
      .step('destroy', () => withTimeout(sandbox.destroy(), p.destroyTimeoutMs ?? destroyTimeoutMs, 'Destroy timeout'), {
        reportConcurrency: false,
      })
      .catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
  }

  const data = timing as unknown as JsonObject;
  const steps = daxPhaseSteps(timing);

  if (timing.error) {
    throw new TaskError(timing.error, { code: 'dax_failed', data, steps });
  }
  return { data, steps, latencyMs: timing.totalMs };
});
