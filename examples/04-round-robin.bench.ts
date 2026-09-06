/**
 * groupBy: 'round' interleaves participants so each round runs back-to-back.
 * This is useful for fair comparisons (e.g. every provider's Nth request under
 * the same network conditions).
 *
 * Run:
 *   pnpm exec bench run examples/04-round-robin.bench.ts --iterations 5 --dry-run
 */
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
  workMs: number;
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'round-robin-demo',
  benchmarkName: 'Round Robin Demo',
  iterations: 5,
  concurrency: 1,
  groupBy: 'round',
  participants: [
    { name: 'quick', requiredEnvVars: [], workMs: 20 },
    { name: 'slow', requiredEnvVars: [], workMs: 80 },
  ],
  display: {
    description: 'Round-robin participant interleaving latency.',
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
      { key: 'durationMs', ceiling: 500, weights: { median: 0.7, p95: 0.2, p99: 0.1 } },
    ],
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const task = defineTask(async (ctx: TaskContext<LocalParticipant>) => {
  const { participant, step, measure, log } = ctx;
  log(`round for ${participant.name}`);

  const start = performance.now();
  await step('work', () => sleep(participant.workMs));
  measure({ durationMs: performance.now() - start });
});
