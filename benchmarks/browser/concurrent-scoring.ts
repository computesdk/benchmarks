import { analyzeCapacity } from './concurrent-capacity.js';
import {
  CONCURRENCY_LEVELS,
  MIN_SAMPLES_FOR_P95,
  SWEEP_WEIGHTS,
  type ConcurrentBenchmarkResult,
  type ConcurrentStatsTriple,
} from './concurrent-types.js';

export interface ConcurrentScoringWeights {
  createMedian: number;
  taskMedian: number;
  taskP95: number;
  screenshotMedian: number;
  perSessionApsMedian: number;
}

export const DEFAULT_CONCURRENT_WEIGHTS: ConcurrentScoringWeights = {
  createMedian: 0.30,        // provisioning under load
  taskMedian: 0.25,          // per-round task time under load
  taskP95: 0.20,             // tail consistency under load
  screenshotMedian: 0.15,    // vision-agent proxy under load
  perSessionApsMedian: 0.10, // per-session throughput under load
};

/** Linear score for actions/sec — 10 actions/sec saturates at 100. */
const APS_CEILING = 10;
/** Latency ceiling in ms — anything >= this scores 0. */
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
 * One score per provider across the whole sweep, weighted by SWEEP_WEIGHTS.
 *
 * A level with no result scores zero and keeps its weight. Renormalising over
 * the levels that did run would mean failing at c50 removes the hardest test
 * from the denominator, so a provider capped at 25 sessions would be scored as
 * though 25 were all it was ever asked for. Not running a level has to cost its
 * weight.
 */
export function computeSweepScore(scoreByLevel: Map<number, number | undefined>): number {
  let total = 0;
  for (const level of CONCURRENCY_LEVELS) {
    total += SWEEP_WEIGHTS[level] * (scoreByLevel.get(level) ?? 0);
  }
  return Math.round(total * 100) / 100;
}

/**
 * The p95, or null when too few samples stand behind it. An absent count means
 * the artifact predates sample tracking, and an unknown sample size cannot
 * support the claim either.
 */
export function supportedP95(stats: ConcurrentStatsTriple): number | null {
  if (stats.samples === undefined || stats.samples < MIN_SAMPLES_FOR_P95) return null;
  return stats.p95;
}

/**
 * Compute the success rate for a concurrent benchmark result (0 to 1).
 *
 * A session counts as successful iff every action it attempted succeeded, and
 * it attempted at least one. Comparing against a fixed total would misread a
 * session that stopped early because the level ran out of its action budget:
 * that is the harness ending the work, not the provider failing it. Partial
 * completions still contribute timing data but are not counted as successes.
 *
 * The denominator is the number of sessions *attempted*, not the number
 * recorded. A round where the provider refused every session records no
 * sessions at all, so counting recorded sessions would make wholesale failures
 * invisible and let a provider that served 10 of 50 sessions report 100%.
 */
export function computeConcurrentSuccessRate(result: ConcurrentBenchmarkResult): number {
  if (result.skipped || result.rounds.length === 0) return 0;
  let attempted = 0;
  let fullySuccessful = 0;
  for (const round of result.rounds) {
    attempted += round.sessionsAttempted || round.sessions.length;
    for (const session of round.sessions) {
      const attemptedActions = session.actions.length;
      if (!session.error && attemptedActions > 0 && session.actionsCompleted === attemptedActions) {
        fullySuccessful++;
      }
    }
  }
  return attempted > 0 ? fullySuccessful / attempted : 0;
}

function computeConcurrentScore(
  result: ConcurrentBenchmarkResult,
  weights: ConcurrentScoringWeights = DEFAULT_CONCURRENT_WEIGHTS,
): number {
  const screenshotMedian = result.summary.perActionType.screenshot?.median ?? 0;
  // Per-loop rather than per-round: a level's action phase covers as many loops
  // as that level runs, so round wall clocks are not comparable between levels.
  // Artifacts written before loopMs existed ran one loop per session, where the
  // round wall clock was the same measurement, so they still score.
  const loop = result.summary.loopMs ?? result.summary.taskMs;
  return (
    weights.createMedian * scoreLatency(result.summary.createMs.median) +
    weights.taskMedian * scoreLatency(loop.median) +
    // A p95 the sample count cannot support is the median again, so scoring it
    // would weight one measurement twice instead of rewarding a tight tail.
    weights.taskP95 * scoreLatency(supportedP95(loop) ?? loop.median) +
    weights.screenshotMedian * scoreLatency(screenshotMedian) +
    weights.perSessionApsMedian * scoreThroughput(result.summary.perSessionActionsPerSecond.median)
  );
}

/**
 * Compute composite scores for all concurrent results and attach them.
 *
 * Formula: compositeScore = concurrentScore × successRate
 */
export function computeConcurrentCompositeScores(
  results: ConcurrentBenchmarkResult[],
  weights: ConcurrentScoringWeights = DEFAULT_CONCURRENT_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeConcurrentSuccessRate(result);
    result.successRate = successRate;

    const capacity = analyzeCapacity(result);
    result.sessionCeiling = capacity.sessionCeiling;
    result.concurrencyAchieved = capacity.concurrencyAchieved;
    result.latencyRepresentative = capacity.latencyRepresentative;
    result.quotaLimited = capacity.quotaLimited;
    if (capacity.quotaEvidence) result.quotaEvidence = capacity.quotaEvidence;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const baseScore = computeConcurrentScore(result, weights);
    result.compositeScore = Math.round(baseScore * successRate * 100) / 100;
  }
}

/**
 * Sort concurrent benchmark results by composite score (highest first).
 * Skipped providers are always last.
 */
export function sortConcurrentByCompositeScore(
  results: ConcurrentBenchmarkResult[],
): ConcurrentBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
