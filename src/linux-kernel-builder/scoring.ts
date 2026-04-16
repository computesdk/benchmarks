import type { LinuxKernelBuilderBenchmarkResult, LinuxKernelBuilderStats } from './types.js';

export interface LinuxKernelBuilderScoringWeights {
  median: number;
  p95: number;
  p99: number;
}

export const DEFAULT_LKB_WEIGHTS: LinuxKernelBuilderScoringWeights = {
  median: 0.60,
  p95: 0.25,
  p99: 0.15,
};

/**
 * Ceiling for build-time metric scoring.
 * 30 minutes at or above scores 0.
 */
const BUILD_CEILING_MS = 30 * 60 * 1000;

function scoreMetric(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / BUILD_CEILING_MS));
}

export function computeLinuxKernelBuilderSuccessRate(result: LinuxKernelBuilderBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const successful = result.iterations.filter(i => !i.error).length;
  return successful / result.iterations.length;
}

function computeBuildScore(
  stats: LinuxKernelBuilderStats,
  weights: LinuxKernelBuilderScoringWeights = DEFAULT_LKB_WEIGHTS,
): number {
  return (
    weights.median * scoreMetric(stats.median) +
    weights.p95 * scoreMetric(stats.p95) +
    weights.p99 * scoreMetric(stats.p99)
  );
}

export function computeLinuxKernelBuilderCompositeScores(
  results: LinuxKernelBuilderBenchmarkResult[],
  weights: LinuxKernelBuilderScoringWeights = DEFAULT_LKB_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeLinuxKernelBuilderSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const buildScore = computeBuildScore(result.summary.buildMs, weights);
    result.compositeScore = Math.round(buildScore * successRate * 100) / 100;
  }
}

export function sortLinuxKernelBuilderByCompositeScore(results: LinuxKernelBuilderBenchmarkResult[]): LinuxKernelBuilderBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
