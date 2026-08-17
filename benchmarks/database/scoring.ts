import type { DatabaseBenchmarkResult } from './types.js';

export interface DatabaseScoringWeights {
  readMedian: number;
  readP95: number;
  readP99: number;
  readAfterUpdateMedian: number;
  readAfterUpdateP95: number;
  readAfterUpdateP99: number;
  createMedian: number;
  createP95: number;
  updateMedian: number;
  updateP95: number;
  deleteMedian: number;
}

export const DEFAULT_DATABASE_WEIGHTS: DatabaseScoringWeights = {
  readMedian: 0.2,
  readP95: 0.1,
  readP99: 0.05,
  readAfterUpdateMedian: 0.15,
  readAfterUpdateP95: 0.08,
  readAfterUpdateP99: 0.02,
  createMedian: 0.12,
  createP95: 0.08,
  updateMedian: 0.08,
  updateP95: 0.07,
  deleteMedian: 0.05,
};

// CRUD requests are much faster than multi-megabyte storage operations.
const LATENCY_CEILING_MS = 2_000;

function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

export function computeDatabaseSuccessRate(result: DatabaseBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  return result.iterations.filter((iteration) => !iteration.error).length / result.iterations.length;
}

export function computeDatabaseCompositeScores(
  results: DatabaseBenchmarkResult[],
  weights: DatabaseScoringWeights = DEFAULT_DATABASE_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeDatabaseSuccessRate(result);
    result.successRate = successRate;
    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const score =
      weights.readMedian * scoreLatency(result.summary.readMs.median) +
      weights.readP95 * scoreLatency(result.summary.readMs.p95) +
      weights.readP99 * scoreLatency(result.summary.readMs.p99) +
      weights.readAfterUpdateMedian * scoreLatency(result.summary.readAfterUpdateMs.median) +
      weights.readAfterUpdateP95 * scoreLatency(result.summary.readAfterUpdateMs.p95) +
      weights.readAfterUpdateP99 * scoreLatency(result.summary.readAfterUpdateMs.p99) +
      weights.createMedian * scoreLatency(result.summary.createMs.median) +
      weights.createP95 * scoreLatency(result.summary.createMs.p95) +
      weights.updateMedian * scoreLatency(result.summary.updateMs.median) +
      weights.updateP95 * scoreLatency(result.summary.updateMs.p95) +
      weights.deleteMedian * scoreLatency(result.summary.deleteMs.median);
    result.compositeScore = Math.round(score * successRate * 100) / 100;
  }
}

export function sortDatabaseByCompositeScore(results: DatabaseBenchmarkResult[]): DatabaseBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
