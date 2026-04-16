import type { AIGatewayBenchmarkResult } from './types.js';

export interface AIGatewayScoringWeights {
  totalMedian: number;
  totalP95: number;
  totalP99: number;
  firstTokenMedian: number;
}

export const DEFAULT_AI_GATEWAY_WEIGHTS: AIGatewayScoringWeights = {
  totalMedian: 0.35,
  totalP95: 0.20,
  totalP99: 0.10,
  firstTokenMedian: 0.35,
};

const LATENCY_CEILING_MS = 60000;

function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

export function computeAIGatewaySuccessRate(result: AIGatewayBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const successful = result.iterations.filter(i => !i.error).length;
  return successful / result.iterations.length;
}

function computeAIGatewayScore(
  result: AIGatewayBenchmarkResult,
  weights: AIGatewayScoringWeights = DEFAULT_AI_GATEWAY_WEIGHTS,
): number {
  return (
    weights.totalMedian * scoreLatency(result.summary.totalMs.median) +
    weights.totalP95 * scoreLatency(result.summary.totalMs.p95) +
    weights.totalP99 * scoreLatency(result.summary.totalMs.p99) +
    weights.firstTokenMedian * scoreLatency(result.summary.firstTokenMs.median)
  );
}

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

export function sortAIGatewayByCompositeScore(results: AIGatewayBenchmarkResult[]): AIGatewayBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
