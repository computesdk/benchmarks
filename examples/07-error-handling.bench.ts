/**
 * Error handling: TaskError preserves code/data, step timeoutMs aborts long
 * steps, and try/finally cleans up resources.
 *
 * Run:
 *   pnpm exec bench run examples/07-error-handling.bench.ts --dry-run
 *   DEMO_SHOULD_FAIL=1 pnpm exec bench run examples/07-error-handling.bench.ts --dry-run
 *   DEMO_TIMEOUT=1 pnpm exec bench run examples/07-error-handling.bench.ts --iterations 1 --dry-run
 */
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'error-handling-demo',
  benchmarkName: 'Error Handling Demo',
  iterations: 3,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  display: {
    description: 'TaskError, step timeout, and cleanup behavior.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'acquire-resource', label: 'Acquire resource' },
      { key: 'risky', label: 'Risky step' },
      { key: 'work', label: 'Work' },
      { key: 'cleanup', label: 'Cleanup' },
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

export const task = defineTask(async (ctx: TaskContext<LocalParticipant>) => {
  const { taskIndex, step, measure, log } = ctx;
  const acquired: { released: boolean } = { released: false };

  try {
    await step('acquire-resource', () => {
      log('acquired resource', { level: 'info', meta: { taskIndex } });
      return { id: taskIndex };
    });

    if (process.env.DEMO_SHOULD_FAIL === '1' && taskIndex === 1) {
      // Attach domain data to the task record before throwing so it survives
      // regardless of how the runner's TaskError identity is bundled.
      measure({ demoFailure: true, taskIndex, phase: 'main' });
      throw new TaskError('simulated business failure', {
        code: 'demo_error',
        data: { taskIndex, phase: 'main' },
      });
    }

    if (process.env.DEMO_TIMEOUT === '1') {
      try {
        await step('risky', () => sleep(2000), { timeoutMs: 100 });
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'step_timeout') {
          log('risky step timed out; continuing with degraded path', { level: 'warn' });
          measure({ riskyTimedOut: true });
        } else {
          throw err;
        }
      }
    }

    const start = performance.now();
    await step('work', () => sleep(50));
    measure({ durationMs: performance.now() - start });
  } finally {
    await step('cleanup', async () => {
      acquired.released = true;
      log('released resource', { level: 'debug', meta: { taskIndex } });
    });
  }
});
