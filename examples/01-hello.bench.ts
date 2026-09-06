/**
 * Minimal benchmark: one participant, one step, one metric.
 *
 * Run:
 *   pnpm exec bench run examples/01-hello.bench.ts --dry-run
 *   pnpm exec bench run examples/01-hello.bench.ts --iterations 20 --concurrency 5
 */
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'hello',
  benchmarkName: 'Hello Benchmark',
  iterations: 10,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  display: {
    description: 'Minimal one-step, one-metric benchmark.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'work', label: 'Work' },
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
  const { participant, step, measure, log } = ctx;
  // `log` accepts a level and optional metadata, or a plain metadata object.
  log('starting task', { level: 'info', meta: { taskIndex: ctx.taskIndex, participant: participant.name } });

  const start = performance.now();
  await step('work', async () => {
    // A deterministic, offline workload.
    await sleep(20 + Math.random() * 30);
  });
  const durationMs = performance.now() - start;

  measure({ durationMs });
  log('task complete', { level: 'debug', meta: { durationMs } });
});
