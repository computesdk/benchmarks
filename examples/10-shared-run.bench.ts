/**
 * Shared run key: when the same benchmark is invoked from multiple CI jobs or
 * machines, pass `--run-key <shared-key>` so every process contributes to a
 * single platform run instead of opening one per invocation.
 *
 * Run locally:
 *   pnpm exec bench run examples/10-shared-run.bench.ts --run-key ci-$(date +%s) --dry-run
 *
 * In CI you would run one job per provider, each with the same `--run-key`.
 */
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
  workMs: number;
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'shared-run-demo',
  benchmarkName: 'Shared Run Demo',
  iterations: 5,
  concurrency: 1,
  groupBy: 'participant',
  participants: [
    { name: 'alpha', requiredEnvVars: [], workMs: 20 },
    { name: 'beta', requiredEnvVars: [], workMs: 40 },
  ],
  display: {
    description: 'Shared run key across multiple CI jobs.',
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
  log('contributing to shared run', { level: 'info', meta: { participant: participant.name } });

  const start = performance.now();
  await step('work', () => sleep(participant.workMs));
  measure({ durationMs: performance.now() - start });
});
