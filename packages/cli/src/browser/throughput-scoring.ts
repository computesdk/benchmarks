import { ACTIONS_PER_SESSION, type ThroughputBenchmarkResult } from './throughput-types.js';

export interface ThroughputScoringWeights {
  apsMedian: number;
  taskMedian: number;
  taskP95: number;
  screenshotMedian: number;
}

export const DEFAULT_THROUGHPUT_WEIGHTS: ThroughputScoringWeights = {
  apsMedian: 0.40,        // Throughput is the primary signal
  taskMedian: 0.25,       // Total task time
  taskP95: 0.20,          // Tail consistency
  screenshotMedian: 0.15, // Vision-agent proxy
};

/** Linear score for actions/sec — 10 actions/sec saturates at 100. */
const APS_CEILING = 10;
/** Latency ceiling in ms — anything ≥ this scores 0. */
const LATENCY_CEILING_MS = 30_000;

function scoreThroughput(actionsPerSecond: number): number {
  if (!Number.isFinite(actionsPerSecond) || actionsPerSecond <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (actionsPerSecond / APS_CEILING)));
}

function scoreLatency(valueMs: number): number {
  if (!Number.isFinite(valueMs)) return 0;
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

/**
 * Compute the success rate for a throughput benchmark result (0 to 1).
 *
 * A session counts as successful iff it ran end-to-end without an iteration
 * error AND completed all ACTIONS_PER_SESSION actions. Partial completions
 * still contribute timing data but are not counted as full successes.
 */
export function computeThroughputSuccessRate(result: ThroughputBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const fullySuccessful = result.iterations.filter(
    i => !i.error && i.actionsCompleted === ACTIONS_PER_SESSION,
  ).length;
  return fullySuccessful / result.iterations.length;
}

function computeThroughputScore(
  result: ThroughputBenchmarkResult,
  weights: ThroughputScoringWeights = DEFAULT_THROUGHPUT_WEIGHTS,
): number {
  const screenshotMedian = result.summary.perActionType.screenshot?.median ?? 0;
  return (
    weights.apsMedian * scoreThroughput(result.summary.actionsPerSecond.median) +
    weights.taskMedian * scoreLatency(result.summary.taskMs.median) +
    weights.taskP95 * scoreLatency(result.summary.taskMs.p95) +
    weights.screenshotMedian * scoreLatency(screenshotMedian)
  );
}

/**
 * Compute composite scores for all throughput results and attach them.
 *
 * Formula: compositeScore = throughputScore × successRate
 */
export function computeThroughputCompositeScores(
  results: ThroughputBenchmarkResult[],
  weights: ThroughputScoringWeights = DEFAULT_THROUGHPUT_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeThroughputSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const baseScore = computeThroughputScore(result, weights);
    result.compositeScore = Math.round(baseScore * successRate * 100) / 100;
  }
}

/**
 * Sort throughput benchmark results by composite score (highest first).
 * Skipped providers are always last.
 */
export function sortThroughputByCompositeScore(
  results: ThroughputBenchmarkResult[],
): ThroughputBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
