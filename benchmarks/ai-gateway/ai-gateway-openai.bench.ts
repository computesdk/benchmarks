/**
 * AI Gateway benchmark — OpenAI family. Same methodology, task, CLI flags,
 * and request configuration (`max_tokens: 200`, `temperature: 0`) as
 * `ai-gateway.bench.ts` (see that file and `shared-task.ts` for the full
 * fairness rationale) — the only difference is `providers-openai.ts`, which
 * routes every gateway to OpenAI's `gpt-5.4-mini` instead of Anthropic's
 * Claude Haiku 4.5, plus its own no-gateway `openai-direct` control.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway-openai.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-openai.bench.ts --provider openai-direct
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers-openai.js';
import { writeAIGatewayLegacyResults } from './legacy-results.js';
import { makeAIGatewayTask, resolveAIGatewayPhases } from './shared-task.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_TOKENS = 200;
const TIMEOUT_MS = 45_000;

const phases = resolveAIGatewayPhases(process.argv.slice(2));
if (phases.length === 0) {
  console.log('Both phases are zeroed — nothing to run.');
  process.exit(0);
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: `ai-gateway-latency-openai${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `AI Gateway Latency - OpenAI${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  phases,
  groupBy: 'round',
  participants: providers,
  concurrency: providers.length,
  customCliFlags: ['--ai-gateway-iterations-cold', '--ai-gateway-iterations-warm'],
  display: {
    description: 'AI gateway cold/warm latency and token throughput.',
    metrics: [
      { key: 'coldE2eMs', label: 'Cold end-to-end', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'warmTtftMs', label: 'Warm time to first token', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'outputTokensPerSec', label: 'Output tokens/s', unit: 'tok/s', direction: 'higher-better', decimals: 1 },
      { key: 'outputTokens', label: 'Output tokens', direction: 'higher-better', decimals: 0 },
    ],
    steps: [
      { key: 'dns', label: 'DNS' },
      { key: 'tcp', label: 'TCP' },
      { key: 'tls', label: 'TLS' },
      { key: 'ttfb', label: 'TTFB' },
      { key: 'ttft', label: 'TTFT' },
    ],
    overview: { defaultMetric: 'coldE2eMs', defaultLayout: 'ranking' },
  },
  scoring: {
    metrics: [
      { key: 'coldE2eMs', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      { key: 'warmTtftMs', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      {
        key: 'outputTokensPerSec',
        floor: 5,
        ceiling: 200,
        higherIsBetter: true,
        weights: { median: 0.10, p95: 0, p99: 0 },
      },
    ],
  },
  onComplete: (outcome) =>
    writeAIGatewayLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/ai-gateway-latency/openai'),
      providers,
    }),
});

export const task = defineTask(makeAIGatewayTask(MAX_TOKENS, TIMEOUT_MS));
