/**
 * Repo benchmark: how long a fresh sandbox takes to go from "created" to
 * "real work done". One iteration = sandbox create → first command returns
 * (`ttiMs`) → clone + install + build of vercel/next.js (`readyMs` = TTI →
 * build exit). The point is the gap between the two: a provider can report a
 * 50ms TTI and still take 30s to make the filesystem usable.
 *
 * Timed boundary: compute.sandbox.create() → `pnpm build` exit inside the
 * sandbox; destroy excluded. Phase timings (prepare / cache_clear / clone /
 * toolchain / install / build) are measured inside the guest by
 * benchmarks/scripts/repo-benchmark.sh (same BENCH_* protocol as dax).
 *
 * `groupBy: 'round'` so the task owns its measured `latencyMs` (readyMs) and
 * attaches pre-measured phase steps.
 *
 * Run:
 *   bench run benchmarks/sandbox/repo.bench.ts
 *   bench run benchmarks/sandbox/repo.bench.ts --provider e2b,modal
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
import { getSandboxOptionsWithResources } from './resource-options.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The build script uploaded into each sandbox. */
const BENCH_SCRIPT_PATH = path.resolve(__dirname, '../scripts/repo-benchmark.sh');

/** Timing + metadata parsed out of the build script's BENCH_* lines. */
interface RepoTimingResult {
  totalMs: number;
  phasesCompleted?: number;
  phasesTotal?: number;
  prepareMs?: number;
  cacheClearMs?: number;
  cloneMs?: number;
  toolchainMs?: number;
  installMs?: number;
  buildMs?: number;
  diskAfterClone?: number;
  diskAfterInstall?: number;
  diskAfterBuild?: number;
  commit?: string;
  pnpmVersion?: string;
  nodeVersion?: string;
  architecture?: string;
  kernel?: string;
  logicalCpus?: string;
  cpuModel?: string;
  memoryKib?: string;
  error?: string;
}

/** Raw build output kept alongside the timing so failures can be diagnosed from the logs. */
interface RepoBuildOutput {
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

const CREATE_TIMEOUT_MS = 600_000;
const READY_TIMEOUT_MS = 30_000;
const WORK_TIMEOUT_MS = 900_000;
const DESTROY_TIMEOUT_MS = 15_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: `sandbox-repo${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Sandbox Repo${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  iterations: 1,
  concurrency: 1,
  groupBy: 'round',
  defaultProviders: ['e2b', 'modal', 'tensorlake'],
  participants: providers,
  scoring: {
    metrics: [
      { key: 'ttiMs', unit: 'ms', ceiling: 30_000, weights: { median: 0.20, p95: 0.06, p99: 0.04 } },
      { key: 'readyMs', unit: 'ms', ceiling: 900_000, weights: { median: 0.40, p95: 0.20, p99: 0.10 } },
    ],
  },
  display: {
    metrics: [
      { key: 'readyMs', label: 'Time to real work', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'ttiMs', label: 'TTI (create + first command)', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'workMs', label: 'Clone + install + build', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'prepareMs', label: 'Prepare', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'cacheClearMs', label: 'Cache clear', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'cloneMs', label: 'Clone', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'toolchainMs', label: 'Toolchain (pnpm)', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'installMs', label: 'Install', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'buildMs', label: 'Build', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'phasesCompleted', label: 'Phases completed', direction: 'higher-better', decimals: 0 },
      { key: 'phasesTotal', label: 'Phases total', direction: 'higher-better', decimals: 0 },
      { key: 'diskAfterClone', label: 'Disk after clone', unit: 'bytes', direction: 'lower-better', decimals: 0 },
      { key: 'diskAfterInstall', label: 'Disk after install', unit: 'bytes', direction: 'lower-better', decimals: 0 },
      { key: 'diskAfterBuild', label: 'Disk after build', unit: 'bytes', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'ready', label: 'First command (TTI)' },
      { key: 'work', label: 'Repo workload' },
      { key: 'destroy', label: 'Destroy sandbox' },
      { key: 'prepare', label: 'Prepare' },
      { key: 'cache_clear', label: 'Cache clear' },
      { key: 'clone', label: 'Clone' },
      { key: 'toolchain', label: 'Toolchain (pnpm)' },
      { key: 'install', label: 'Install' },
      { key: 'build', label: 'Build' },
    ],
    overview: { defaultMetric: 'task', defaultLayout: 'ranking' },
  },
});

/** Runs the build script inside `sandbox` and parses its structured output. */
async function runRepoBuild(
  sandbox: any,
  providerName: string,
  buildTimeout: number,
): Promise<{ timing: RepoTimingResult; output: RepoBuildOutput }> {
  // Load the benchmark script from the local filesystem rather than fetching
  // it over HTTP inside the sandbox. This eliminates a curl dependency
  // (several providers don't ship curl in their sandboxes).
  const benchScript = fs.readFileSync(BENCH_SCRIPT_PATH, 'utf8');

  // Write the benchmark script to /tmp inside the sandbox via a single-quoted
  // heredoc (so $ and backticks in the script are not expanded) and execute it
  // directly with bash. A random marker avoids collisions with anything
  // appearing on its own line inside the script.
  const marker = '__REPO_BENCH_HEREDOC_' + Math.random().toString(36).slice(2) + '__';
  const shellCmd =
    `cat > /tmp/repo-benchmark.sh <<'${marker}'\n` +
    benchScript +
    `\n${marker}\n` +
    `BENCH_PROVIDER=${providerName} BENCH_REGION=unknown bash /tmp/repo-benchmark.sh`;

  const totalStart = Date.now();
  let result: { exitCode: number; stdout?: string; stderr?: string };
  try {
    result = await withTimeout(
      sandbox.runCommand(shellCmd, { timeout: buildTimeout }),
      buildTimeout,
      `Repo benchmark timed out after ${buildTimeout}ms`,
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
  const phaseKeys = ['prepare', 'cache_clear', 'clone', 'toolchain', 'install', 'build'];
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

  const output: RepoBuildOutput = { exitCode, stdout, stderr, ...(failedPhase ? { failedPhase } : {}) };

  const timing: RepoTimingResult = {
    totalMs,
    phasesCompleted,
    phasesTotal: phaseKeys.length,
    prepareMs: failedPhaseKey === 'prepare' ? undefined : phases.prepare,
    cacheClearMs: failedPhaseKey === 'cache_clear' ? undefined : phases.cache_clear,
    cloneMs: failedPhaseKey === 'clone' ? undefined : phases.clone,
    toolchainMs: failedPhaseKey === 'toolchain' ? undefined : phases.toolchain,
    installMs: failedPhaseKey === 'install' ? undefined : phases.install,
    buildMs: failedPhaseKey === 'build' ? undefined : phases.build,
    diskAfterClone: disk.after_clone,
    diskAfterInstall: disk.after_install,
    diskAfterBuild: disk.after_build,
    commit: doneCommit || meta.commit,
    pnpmVersion: meta.pnpm_version,
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

/** Emit each measured workload phase as a pre-measured platform step. */
function repoPhaseSteps(t: RepoTimingResult): TaskStepRecord[] {
  const phases: [string, number | undefined][] = [
    ['prepare', t.prepareMs],
    ['cache_clear', t.cacheClearMs],
    ['clone', t.cloneMs],
    ['toolchain', t.toolchainMs],
    ['install', t.installMs],
    ['build', t.buildMs],
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

  const createStart = performance.now();
  const sandbox = await ctx.step('create', () =>
    withTimeout<{ destroy(): Promise<unknown>; runCommand(cmd: string, opts?: any): Promise<any> }>(
      compute.sandbox.create(opts),
      p.timeout ?? CREATE_TIMEOUT_MS,
      'Sandbox creation timed out',
    ),
  ).catch((err: unknown) => {
    const message = `sandbox create failed after ${Date.now() - createStart}ms: ${formatError(err)}`;
    log('Sandbox create failed', { level: 'error', meta: { provider: p.name, error: message } });
    console.error(`  [${p.name}] ${message}`);
    throw new TaskError(message, { code: 'create_failed', data: { error: message } });
  });
  const createMs = performance.now() - createStart;

  let ttiMs: number | undefined;
  let timing: RepoTimingResult;
  let output: RepoBuildOutput | undefined;
  try {
    // TTI = create + first command round-trip. Any exit code counts: the point
    // is that exec answers, not that node exists (the workload installs it if
    // missing). A throw/timeout means the sandbox isn't actually usable.
    const commandStart = performance.now();
    const ready = await ctx.step('ready', async () => ({
      result: await withTimeout(
        sandbox.runCommand('node -v'),
        READY_TIMEOUT_MS,
        'First command execution timed out',
      ),
    }));
    ttiMs = createMs + (performance.now() - commandStart);
    log('first command returned', {
      level: 'info',
      meta: { exitCode: ready.result.exitCode, stdout: ready.result.stdout?.trim() ?? null },
    });

    const work = await ctx.step('work', async () => {
      const build = await runRepoBuild(sandbox, p.name, p.timeout ?? WORK_TIMEOUT_MS);
      const t = build.timing;
      const workMetrics: JsonObject = { totalMs: t.totalMs };
      if (t.phasesCompleted !== undefined) workMetrics.phasesCompleted = t.phasesCompleted;
      if (t.phasesTotal !== undefined) workMetrics.phasesTotal = t.phasesTotal;
      if (t.diskAfterClone !== undefined) workMetrics.diskAfterClone = t.diskAfterClone;
      if (t.diskAfterInstall !== undefined) workMetrics.diskAfterInstall = t.diskAfterInstall;
      if (t.diskAfterBuild !== undefined) workMetrics.diskAfterBuild = t.diskAfterBuild;
      ctx.measure(workMetrics);
      return build;
    });
    timing = work.timing;
    output = work.output;
  } finally {
    await ctx
      .step('destroy', () => withTimeout(sandbox.destroy(), p.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timeout'), {
        reportConcurrency: false,
      })
      .catch((err: unknown) => log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }));
    log('sandbox', { level: 'info', meta: { provider: p.name, sandboxId: sandboxId(sandbox) } });
  }

  const workMs = [timing.cloneMs, timing.toolchainMs, timing.installMs, timing.buildMs]
    .reduce<number | undefined>((acc, v) => (acc === undefined || v === undefined ? undefined : acc + v), 0);
  const readyMs = ttiMs !== undefined && workMs !== undefined ? ttiMs + workMs : undefined;

  ctx.measure({
    ...(ttiMs !== undefined ? { ttiMs } : {}),
    ...(workMs !== undefined ? { workMs } : {}),
    ...(readyMs !== undefined ? { readyMs } : {}),
  });

  const data: JsonObject = {
    ...(timing as unknown as JsonObject),
    ...(ttiMs !== undefined ? { ttiMs } : {}),
    ...(workMs !== undefined ? { workMs } : {}),
    ...(readyMs !== undefined ? { readyMs } : {}),
    ...(output?.failedPhase ? { failedPhase: output.failedPhase } : {}),
  };
  const steps = repoPhaseSteps(timing);

  if (timing.error) {
    const stdoutTail = output ? tail(output.stdout, OUTPUT_TAIL_LINES) : '';
    const stderrTail = output ? tail(output.stderr, OUTPUT_TAIL_LINES) : '';
    log('Repo build failed', {
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
        `  [${p.name}] Repo build failed${output?.failedPhase ? ` in ${output.failedPhase}` : ''}` +
          ` (${timing.phasesCompleted}/${timing.phasesTotal} phases, exit ${output?.exitCode ?? 'n/a'}): ${timing.error}`,
        ...(stderrTail ? ['  --- stderr (tail) ---', indent(stderrTail)] : []),
        ...(stdoutTail ? ['  --- stdout (tail) ---', indent(stdoutTail)] : []),
      ].join('\n'),
    );
    throw new TaskError(timing.error, { code: 'repo_failed', data, steps });
  }

  log('Repo build completed', {
    level: 'info',
    meta: {
      provider: p.name,
      ...(ttiMs !== undefined ? { ttiMs } : {}),
      ...(workMs !== undefined ? { workMs } : {}),
      ...(readyMs !== undefined ? { readyMs } : {}),
      phasesCompleted: `${timing.phasesCompleted}/${timing.phasesTotal}`,
      ...(timing.commit ? { commit: timing.commit } : {}),
      ...(timing.nodeVersion ? { nodeVersion: timing.nodeVersion } : {}),
      ...(timing.pnpmVersion ? { pnpmVersion: timing.pnpmVersion } : {}),
      ...(timing.architecture ? { architecture: timing.architecture } : {}),
    },
  });
  return { data, steps, ...(readyMs !== undefined ? { latencyMs: readyMs } : {}) };
});
