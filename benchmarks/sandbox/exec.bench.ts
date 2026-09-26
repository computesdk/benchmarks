/**
 * Sandbox exec latency benchmark. Measures the per-command round-trip time of
 * `sandbox.runCommand` once the sandbox is already up — the dominant cost in
 * agentic workloads, which run dozens of sequential execs per sandbox.
 * Complements `tti.bench.ts`, which only measures cold start.
 *
 * Unit of work: create sandbox → one warm-up command → 25 sequential trivial
 * commands (`echo bench`, timed individually) → a burst of 5 concurrent
 * commands (wall time) → destroy. Declarative — exports `config` + `task`;
 * `bench run` owns the entrypoint.
 *
 *   bench run benchmarks/sandbox/exec.bench.ts --iterations 3 --provider e2b,modal
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key`: they get-or-create one shared run and each claims its own worker.
 *
 *   bench run benchmarks/sandbox/exec.bench.ts --provider e2b   --run-key "$GITHUB_RUN_ID"
 *   bench run benchmarks/sandbox/exec.bench.ts --provider modal --run-key "$GITHUB_RUN_ID"
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { computeStats } from '../src/util/stats.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import type { SandboxInterface } from 'computesdk';

const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;

/** Sequential commands per iteration — mirrors an agentic tool-call loop. */
const LOOP_COMMANDS = 25;
/** Concurrent commands in the parallel burst. */
const PARALLEL_COMMANDS = 5;
/** Present on every default image (shell builtin and /bin/echo). */
const LOOP_COMMAND = 'echo bench';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-exec',
  benchmarkName: 'Sandbox Exec Latency',
  iterations: 3,
  concurrency: 1,
  participants: providers,
  display: {
    metrics: [
      { key: 'execMedianMs', label: 'Exec median', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'execP95Ms', label: 'Exec p95', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'execMinMs', label: 'Exec min', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'execMaxMs', label: 'Exec max', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'parallelExecMs', label: 'Parallel burst (5)', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'commandsRun', label: 'Commands run', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'exec.warmup', label: 'Warm-up command' },
      { key: 'exec.loop', label: 'Sequential exec loop' },
      { key: 'exec.parallel', label: 'Parallel exec burst' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  // The scoring engine trims and computes median/p95/p99 of each metric across
  // iterations, so the scored key is a per-iteration aggregate: the median
  // per-command latency within this iteration.
  scoring: {
    metrics: [
      { key: 'execMedianMs', unit: 'ms', ceiling: 2000, weights: { median: 0.60, p95: 0.25, p99: 0.15 } },
    ],
  },
});

/** The slice of a provider's sandbox this workload actually touches. */
interface ExecSandbox extends SandboxInterface {}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;
  const compute = participant.createCompute();

  let sandbox: ExecSandbox | undefined;

  try {
    sandbox = await step('create', () =>
      withTimeout<ExecSandbox>(
        compute.sandbox.create(participant.sandboxOptions),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Sandbox creation timed out',
      ),
    );
    if (sandbox === undefined) {
      throw new Error('create step did not return a sandbox');
    }
    const commandSandbox = sandbox;

    await step('exec.warmup', async () => {
      const r = await withTimeout(
        commandSandbox.runCommand('node -v'),
        COMMAND_TIMEOUT_MS,
        'Warm-up command timed out',
      );
      if (r.exitCode !== 0) {
        log('warm-up command failed', { level: 'error', meta: { exitCode: r.exitCode, stderr: r.stderr ?? null } });
        throw new Error(`Warm-up command failed with exit code ${r.exitCode}: ${r.stderr || 'Unknown error'}`);
      }
    });

    const stats = await step('exec.loop', async () => {
      const latencies: number[] = [];
      for (let i = 0; i < LOOP_COMMANDS; i++) {
        const t0 = performance.now();
        const r = await withTimeout(
          commandSandbox.runCommand(LOOP_COMMAND),
          COMMAND_TIMEOUT_MS,
          `Command ${i + 1}/${LOOP_COMMANDS} timed out`,
        );
        latencies.push(performance.now() - t0);
        if (r.exitCode !== 0) {
          log('exec loop command failed', {
            level: 'error',
            meta: { index: i, exitCode: r.exitCode, stderr: r.stderr ?? null },
          });
          throw new Error(`Command ${i + 1}/${LOOP_COMMANDS} failed with exit code ${r.exitCode}: ${r.stderr || 'Unknown error'}`);
        }
      }
      const { median, p95 } = computeStats(latencies, 0);
      const result = {
        execMedianMs: median,
        execP95Ms: p95,
        execMinMs: Math.min(...latencies),
        execMaxMs: Math.max(...latencies),
        commandsRun: latencies.length,
      };
      measure(result);
      return result;
    });

    const parallelExecMs = await step('exec.parallel', async () => {
      const t0 = performance.now();
      const results = await withTimeout(
        Promise.all(
          Array.from({ length: PARALLEL_COMMANDS }, () => commandSandbox.runCommand(LOOP_COMMAND)),
        ),
        COMMAND_TIMEOUT_MS,
        'Parallel exec burst timed out',
      );
      const elapsed = performance.now() - t0;
      const failed = results.find((r) => r.exitCode !== 0);
      if (failed) {
        log('parallel exec command failed', { level: 'error', meta: { exitCode: failed.exitCode, stderr: failed.stderr ?? null } });
        throw new Error(`Parallel exec command failed with exit code ${failed.exitCode}: ${failed.stderr || 'Unknown error'}`);
      }
      measure({ parallelExecMs: elapsed });
      return elapsed;
    });

    const data = { ...stats, parallelExecMs };
    measure(data);
    return { data };
  } finally {
    if (sandbox) {
      await step('destroy', () =>
        withTimeout(sandbox!.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) => log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }));
      log('sandbox', { level: 'info', meta: { provider: participant.name, sandboxId: sandboxId(sandbox) } });
    }
  }
});
