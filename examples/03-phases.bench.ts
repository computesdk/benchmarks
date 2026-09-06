/**
 * Phases: named run segments that let the task branch by phase.
 * Each record is automatically tagged with `data.phase`.
 *
 * Run:
 *   pnpm exec bench run examples/03-phases.bench.ts --dry-run
 */
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
  coldDelayMs: number;
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'phases-demo',
  benchmarkName: 'Phases Demo',
  phases: [
    { name: 'cold', iterations: 3 },
    { name: 'warm', iterations: 3 },
  ],
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [], coldDelayMs: 100 }],
  display: {
    description: 'Cold vs. warm phase latency.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'cold-work', label: 'Cold work' },
      { key: 'warm-work', label: 'Warm work' },
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
  const { participant, phase, step, measure, log } = ctx;
  log(`phase: ${phase ?? 'none'}`);

  const start = performance.now();

  if (phase === 'cold') {
    // Simulate an expensive cold-start setup.
    await step('cold-work', () => sleep(participant.coldDelayMs));
  } else {
    // Warm iteration is much cheaper.
    await step('warm-work', () => sleep(20));
  }

  measure({ durationMs: performance.now() - start });
});
