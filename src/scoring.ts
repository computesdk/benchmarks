import type { BenchmarkResult, Stats } from './types.js';

/**
 * Weight configuration for composite scoring.
 * Timing weights should sum to 1.0.
 */
export interface ScoringWeights {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  median: 0.50,
  p95: 0.20,
  p99: 0.10,
  min: 0.05,
  max: 0.15,
};

/** Absolute ceiling in ms. Anything at or above this scores 0. */
const CEILING_MS = 10_000;

/**
 * Score a single timing value against the absolute ceiling (0-100, higher = better).
 * 0ms = 100, CEILING_MS = 0, values above ceiling are clamped to 0.
 */
function scoreMetric(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / CEILING_MS));
}

/**
 * Compute the success rate for a benchmark result (0 to 1).
 */
export function computeSuccessRate(result: BenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const successful = result.iterations.filter(i => !i.error).length;
  return successful / result.iterations.length;
}

/**
 * Compute a weighted timing score (0-100, higher = better).
 * Each metric is scored against a fixed 10s ceiling, then combined with weights.
 */
function computeTimingScore(
  stats: Stats,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  return (
    weights.median * scoreMetric(stats.median) +
    weights.p95 * scoreMetric(stats.p95) +
    weights.p99 * scoreMetric(stats.p99) +
    weights.min * scoreMetric(stats.min) +
    weights.max * scoreMetric(stats.max)
  );
}

/**
 * Compute composite scores for all results and attach them.
 *
 * Formula: compositeScore = timingScore × successRate
 *
 * Each timing metric is scored against a fixed 10-second ceiling:
 *   metricScore = 100 × (1 - value / 10000ms)
 *
 * Scores are absolute — they don't change when providers are added or removed.
 * A provider with 200ms median scores 98 whether it's alone or among 50 others.
 *
 * successRate (0-1) acts as a linear multiplier: 50% success halves the score.
 */
export function computeCompositeScores(
  results: BenchmarkResult[],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const timingScore = computeTimingScore(result.summary.ttiMs, weights);
    result.compositeScore = Math.round(timingScore * successRate * 100) / 100;
  }
}

/**
 * Sort benchmark results by composite score (highest first).
 * Skipped providers are always last.
 */
export function sortByCompositeScore(results: BenchmarkResult[]): BenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
