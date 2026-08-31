/**
 * AI Gateway Workload benchmark — Anthropic family.
 *
 * Runs the same prompt against every gateway under a 4-phase concurrency ramp
 * (1, 8, 16, 32) and measures sustained throughput, p50/p95/p99 latency,
 * TTFT, error/timeout rates, and max-sustained requests/tokens per second.
 *
 *   bench run benchmarks/ai-gateway/ai-gateway-workload.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-workload.bench.ts --provider openrouter
 *   bench run benchmarks/ai-gateway/ai-gateway-workload.bench.ts --workload-duration-ms 30000 --workload-max-requests 200
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
import { parseIntFlag } from './shared-task.js';
import { makeAIGatewayWorkloadTask } from './workload-task.js';
import { writeAIGatewayWorkloadResults } from './workload-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_TOKENS = 200;
const TIMEOUT_MS = 45_000;
const RAMP = [1, 8, 16, 32];
const DEFAULT_DURATION_MS = 20_000;

const argv = process.argv.slice(2);
const durationMs = parseIntFlag(argv, '--workload-duration-ms') ?? DEFAULT_DURATION_MS;
const maxRequests = parseIntFlag(argv, '--workload-max-requests');

const phases = RAMP.map((concurrency) => ({ name: String(concurrency), iterations: 1 }));

export const config = defineBenchmarkConfig({
  benchmarkSlug: `ai-gateway-workload-anthropic${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `AI Gateway Workload - Anthropic${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  phases,
  groupBy: 'round',
  participants: providers,
  scoring: {
    groupBy: 'concurrency',
    metrics: [
      {
        key: 'totalMs',
        unit: 'ms',
        ceiling: 30_000,
        weights: { median: 0.25, p95: 0, p99: 0 },
      },
      {
        key: 'ttftMs',
        unit: 'ms',
        ceiling: 20_000,
        weights: { median: 0.20, p95: 0, p99: 0 },
      },
      {
        key: 'errorRate',
        unit: 'fraction',
        ceiling: 0.5,
        weights: { median: 0.10, p95: 0, p99: 0 },
      },
      {
        key: 'requestsPerSec',
        unit: 'req/sec',
        floor: 0,
        ceiling: 100,
        higherIsBetter: true,
        weights: { median: 0.20, p95: 0, p99: 0 },
      },
      {
        key: 'tokensPerSec',
        unit: 'tokens/sec',
        floor: 0,
        ceiling: 5000,
        higherIsBetter: true,
        weights: { median: 0.25, p95: 0, p99: 0 },
      },
    ],
  },
  onComplete: (outcome) =>
    writeAIGatewayWorkloadResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/ai-gateway-workload/anthropic'),
      providers,
    }),
});

export const task = defineTask(
  makeAIGatewayWorkloadTask({
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    durationMs,
    maxRequests,
  }),
);
