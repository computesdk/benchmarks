import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProviderConfig, Stats } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';
import { VMTier } from '@codesandbox/sdk';

// The benchmark script is now loaded from the local filesystem (scripts/dax-benchmark.sh)
// rather than fetched over HTTP from upstream. This avoids a curl dependency inside the
// sandbox (some providers don't ship curl). The previous upstream URL was:
//   https://raw.githubusercontent.com/anomalyco/opencode/provider-benchmark/script/provider-benchmark.sh
const BENCH_SCRIPT_PATH = path.resolve(import.meta.dirname, '../../scripts/dax-benchmark.sh');

// Standardized resource sizing for fair comparison across providers.
// Target: 8 vCPU, 16 GiB RAM.
// Each provider uses different parameter names and units, so we map per-provider.
// Providers not listed here don't support CPU/memory configuration at sandbox creation time.
// Note: E2B sets CPU/memory at template build time, not at sandbox creation.
const DAX_RESOURCE_OPTIONS: Record<string, Record<string, any>> = {
  modal:        { cpu: 4, cpuLimit: 4, memoryMiB: 16384 }, // Modal: 1 core = 2 vCPUs, so 4 cores = 8 vCPUs
  tensorlake:   { cpus: 8, memoryMb: 16384 },
  isorun:       { vcpus: 8, memMiB: 16384 },
  runloop:      { launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: 8, custom_gb_memory: 16 } },
  upstash:      { size: 'large' },                          // large = 8 cores, 16 GB
  vercel:       { resources: { vcpus: 8 } },               // no memory control
  blaxel:       { memory: 16384 },                          // CPU derived: cores = memory_MB / 2048 = 8
  beam:         { cpu: 8, memory: 16384 },                   // cpu = cores, memory = MiB
  codesandbox:  { vmTier: VMTier.Small },                  // Small = 8 CPU, 16 GiB
  daytona:      { resources: { cpu: 8, memory: 16 } },     // memory in GiB; requires image-based creation (see providers.ts)
  northflank:   { deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN || 'nf-compute-50' },  // resolved by scripts/find-northflank-plan.ts
  declaw:       { templateId: 'node-large' },              // node-large template: 8 vCPU / 16 GiB RAM / 8 GiB disk
  superserve:   { vcpu: 8, memoryMib: 16384 },               // vcpu = cores, memoryMib = MiB; overrides template defaults
};

function getSandboxOptionsWithResources(providerName: string, baseOptions?: Record<string, any>): Record<string, any> {
  const resourceOpts = DAX_RESOURCE_OPTIONS[providerName];
  if (!resourceOpts) return baseOptions ?? {};
  return { ...baseOptions, ...resourceOpts };
}

export interface DaxTimingResult {
  totalMs: number;
  phasesCompleted?: number;
  phasesTotal?: number;
  prepareMs?: number;
  bunDownloadMs?: number;
  bunUnpackMs?: number;
  cloneMs?: number;
  installMs?: number;
  typecheckMs?: number;
  cacheClearMs?: number;
  diskAfterClone?: number;
  diskAfterInstall?: number;
  diskAfterTypecheck?: number;
  commit?: string;
  bunVersion?: string;
  nodeVersion?: string;
  architecture?: string;
  kernel?: string;
  logicalCpus?: string;
  cpuModel?: string;
  memoryKib?: string;
  error?: string;
}

export interface DaxBenchmarkResult {
  provider: string;
  mode: 'sandbox-dax';
  iterations: DaxTimingResult[];
  summary: {
    totalMs: Stats;
    prepareMs: Stats;
    bunDownloadMs: Stats;
    bunUnpackMs: Stats;
    cloneMs: Stats;
    installMs: Stats;
    typecheckMs: Stats;
  };
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export async function runDaxBenchmark(config: ProviderConfig): Promise<DaxBenchmarkResult> {
  const { name, iterations = 3, timeout = 600_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'sandbox-dax',
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: DaxTimingResult[] = [];

  console.log(`\n--- Dax Benchmark: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    let sandbox: any = null;

    try {
      sandbox = await withTimeout(compute.sandbox.create(getSandboxOptionsWithResources(name, sandboxOptions)), timeout, 'Sandbox creation timed out');
      const result = await runDaxIteration(sandbox, name, timeout);
      results.push(result);
      if (result.error) {
        const parts = [];
        if (result.prepareMs) parts.push(`prepare ${(result.prepareMs / 1000).toFixed(2)}s`);
        if (result.bunDownloadMs) parts.push(`bun dl ${(result.bunDownloadMs / 1000).toFixed(2)}s`);
        if (result.bunUnpackMs) parts.push(`bun unpack ${(result.bunUnpackMs / 1000).toFixed(2)}s`);
        if (result.cloneMs) parts.push(`clone ${(result.cloneMs / 1000).toFixed(2)}s`);
        if (result.installMs) parts.push(`install ${(result.installMs / 1000).toFixed(2)}s`);
        if (result.typecheckMs) parts.push(`typecheck ${(result.typecheckMs / 1000).toFixed(2)}s`);
        const phaseStr = parts.length > 0 ? ` | ${parts.join(' | ')}` : '';
        const score = result.phasesCompleted != null ? `${result.phasesCompleted}/${result.phasesTotal}` : '';
        console.log(`    FAILED${score ? ` (${score} phases)` : ''}: ${result.error}${phaseStr}`);
      } else {
        const fmt = (ms?: number) => ms ? `${(ms / 1000).toFixed(2)}s` : 'N/A';
        console.log(`    OK (${result.phasesCompleted}/${result.phasesTotal}): total ${fmt(result.totalMs)} | prepare ${fmt(result.prepareMs)} | clone ${fmt(result.cloneMs)} | install ${fmt(result.installMs)} | typecheck ${fmt(result.typecheckMs)}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ totalMs: 0, error });
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

  const successful = results.filter(r => !r.error);
  const withTiming = results.filter(r => r.totalMs > 0 && (r.phasesCompleted ?? 0) > 0);

  return {
    provider: name,
    mode: 'sandbox-dax',
    iterations: results,
    summary: withTiming.length > 0 ? summarize(withTiming) : emptySummary(),
    successRate: results.length > 0 ? successful.length / results.length : 0,
  };
}

async function runDaxIteration(sandbox: any, providerName: string, timeout: number): Promise<DaxTimingResult> {
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
    sandbox.runCommand(shellCmd, { timeout }),
    timeout,
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

function summarize(results: DaxTimingResult[]): DaxBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  const pick = (key: keyof DaxTimingResult) => {
    const values = results.map(r => r[key]).filter((v): v is number => typeof v === 'number' && v > 0);
    return values.length > 0 ? computeStats(values) : empty;
  };
  return {
    totalMs: pick('totalMs'),
    prepareMs: pick('prepareMs'),
    bunDownloadMs: pick('bunDownloadMs'),
    bunUnpackMs: pick('bunUnpackMs'),
    cloneMs: pick('cloneMs'),
    installMs: pick('installMs'),
    typecheckMs: pick('typecheckMs'),
  };
}

function emptySummary(): DaxBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  return { totalMs: empty, prepareMs: empty, bunDownloadMs: empty, bunUnpackMs: empty, cloneMs: empty, installMs: empty, typecheckMs: empty };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function writeDaxResultsJson(results: DaxBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      totalMs: round(i.totalMs),
      ...(i.phasesCompleted !== undefined ? { phasesCompleted: i.phasesCompleted } : {}),
      ...(i.phasesTotal !== undefined ? { phasesTotal: i.phasesTotal } : {}),
      ...(i.prepareMs !== undefined ? { prepareMs: round(i.prepareMs) } : {}),
      ...(i.cacheClearMs !== undefined ? { cacheClearMs: round(i.cacheClearMs) } : {}),
      ...(i.bunDownloadMs !== undefined ? { bunDownloadMs: round(i.bunDownloadMs) } : {}),
      ...(i.bunUnpackMs !== undefined ? { bunUnpackMs: round(i.bunUnpackMs) } : {}),
      ...(i.cloneMs !== undefined ? { cloneMs: round(i.cloneMs) } : {}),
      ...(i.installMs !== undefined ? { installMs: round(i.installMs) } : {}),
      ...(i.typecheckMs !== undefined ? { typecheckMs: round(i.typecheckMs) } : {}),
      ...(i.diskAfterClone !== undefined ? { diskAfterClone: i.diskAfterClone } : {}),
      ...(i.diskAfterInstall !== undefined ? { diskAfterInstall: i.diskAfterInstall } : {}),
      ...(i.diskAfterTypecheck !== undefined ? { diskAfterTypecheck: i.diskAfterTypecheck } : {}),
      ...(i.commit ? { commit: i.commit } : {}),
      ...(i.bunVersion ? { bunVersion: i.bunVersion } : {}),
      ...(i.nodeVersion ? { nodeVersion: i.nodeVersion } : {}),
      ...(i.architecture ? { architecture: i.architecture } : {}),
      ...(i.kernel ? { kernel: i.kernel } : {}),
      ...(i.logicalCpus ? { logicalCpus: i.logicalCpus } : {}),
      ...(i.cpuModel ? { cpuModel: i.cpuModel } : {}),
      ...(i.memoryKib ? { memoryKib: i.memoryKib } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: Object.fromEntries(Object.entries(r.summary).map(([key, stats]) => [key, {
      median: round(stats.median),
      p95: round(stats.p95),
      p99: round(stats.p99),
    }])),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: { mode: 'sandbox-dax', timeoutMs: 600000, scriptSource: 'local', scriptPath: BENCH_SCRIPT_PATH },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
