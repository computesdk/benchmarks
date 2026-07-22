import type { AIGatewayBenchmarkResult } from './types.js';

/**
 * Weight configuration for AI gateway composite scoring. Cold E2E (DNS+TCP+TLS+TTFT)
 * reflects the short-lived-process case; warm TTFT reflects the steady-state,
 * connection-pooled case. Both matter, so both are weighted heavily.
 */
export interface AIGatewayScoringWeights {
  coldE2eMedian: number;
  coldE2eP95: number;
  warmTtftMedian: number;
  warmTtftP95: number;
  throughput: number;
}

export const DEFAULT_AI_GATEWAY_WEIGHTS: AIGatewayScoringWeights = {
  coldE2eMedian: 0.30,
  coldE2eP95: 0.15,
  warmTtftMedian: 0.30,
  warmTtftP95: 0.15,
  throughput: 0.10,
};

/** Absolute ceiling for latency in ms. Anything at or above this scores 0. */
const LATENCY_CEILING_MS = 20000;

/** Throughput floor/ceiling in output tokens/sec for scoring. */
const MIN_TOKENS_PER_SEC = 5;
const MAX_TOKENS_PER_SEC = 200;

/**
 * Score a latency value (lower is better).
 * 0ms = 100, LATENCY_CEILING_MS = 0, values above ceiling are clamped to 0.
 */
function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

/**
 * Score a throughput value (higher is better).
 * Values <= MIN_TOKENS_PER_SEC score 0, values >= MAX_TOKENS_PER_SEC score 100, linearly interpolated between.
 */
function scoreThroughput(tokensPerSec: number): number {
  if (tokensPerSec <= MIN_TOKENS_PER_SEC) return 0;
  if (tokensPerSec >= MAX_TOKENS_PER_SEC) return 100;
  return ((tokensPerSec - MIN_TOKENS_PER_SEC) / (MAX_TOKENS_PER_SEC - MIN_TOKENS_PER_SEC)) * 100;
}

/**
 * Compute the success rate for an AI gateway benchmark result (0 to 1).
 */
export function computeAIGatewaySuccessRate(result: AIGatewayBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const successful = result.iterations.filter(i => !i.error).length;
  return successful / result.iterations.length;
}

/**
 * Compute a weighted AI gateway score (0-100, higher = better).
 */
function computeAIGatewayScore(
  result: AIGatewayBenchmarkResult,
  weights: AIGatewayScoringWeights = DEFAULT_AI_GATEWAY_WEIGHTS,
): number {
  return (
    weights.coldE2eMedian * scoreLatency(result.summary.coldE2eMs.median) +
    weights.coldE2eP95 * scoreLatency(result.summary.coldE2eMs.p95) +
    weights.warmTtftMedian * scoreLatency(result.summary.warmTtftMs.median) +
    weights.warmTtftP95 * scoreLatency(result.summary.warmTtftMs.p95) +
    weights.throughput * scoreThroughput(result.summary.outputTokensPerSec.median)
  );
}

/**
 * Compute composite scores for all AI gateway results and attach them.
 *
 * Formula: compositeScore = gatewayScore × successRate
 */
export function computeAIGatewayCompositeScores(
  results: AIGatewayBenchmarkResult[],
  weights: AIGatewayScoringWeights = DEFAULT_AI_GATEWAY_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeAIGatewaySuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const gatewayScore = computeAIGatewayScore(result, weights);
    result.compositeScore = Math.round(gatewayScore * successRate * 100) / 100;
  }
}

/**
 * Sort AI gateway benchmark results by composite score (highest first).
 * Skipped providers are always last.
 */
export function sortAIGatewayByCompositeScore(results: AIGatewayBenchmarkResult[]): AIGatewayBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
