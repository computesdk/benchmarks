/**
 * AI Gateway benchmark — Anthropic family. Declarative — exports `config` +
 * `task`; `bench run` owns the entrypoint. Configured with `groupBy:
 * 'round'`. Fairness is the whole point (see AI_GATEWAYS.md): every
 * gateway's Nth iteration must run at roughly the same point in time as
 * every other gateway's Nth iteration, so no gateway is favored by running
 * during a different network condition. `groupBy: 'round'` provides exactly
 * that — one task per gateway per round, taking turns — replacing the
 * bespoke round-robin loop this file used to hand-roll.
 *
 * Declared as two phases (cold, warm); the framework owns the phase boundary
 * and exposes it via `ctx.phase`, so the task branches on phase identity, not
 * index arithmetic. Each phase runs a socket-level probe (cold: fresh
 * connection with DNS/TCP/TLS + TTFB/TTFT; warm: reused connection, TTFB/TTFT
 * only). Phase timings are measured inside a single request, so they're
 * returned as pre-measured `TaskResult.steps`, and the real measured latency
 * (coldE2eMs / ttftMs) is returned as `TaskResult.latencyMs` rather than
 * letting the framework stamp wall-clock time.
 *
 * The probe task and CLI iteration-flag parsing are shared across every
 * AI-gateway family benchmark (see `shared-task.ts`); this file supplies the
 * Anthropic-routed `providers` list plus this family's own benchmark
 * identity, scoring, and legacy-results output. See `ai-gateway-openai.bench.ts`
 * for the OpenAI-routed sibling.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway.bench.ts --provider openrouter
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
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
  benchmarkSlug: `ai-gateway-latency-anthropic${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `AI Gateway Latency - Anthropic${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  phases,
  groupBy: 'round',
  participants: providers,
  // Run every gateway in a round concurrently while keeping rounds sequential.
  // This preserves the per-round fairness of round-robin ordering without
  // multiplying runtime by the number of gateways.
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
      resultsDir: path.resolve(__dirname, '../../results/ai-gateway-latency/anthropic'),
      providers,
    }),
});

export const task = defineTask(makeAIGatewayTask(MAX_TOKENS, TIMEOUT_MS));
