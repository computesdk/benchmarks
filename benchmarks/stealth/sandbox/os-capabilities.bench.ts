/**
 * OS capabilities benchmark: each task creates ONE fresh sandbox, uploads
 * docker-preflight.sh, runs it, and parses its PASS/WARN/FAIL verdict lines.
 * The script probes what a compute environment actually is and can do —
 * namespaces, cgroups, devices (kvm/fuse/tun/mknod), overlayfs, netfilter
 * NAT, sysctls, capabilities, syscall surface, outbound reachability — and
 * whether dockerd would run on it. Declarative — exports `config` + `task`;
 * `bench run` owns the entrypoint.
 *
 *   bench run benchmarks/stealth/sandbox/os-capabilities.bench.ts
 *   bench run benchmarks/stealth/sandbox/os-capabilities.bench.ts --iterations 3 --provider e2b
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key`: they get-or-create one shared run and each claims its own
 * worker.
 *
 * Each parsed capability is recorded as its own `step()` so the run renders
 * in the platform's capability-matrix layout (`byStep.defaultLayout:
 * 'matrix'`): providers × capabilities, ✓/✗ cells. A capability that never
 * probed (script couldn't run) leaves no step and renders as a dash.
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '@benchsdk/client';
import {
  defineBenchmarkConfig,
  defineTask,
  TaskError,
  type BenchmarkRunOutcome,
  type BenchmarkScoringConfig,
} from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig, ProviderCapabilityMatrix } from './types.js';
import {
  CAPABILITY_CHECKS,
  parsePreflightOutput,
  capabilityScore,
  type ParsedPreflight,
} from './os-capabilities.js';
import { writeOsCapabilitiesLegacyResults } from './os-capabilities-legacy-results.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const createTimeoutMs = 120_000;
const destroyTimeoutMs = 15_000;
/** The probe touches ~14 sections; 5 min covers slow sandbox exec channels. */
const preflightTimeoutMs = 300_000;

const PREFLIGHT_SCRIPT = fs.readFileSync(path.join(__dirname, 'docker-preflight.sh'), 'utf-8');
const REMOTE_PATH = '/tmp/docker-preflight.sh';
/** results/ is gitignored but collected by the workflow's artifact upload. */
const LOG_DIR = benchmarkResultsDir('os_capabilities/logs');

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PreflightSandbox {
  sandboxId: string;
  filesystem?: {
    mkdir(path: string): Promise<void>;
    writeFile(path: string, content: string): Promise<void>;
  };
  runCommand(command: string, options?: { timeout?: number }): Promise<CommandResult>;
  destroy(): Promise<unknown>;
}

interface Compute {
  sandbox: {
    create(options?: Record<string, any>): Promise<PreflightSandbox>;
  };
}

/**
 * Provider SDKs can leak errors outside the promise chain — an internal
 * stream error lands as an uncaughtException and kills the whole run. Route
 * them into the active task so they fail one iteration (recorded as
 * sdkAsyncError*) instead of crashing the benchmark.
 */
interface AsyncSdkError {
  message: string;
  source: 'uncaughtException' | 'unhandledRejection';
  stage: string;
}
let activeTaskErrorSink: ((message: string, source: AsyncSdkError['source']) => void) | undefined;

process.on('uncaughtException', (err) => {
  if (activeTaskErrorSink) activeTaskErrorSink(formatError(err), 'uncaughtException');
  else console.error('[bench] uncaughtException outside task scope:', err);
});
process.on('unhandledRejection', (reason) => {
  if (activeTaskErrorSink) activeTaskErrorSink(formatError(reason), 'unhandledRejection');
  else console.error('[bench] unhandledRejection outside task scope:', reason);
});

// One record = one full preflight probe in one fresh sandbox. Success means
// the probe ran to completion and produced a verdict (preflightRan) — a
// provider that can't host dockerd is a low capabilityScore, not a failed
// benchmark. The composite is the median capabilityScore (PASS=1, WARN=0.5,
// FAIL=0 over every check the script ran) times the probe success rate.
const scoringMetrics: BenchmarkScoringConfig['metrics'] = [
  { key: 'capabilityScore', label: 'Capability score', unit: 'score', ceiling: 100, higherIsBetter: true, weights: { median: 1, p95: 0, p99: 0 } },
  // Declared at weight 0 so the platform aggregates/displays them without
  // affecting the composite.
  { key: 'dockerdReady', label: 'dockerd ready', unit: 'score', ceiling: 1, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'passCount', label: 'PASS', unit: 'checks', ceiling: 200, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'warnCount', label: 'WARN', unit: 'checks', ceiling: 200, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'failCount', label: 'FAIL', unit: 'checks', ceiling: 200, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'preflightMs', label: 'Preflight', unit: 'ms', ceiling: preflightTimeoutMs, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'createMs', label: 'Create', unit: 'ms', ceiling: 120_000, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'destroyMs', label: 'Destroy', unit: 'ms', ceiling: 60_000, weights: { median: 0, p95: 0, p99: 0 } },
  { key: 'checksPassedPct', label: 'Supported %', unit: 'score', ceiling: 100, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 0 } },
];

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'os-capabilities',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox OS Capabilities',
  concurrency: 1,
  // Each iteration is a complete probe in a fresh sandbox — no shared state.
  iterations: 3,
  participants: providers,
  dimensions: {
    script: 'docker-preflight.sh',
    capabilities: CAPABILITY_CHECKS.map((c) => c.key).join(','),
  },
  display: {
    metrics: [
      { key: 'capabilityScore', label: 'Capability score', unit: 'score', direction: 'higher-better' as const, decimals: 1 },
      { key: 'dockerdReady', label: 'dockerd ready', unit: 'score', direction: 'higher-better' as const, decimals: 0 },
      { key: 'passCount', label: 'PASS', unit: 'checks', direction: 'higher-better' as const, decimals: 0 },
      { key: 'warnCount', label: 'WARN', unit: 'checks', direction: 'lower-better' as const, decimals: 0 },
      { key: 'failCount', label: 'FAIL', unit: 'checks', direction: 'lower-better' as const, decimals: 0 },
      { key: 'preflightMs', label: 'Preflight', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'createMs', label: 'Create', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'destroyMs', label: 'Destroy', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'checksPassed', label: 'Supported', unit: 'checks', direction: 'higher-better' as const, decimals: 0 },
      { key: 'checksPassedPct', label: 'Supported %', unit: 'score', direction: 'higher-better' as const, decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'preflight', label: 'Run docker-preflight.sh' },
      ...CAPABILITY_CHECKS.map((c) => ({ key: c.key, label: c.label })),
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    byStep: { defaultLayout: 'matrix' },
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' as const },
  },
  scoring: {
    // A successful record is a completed probe with a verdict, whatever the
    // verdict — the capability score carries the "can it run dockerd" answer.
    success: { requireData: { preflightRan: true } },
    metrics: scoringMetrics,
  },
  onComplete: async (outcome: BenchmarkRunOutcome) => {
    await writeOsCapabilitiesLegacyResults(outcome.participants, {
      resultsDir: benchmarkResultsDir('os_capabilities'),
    });
  },
});

/**
 * Get the script into the sandbox. Preferred path is the fs API; where a
 * provider's filesystem is scoped or absent, fall back to piping base64
 * chunks through runCommand — runCommand is the baseline sandbox contract.
 * Returns the remote path the script landed at.
 */
async function injectScript(sandbox: PreflightSandbox): Promise<string> {
  if (sandbox.filesystem && typeof sandbox.filesystem.writeFile === 'function') {
    for (const target of [REMOTE_PATH, 'docker-preflight.sh']) {
      try {
        await sandbox.filesystem.writeFile(target, PREFLIGHT_SCRIPT);
        return target;
      } catch { /* try the next path / transport */ }
    }
  }

  // Base64 through runCommand in chunks — safe alphabet for single-quoting,
  // and small chunks stay under per-command payload limits on any provider.
  const b64 = Buffer.from(PREFLIGHT_SCRIPT, 'utf-8').toString('base64');
  const CHUNK = 4096;
  await sandbox.runCommand('rm -f /tmp/docker-preflight.b64', { timeout: 15_000 });
  for (let i = 0; i < b64.length; i += CHUNK) {
    const res = await sandbox.runCommand(`printf '%s' '${b64.slice(i, i + CHUNK)}' >> /tmp/docker-preflight.b64`, { timeout: 15_000 });
    if (res.exitCode !== 0) {
      throw new Error(`inject_failed: base64 chunk write failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`.slice(0, 300));
    }
  }
  const res = await sandbox.runCommand('base64 -d /tmp/docker-preflight.b64 > /tmp/docker-preflight.sh && rm -f /tmp/docker-preflight.b64', { timeout: 15_000 });
  if (res.exitCode !== 0) {
    throw new Error(`inject_failed: base64 decode failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`.slice(0, 300));
  }
  return REMOTE_PATH;
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure, taskIndex } = ctx;
  const p = participant;

  const compute = p.createCompute() as Compute;
  const createTimeout = p.timeout ?? createTimeoutMs;
  const cleanupTimeout = p.destroyTimeoutMs ?? destroyTimeoutMs;

  // The capability matrix (`record.data.features`) — one entry per step the
  // matrix layout renders a cell for.
  const matrix: ProviderCapabilityMatrix = {};
  let failedStage = 'create';
  let failure: { stage: string; message: string } | undefined;
  const meta: Record<string, number | string | boolean> = { taskIndex };
  const asyncErrors: AsyncSdkError[] = [];
  const rStart = performance.now();
  measure({ taskIndex });

  activeTaskErrorSink = (message, source) => {
    asyncErrors.push({ message, source, stage: failedStage });
    console.error(`[${p.name}] async provider-SDK error during ${failedStage} (${source}): ${message}`);
  };

  let sandbox: PreflightSandbox | undefined;
  let rawOutput = '';
  let parsed: ParsedPreflight | undefined;

  const recordFailure = (stage: string, err: unknown) => {
    const errorMessage = formatError(err);
    console.error(`[${p.name}] os-capabilities task ${taskIndex} failed at ${stage}: ${errorMessage}`);
    failure = { stage, message: errorMessage };
    meta.failedStage = stage;
    meta.errorMessage = errorMessage;
    measure({ ...meta });
  };

  try {
    await step('create', async () => {
      const createStart = performance.now();
      sandbox = await withTimeout(
        compute.sandbox.create(p.sandboxOptions),
        createTimeout,
        'Sandbox creation timed out',
        (s) => s.destroy(),
      );
      meta.createMs = performance.now() - createStart;
      matrix['create'] = { passed: true };
      measure({ passed: true });
      log('sandbox created', { meta: { sandboxId: sandbox!.sandboxId, createMs: meta.createMs } });
    }).catch((err) => {
      recordFailure('create', err);
      matrix['create'] = { passed: false, error: meta.errorMessage as string };
    });

    if (sandbox) {
      failedStage = 'inject';
      await step('preflight', async () => {
        const scriptPath = await injectScript(sandbox!);

        failedStage = 'run';
        const runStart = performance.now();
        let res = await withTimeout(
          sandbox!.runCommand(`bash ${scriptPath}`, { timeout: preflightTimeoutMs }),
          preflightTimeoutMs + 10_000,
          'preflight runCommand timed out',
        );
        // Images without bash (alpine etc.) — the script mostly degrades
        // gracefully under POSIX sh; only its color escapes go literal.
        if (res.exitCode === 127 || /bash:\s*(command not found|not found|no such file)/i.test(res.stderr + res.stdout)) {
          res = await withTimeout(
            sandbox!.runCommand(`sh ${scriptPath}`, { timeout: preflightTimeoutMs }),
            preflightTimeoutMs + 10_000,
            'preflight runCommand (sh) timed out',
          );
        }
        meta.preflightMs = performance.now() - runStart;
        meta.preflightExitCode = res.exitCode;
        rawOutput = [res.stdout, res.stderr].filter(Boolean).join('\n');

        parsed = parsePreflightOutput(rawOutput, res.exitCode);
        if (parsed.checksTotal === 0) {
          throw new Error(`probe_empty: preflight produced no verdict lines (exit ${res.exitCode}) — output: ${rawOutput.slice(0, 300)}`);
        }
        meta.preflightRan = true;
        meta.dockerdReady = res.exitCode === 0;
        meta.checksTotal = parsed.checksTotal;
        meta.passCount = parsed.passCount;
        meta.warnCount = parsed.warnCount;
        meta.failCount = parsed.failCount;
        meta.capabilityScore = capabilityScore(parsed);
        meta.verdict = parsed.verdict;
        if (parsed.failures.length > 0) {
          meta.failures = parsed.failures.join('; ').slice(0, 2000);
        }
        if (parsed.missingCapabilities.length > 0) {
          meta.missingCaps = parsed.missingCapabilities.join(',');
        }
        for (const check of CAPABILITY_CHECKS) {
          meta[`cap_${check.key}`] = parsed.capabilities[check.key];
        }
        measure({ ...meta });
      }).catch((err) => recordFailure(failedStage, err));

      // One step per capability: the matrix layout reads step status, so a
      // supported capability returns cleanly and an unsupported one throws
      // inside the step (the throw is caught so every check still emits).
      // When the script never ran there is nothing to render — the cells
      // stay dashes.
      if (parsed) {
        for (const check of CAPABILITY_CHECKS) {
          const supported = parsed.capabilities[check.key] === true;
          await step(check.key, async () => {
            measure({ passed: supported });
            if (!supported) throw new Error(`${check.label} not supported`);
          }).catch(() => {});
          matrix[check.key] = supported
            ? { passed: true }
            : { passed: false, error: `${check.label} not supported` };
        }
      }
    }
  } finally {
    if (rawOutput) {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOG_DIR, `${p.name}-t${taskIndex}.log`), rawOutput);
      } catch { /* log persistence is best effort */ }
    }
    activeTaskErrorSink = undefined;
    if (sandbox) {
      const destroyStart = performance.now();
      await step('destroy', async () => {
        await withTimeout(sandbox!.destroy(), cleanupTimeout, 'Destroy timeout');
      }, { reportConcurrency: false }).then(
        () => {
          meta.destroyMs = performance.now() - destroyStart;
          matrix['destroy'] = { passed: true };
        },
        (err: unknown) => {
          const error = formatError(err);
          log('destroy failed', { level: 'warn', meta: { error } });
          meta.destroyFailed = true;
          meta.destroyError = error;
          matrix['destroy'] = { passed: false, error };
        },
      );
      measure({ destroyMs: meta.destroyMs ?? 0, destroyFailed: meta.destroyFailed === true });
    }
  }

  const wallClockMs = performance.now() - rStart;
  meta.wallClockMs = wallClockMs;
  measure({ wallClockMs });

  // An async error leaked out of the provider SDK mid-task corrupts whatever
  // follows it — record it and fail the iteration even if later steps ran.
  if (asyncErrors.length > 0) {
    meta.sdkAsyncErrorCount = asyncErrors.length;
    meta.sdkAsyncError = asyncErrors
      .map((e) => `${e.source} at ${e.stage}: ${e.message}`)
      .join('; ')
      .slice(0, 500);
  }

  const checksTotal = Object.keys(matrix).length;
  const checksPassed = Object.values(matrix).filter((f) => f.passed).length;
  const checksPassedPct = checksTotal === 0 ? 0 : Math.round((checksPassed / checksTotal) * 100);
  measure({ checksPassed, checksTotal, checksPassedPct });

  const out: JsonObject = Object.fromEntries(
    Object.entries({
      provider: p.name,
      taskIndex,
      ...meta,
      wallClockMs,
      features: matrix,
      checksPassed,
      checksTotal,
      checksPassedPct,
    }).filter(([, v]) => v !== undefined),
  ) as JsonObject;

  // A sandbox that cannot be torn down is a failed iteration, and so is one
  // whose SDK crashed asynchronously — but the probe results still get
  // reported alongside the failure.
  if (failure || meta.destroyFailed || asyncErrors.length > 0) {
    const stage = failure?.stage ?? (meta.destroyFailed ? 'destroy' : asyncErrors[0]!.stage);
    const message =
      failure?.message ??
      (meta.destroyFailed
        ? String(meta.destroyError)
        : `provider SDK async error: ${asyncErrors[0]!.message}`);
    throw new TaskError(`os-capabilities probe failed at ${stage}: ${message}`, {
      code: 'os_capabilities_probe_failed',
      data: { ...out, replicateMs: [wallClockMs], failedStage: stage, errorMessage: message } as unknown as JsonObject,
    });
  }

  log('os-capabilities probe completed', { level: 'info', meta: out });

  return {
    data: { ...out, replicateMs: [wallClockMs] } as unknown as JsonObject,
    latencyMs: typeof meta.preflightMs === 'number' ? meta.preflightMs : wallClockMs,
  };
});

export const beforeExit = () => drainLateCleanups();
