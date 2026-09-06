/**
 * Env-gated participants: providers with `requiredEnvVars` are automatically
 * skipped when those env vars are missing. `defaultProviders` limits the default
 * run to those that don't need extra credentials.
 *
 * Run:
 *   pnpm exec bench run examples/08-env-gated.bench.ts --dry-run
 *   # include the remote participant once the env var is set
 *   DEMO_API_KEY=sk-demo pnpm exec bench run examples/08-env-gated.bench.ts --provider remote --dry-run
 */
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'env-gated-demo',
  benchmarkName: 'Env-Gated Participants Demo',
  iterations: 5,
  concurrency: 1,
  // Run the local participant by default; ask for remote explicitly with --provider.
  defaultProviders: ['local'],
  participants: [
    { name: 'local', requiredEnvVars: [] },
    { name: 'remote', requiredEnvVars: ['DEMO_API_KEY'] },
  ],
  display: {
    description: 'Env-gated local vs. remote participant latency.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'remote-auth', label: 'Remote auth' },
      { key: 'local-work', label: 'Local work' },
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
  const start = performance.now();

  if (participant.name === 'remote') {
    // In a real benchmark this would use the key to call the remote service.
    const key = process.env.DEMO_API_KEY!;
    log('authenticating remote participant', { level: 'info', meta: { keyPrefix: key.slice(0, 4) } });
    await step('remote-auth', () => sleep(40));
  } else {
    await step('local-work', () => sleep(20));
  }

  measure({ durationMs: performance.now() - start });
});
