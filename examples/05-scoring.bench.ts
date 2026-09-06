/**
 * Scoring with multiple metrics, a higher-is-better metric, and a success rule.
 *
 * The task hashes random bytes. We measure both duration and throughput,
 * and mark the record as successful only when the hash verifies.
 *
 * Run:
 *   pnpm exec bench run examples/05-scoring.bench.ts --iterations 20 --dry-run
 */
import crypto from 'node:crypto';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskContext } from '@benchsdk/runner';

interface LocalParticipant {
  name: string;
  requiredEnvVars: string[];
  payloadBytes: number;
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'scoring-demo',
  benchmarkName: 'Scoring Demo',
  iterations: 10,
  concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [], payloadBytes: 1024 * 1024 }],
  display: {
    description: 'Hash duration, throughput, and verification success.',
    metrics: [
      { key: 'durationMs', label: 'Duration', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'throughputMbps', label: 'Throughput', unit: 'Mbps', direction: 'higher-better', decimals: 1 },
    ],
    steps: [
      { key: 'hash', label: 'Hash payload' },
    ],
    overview: { defaultMetric: 'durationMs', defaultLayout: 'ranking' },
  },
  scoring: {
    // Records only count as successful when data.verified === true.
    success: {
      requireData: { verified: true },
    },
    metrics: [
      // Duration is 50% of the composite score.
      {
        key: 'durationMs',
        ceiling: 1000,
        weights: { median: 0.35, p95: 0.1, p99: 0.05 },
      },
      // Throughput is also 50% of the composite score.
      {
        key: 'throughputMbps',
        floor: 1,
        ceiling: 500,
        higherIsBetter: true,
        weights: { median: 0.35, p95: 0.1, p99: 0.05 },
      },
    ],
  },
});

function hashPayload(bytes: number): { hash: string; durationMs: number } {
  const payload = crypto.randomBytes(bytes);
  const start = performance.now();
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  return { hash, durationMs: performance.now() - start };
}

export const task = defineTask(async (ctx: TaskContext<LocalParticipant>) => {
  const { participant, step, measure } = ctx;

  const { hash, durationMs } = await step('hash', () => hashPayload(participant.payloadBytes));

  const durationSec = durationMs / 1000;
  const throughputMbps = (participant.payloadBytes * 8) / durationSec / 1_000_000;

  // Simulate a verification step that always succeeds in this example.
  const verified = hash.length === 64;

  measure({ durationMs, throughputMbps, verified });
});
