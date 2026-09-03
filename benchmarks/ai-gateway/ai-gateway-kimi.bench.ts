/**
 * AI Gateway benchmark — Kimi family. Same methodology, task, and CLI flags
 * as `ai-gateway.bench.ts` (see that file and `shared-task.ts` for the full
 * fairness rationale) — the differences are `providers-kimi.ts`, which
 * routes gateways to Moonshot's `kimi-k3` instead of Anthropic's Claude
 * Haiku 4.5 (plus its own no-gateway `kimi-direct` control), and
 * `MAX_TOKENS`/`TIMEOUT_MS` below.
 *
 * Both overrides trace to the same root cause — `kimi-k3` runs with
 * reasoning locked to "always on," and there's no non-reasoning Kimi tier
 * to switch to instead (unlike the OpenAI family's GPT-5-mini situation),
 * so both are permanent for this family, not temporary workarounds:
 *
 * - `MAX_TOKENS: 2000` (vs. the other families' 200) — reasoning tokens
 *   count against this budget. One live test consumed 688 of 802 total
 *   completion tokens on reasoning alone; at 200, the entire budget was
 *   exhausted by reasoning with zero visible output.
 * - `TIMEOUT_MS: 90_000` (vs. the other families' 45s) — reasoning also
 *   costs wall-clock time before any visible content appears, independent
 *   of the token budget: one live warm-phase probe measured
 *   `ttft=21395ms`, and a cold probe (which adds DNS/TCP/TLS plus that same
 *   reasoning delay) timed out entirely at the default 45s.
 *
 * See `AI_GATEWAYS.md` for how both affect cross-family comparability.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway-kimi.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-kimi.bench.ts --provider kimi-direct
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers-kimi.js';
import { writeAIGatewayLegacyResults } from './legacy-results.js';
import { makeAIGatewayTask, resolveAIGatewayPhases } from './shared-task.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_TOKENS = 2000;
const TIMEOUT_MS = 90_000;

const phases = resolveAIGatewayPhases(process.argv.slice(2));
if (phases.length === 0) {
  console.log('Both phases are zeroed — nothing to run.');
  process.exit(0);
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: `ai-gateway-latency-kimi${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `AI Gateway Latency - Kimi${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  phases,
  groupBy: 'round',
  participants: providers,
  concurrency: providers.length,
  customCliFlags: ['--ai-gateway-iterations-cold', '--ai-gateway-iterations-warm'],
  scoring: {
    metrics: [
      { key: 'coldE2eMs', unit: 'ms', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      { key: 'warmTtftMs', unit: 'ms', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      {
        key: 'outputTokensPerSec',
        unit: 'tokens/sec',
        floor: 5,
        ceiling: 200,
        higherIsBetter: true,
        weights: { median: 0.10, p95: 0, p99: 0 },
      },
    ],
  },
  onComplete: (outcome) =>
    writeAIGatewayLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/ai-gateway-latency/kimi'),
      providers,
    }),
});

export const task = defineTask(makeAIGatewayTask(MAX_TOKENS, TIMEOUT_MS));
