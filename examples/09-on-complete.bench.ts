/**
 * onScore and onComplete: define scoring with functions and write an aggregate
 * summary file after the run finishes.
 *
 * Run:
 *   pnpm exec bench run examples/09-on-complete.bench.ts --iterations 10 --dry-run
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { BenchmarkRunOutcome, TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'oncomplete-demo',
  benchmarkName: 'OnComplete and OnScore Demo',
  iterations: 5,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
  dimensions: { workload: 'sort' },
  display: {
    description: 'Custom onScore and onComplete demo for sorting workload.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'sort', label: 'Sort' },
    ],
    overview: { defaultMetric: 'durationMs', defaultLayout: 'ranking' },
  },
  onScore: (lowerIsBetter) => ({
    dimensions: { workload: 'sort' },
    success: (record) => record.status === 'success' && (record.data as { sorted?: boolean }).sorted === true,
    metrics: [
      lowerIsBetter('durationMs', {
        ceiling: 500,
        value: (record) => (record.data as { durationMs?: number }).durationMs ?? 0,
        weights: { median: 0.7, p95: 0.2, p99: 0.1 },
      }),
    ],
  }),
  onComplete: async (outcome: BenchmarkRunOutcome) => {
    const summaryPath = new URL('./out/oncomplete-summary.json', import.meta.url).pathname;
    mkdirSync(dirname(summaryPath), { recursive: true });

    const summary = {
      runId: outcome.runId,
      dashboardUrl: outcome.dashboardUrl,
      config: outcome.config,
      participants: outcome.participants.map((p) => ({
        participant: p.participant,
        recordCount: p.records.length,
        successCount: p.records.filter((r) => r.status === 'success').length,
      })),
    };

    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`Wrote summary to ${summaryPath}`);
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const task = defineTask(async (ctx: TaskContext<LocalParticipant>) => {
  const { step, measure } = ctx;

  const items = Array.from({ length: 100 }, (_, i) => 100 - i);
  const start = performance.now();

  await step('sort', () => sleep(10));
  const sorted = [...items].sort((a, b) => a - b);

  measure({ durationMs: performance.now() - start, sorted: sorted[0] === 1 });
});
