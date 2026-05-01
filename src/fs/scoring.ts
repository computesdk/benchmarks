import type { FsBenchmarkResult } from './types.js';

export interface FsScoringWeights {
  readMedian: number;
  readP95: number;
  writeMedian: number;
  writeP95: number;
  smallFileOpsMedian: number;
  metadataOpsMedian: number;
}

export const DEFAULT_FS_WEIGHTS: FsScoringWeights = {
  readMedian: 0.25,
  readP95: 0.10,
  writeMedian: 0.25,
  writeP95: 0.10,
  smallFileOpsMedian: 0.20,
  metadataOpsMedian: 0.10,
};

const LATENCY_CEILING_MS = 30000;

function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

export function computeFsSuccessRate(result: FsBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const successful = result.iterations.filter((i) => !i.error).length;
  return successful / result.iterations.length;
}

function computeFsScore(result: FsBenchmarkResult, weights: FsScoringWeights = DEFAULT_FS_WEIGHTS): number {
  return (
    weights.readMedian * scoreLatency(result.summary.readMs.median) +
    weights.readP95 * scoreLatency(result.summary.readMs.p95) +
    weights.writeMedian * scoreLatency(result.summary.writeMs.median) +
    weights.writeP95 * scoreLatency(result.summary.writeMs.p95) +
    weights.smallFileOpsMedian * scoreLatency(result.summary.smallFileOpsMs.median) +
    weights.metadataOpsMedian * scoreLatency(result.summary.metadataOpsMs.median)
  );
}

export function computeFsCompositeScores(
  results: FsBenchmarkResult[],
  weights: FsScoringWeights = DEFAULT_FS_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeFsSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const fsScore = computeFsScore(result, weights);
    result.compositeScore = Math.round(fsScore * successRate * 100) / 100;
  }
}
