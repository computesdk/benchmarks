import type { BrowserBenchmarkResult } from './types.js';

/**
 * Weight configuration for browser composite scoring.
 * Total time is weighted highest since it reflects the full user experience.
 */
export interface BrowserScoringWeights {
  totalMedian: number;
  totalP95: number;
  totalP99: number;
  createMedian: number;
}

export const DEFAULT_BROWSER_WEIGHTS: BrowserScoringWeights = {
  totalMedian: 0.40,   // 40% - overall latency matters most
  totalP95: 0.20,      // 20% - tail latency
  totalP99: 0.10,      // 10% - worst case
  createMedian: 0.30,  // 30% - session provisioning speed
};

/** Absolute ceiling for latency in ms. Anything at or above this scores 0. */
const LATENCY_CEILING_MS = 60000; // 60 seconds

/**
 * Score a latency value (lower is better).
 * 0ms = 100, LATENCY_CEILING_MS = 0, values above ceiling are clamped to 0.
 */
function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

/**
 * Compute the success rate for a browser benchmark result (0 to 1).
 */
export function computeBrowserSuccessRate(result: BrowserBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const successful = result.iterations.filter(i => !i.error).length;
  return successful / result.iterations.length;
}

/**
 * Compute a weighted browser score (0-100, higher = better).
 */
function computeBrowserScore(
  result: BrowserBenchmarkResult,
  weights: BrowserScoringWeights = DEFAULT_BROWSER_WEIGHTS,
): number {
  return (
    weights.totalMedian * scoreLatency(result.summary.totalMs.median) +
    weights.totalP95 * scoreLatency(result.summary.totalMs.p95) +
    weights.totalP99 * scoreLatency(result.summary.totalMs.p99) +
    weights.createMedian * scoreLatency(result.summary.createMs.median)
  );
}

/**
 * Compute composite scores for all browser results and attach them.
 *
 * Formula: compositeScore = browserScore × successRate
 *
 * Lower latency = better score.
 * successRate (0-1) acts as a linear multiplier.
 */
export function computeBrowserCompositeScores(
  results: BrowserBenchmarkResult[],
  weights: BrowserScoringWeights = DEFAULT_BROWSER_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeBrowserSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const browserScore = computeBrowserScore(result, weights);
    result.compositeScore = Math.round(browserScore * successRate * 100) / 100;
  }
}

/**
 * Sort browser benchmark results by composite score (highest first).
 * Skipped providers are always last.
 */
export function sortBrowserByCompositeScore(results: BrowserBenchmarkResult[]): BrowserBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
