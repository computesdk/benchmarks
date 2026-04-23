import type { StorageBenchmarkResult } from './types.js';

/**
 * Weight configuration for storage composite scoring.
 * Both upload and download speed matter for a complete storage benchmark.
 */
export interface StorageScoringWeights {
  downloadMedian: number;
  downloadP95: number;
  downloadP99: number;
  uploadMedian: number;
  uploadP95: number;
  uploadP99: number;
  throughput: number;
}

export const DEFAULT_STORAGE_WEIGHTS: StorageScoringWeights = {
  downloadMedian: 0.35,  // 35% - most important for typical usage
  downloadP95: 0.15,     // 15% - tail latency matters
  downloadP99: 0.05,     // 5% - worst case
  uploadMedian: 0.25,    // 25% - write performance
  uploadP95: 0.10,       // 10% - upload tail latency
  uploadP99: 0.05,       // 5% - upload worst case
  throughput: 0.05,      // 5% - raw speed for large files
};

/** Absolute ceiling for latency in ms. Anything at or above this scores 0. */
const LATENCY_CEILING_MS = 30000; // 30 seconds

/** Minimum throughput floor in Mbps for scoring. Anything below scores 0. */
const MIN_THROUGHPUT_MBPS = 1;

/** Maximum throughput ceiling in Mbps for scoring. Anything above scores 100. */
const MAX_THROUGHPUT_MBPS = 1000;

/**
 * Score a latency value (lower is better).
 * 0ms = 100, LATENCY_CEILING_MS = 0, values above ceiling are clamped to 0.
 */
function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

/**
 * Score a throughput value (higher is better).
 * Values <= 1 Mbps score 0, values >= 1000 Mbps score 100, linearly interpolated between.
 */
function scoreThroughput(mbps: number): number {
  if (mbps <= MIN_THROUGHPUT_MBPS) return 0;
  if (mbps >= MAX_THROUGHPUT_MBPS) return 100;
  return ((mbps - MIN_THROUGHPUT_MBPS) / (MAX_THROUGHPUT_MBPS - MIN_THROUGHPUT_MBPS)) * 100;
}

/**
 * Compute the success rate for a storage benchmark result (0 to 1).
 */
export function computeStorageSuccessRate(result: StorageBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const successful = result.iterations.filter(i => !i.error).length;
  return successful / result.iterations.length;
}

/**
 * Compute a weighted storage score (0-100, higher = better).
 */
function computeStorageScore(
  result: StorageBenchmarkResult,
  weights: StorageScoringWeights = DEFAULT_STORAGE_WEIGHTS,
): number {
  const downloadScore =
    weights.downloadMedian * scoreLatency(result.summary.downloadMs.median) +
    weights.downloadP95 * scoreLatency(result.summary.downloadMs.p95) +
    weights.downloadP99 * scoreLatency(result.summary.downloadMs.p99);

  const uploadScore =
    weights.uploadMedian * scoreLatency(result.summary.uploadMs.median) +
    weights.uploadP95 * scoreLatency(result.summary.uploadMs.p95) +
    weights.uploadP99 * scoreLatency(result.summary.uploadMs.p99);

  const throughputScore = weights.throughput * scoreThroughput(result.summary.throughputMbps.median);

  return downloadScore + uploadScore + throughputScore;
}

/**
 * Compute composite scores for all storage results and attach them.
 *
 * Formula: compositeScore = storageScore × successRate
 *
 * Lower latency (both upload and download) and higher throughput = better score.
 * successRate (0-1) acts as a linear multiplier.
 */
export function computeStorageCompositeScores(
  results: StorageBenchmarkResult[],
  weights: StorageScoringWeights = DEFAULT_STORAGE_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeStorageSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const storageScore = computeStorageScore(result, weights);
    result.compositeScore = Math.round(storageScore * successRate * 100) / 100;
  }
}

/**
 * Sort storage benchmark results by composite score (highest first).
 * Skipped providers are always last.
 */
export function sortStorageByCompositeScore(results: StorageBenchmarkResult[]): StorageBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
