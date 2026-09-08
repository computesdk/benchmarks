/**
 * Structured logging and step output capture.
 *
 * - `ctx.log` accepts a level (`debug`, `info`, `warn`, `error`) and optional
 *   metadata, or a plain metadata object (default level `info`).
 * - A step that returns an object whose keys are only `stdout`, `stderr`,
 *   `error`, `exitCode`, `code`, `signal`, or `pid` is treated as step output
 *   and appended to the worker log. The return value is still available to the
 *   task.
 * - Pass `captureOutput: false` to `step` to return such an object as a normal
 *   result instead of writing it to the worker log.
 *
 * Run:
 *   pnpm exec bench run examples/11-logging.bench.ts --dry-run
 *   BENCHMARK_LOG_LEVEL=debug pnpm exec bench run examples/11-logging.bench.ts --dry-run
 */
import { execSync } from 'node:child_process';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'logging-demo',
  benchmarkName: 'Logging and Step Output Demo',
  iterations: 3,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  display: {
    description: 'Structured logging and step output capture.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'work', label: 'Work' },
      { key: 'node-version', label: 'Node version' },
      { key: 'safe-node-version', label: 'Safe node version' },
      { key: 'parse-version', label: 'Parse version' },
    ],
    overview: { defaultMetric: 'durationMs', defaultLayout: 'ranking' },
  },
  scoring: {
    metrics: [
      { key: 'durationMs', ceiling: 1000, weights: { median: 0.7, p95: 0.2, p99: 0.1 } },
    ],
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNodeVersion(): string {
  return execSync('node --version', { encoding: 'utf8' }).trim();
}

export const task = defineTask(async (ctx: TaskContext<LocalParticipant>) => {
  const { taskIndex, step, measure, log } = ctx;

  // Levels: debug, info, warn, error. `meta` is JSON metadata attached to the log line.
  log('starting task', { level: 'info', meta: { taskIndex } });
  log('verbose trace only visible when BENCHMARK_LOG_LEVEL=debug', { level: 'debug' });

  const start = performance.now();
  await step('work', () => sleep(20 + Math.random() * 30));
  measure({ durationMs: performance.now() - start });

  // Step return value matches BenchmarkStepOutcome -> captured as step output.
  const { stdout, stderr, exitCode } = await step('node-version', () => {
    const version = getNodeVersion();
    return { stdout: version, stderr: '', exitCode: 0 };
  });
  if (exitCode !== 0) {
    throw new TaskError('node version check failed', {
      code: 'VERSION_CHECK_FAILED',
      data: { exitCode, stderr },
    });
  }
  log('detected node version', { level: 'info', meta: { version: stdout } });

  // captureOutput: false returns the outcome-shaped object as a normal result.
  const { stdout: rawStdout } = await step(
    'safe-node-version',
    () => {
      const version = getNodeVersion();
      return { stdout: version, stderr: '', exitCode: 0 };
    },
    { captureOutput: false },
  );
  log('safe version from captureOutput:false step', { level: 'debug', meta: { version: rawStdout } });

  // A result that does not match the step-outcome shape is returned normally.
  const { version } = await step('parse-version', () => ({ version: rawStdout.replace(/^v/, '') }));
  log('parsed version', { level: 'debug', meta: { version } });
});
