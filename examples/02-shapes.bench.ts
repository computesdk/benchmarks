/**
 * Shapes: one benchmark file can report as sequential, burst, or staggered
 * variants by swapping slug/name and a default stagger delay.
 *
 * Run:
 *   pnpm exec bench run examples/02-shapes.bench.ts --shape sequential --dry-run
 *   pnpm exec bench run examples/02-shapes.bench.ts --shape burst --iterations 50 --concurrency 50 --dry-run
 *   pnpm exec bench run examples/02-shapes.bench.ts --shape staggered --iterations 20 --concurrency 20 --dry-run
 */
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'shape-demo',
  benchmarkName: 'Shape Demo',
  // Base values; scale knobs are intentionally overridden from the CLI.
  iterations: 1,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  shapes: {
    sequential: { slug: 'shape-demo-sequential', name: 'Shape Demo (Sequential)' },
    burst: { slug: 'shape-demo-burst', name: 'Shape Demo (Burst)' },
    staggered: { slug: 'shape-demo-staggered', name: 'Shape Demo (Staggered)', staggerDelayMs: 200 },
  },
  display: {
    description: 'Workload shape variants (sequential, burst, staggered).',
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
  const { step, measure } = ctx;
  const start = performance.now();
  await step('work', () => sleep(20));
  measure({ durationMs: performance.now() - start });
});
