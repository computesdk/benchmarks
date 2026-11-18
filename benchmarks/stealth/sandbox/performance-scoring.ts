/**
 * Offline performance scoring candidate. No active benchmark imports this
 * evaluator and it is NOT a BenchmarkScoringConfig: runner 0.8.2 and the
 * pinned platform cannot serialize/recompute these curves yet.
 *
 * Callers supply RAW percentile summaries computed with the benchmark's
 * existing trim, sample population and group, and its gated successRate.
 * Never derive a missing raw metric by inverting a capped v1 score. Never
 * average different size/mode/mechanism groups into a fabricated raw sample.
 */
export const PERFORMANCE_CANDIDATE_VERSION = 'performance-continuous-v2-candidate' as const;

export type PerformanceBenchmarkId =
  | 'oci-tti-stealth'
  | 'sandbox-cpu-burst-stealth'
  | 'sandbox-cpu-stealth'
  | 'sandbox-fs-api-stealth'
  | 'sandbox-fs-io-stealth'
  | 'sandbox-rootfs-stealth';

type Percentile = 'median' | 'p95' | 'p99';
type Weights = Readonly<Record<Percentile, number>>;
type Curve = 'reciprocal-lower' | 'reciprocal-higher' | 'burst-delivery' | 'completion-rank';
interface PerformanceMetric {
  readonly key: string;
  readonly curve: Curve;
  /** Fixed half-score reference; for burst, excess headroom half-bonus. */
  readonly reference: number;
  readonly weights: Weights;
}
interface PerformanceProfile {
  readonly activation: 'review-only';
  readonly groupBy?: string;
  /** Documentation for the producer of successRate; not an alternative gate. */
  readonly requireData?: Readonly<Record<string, string | number | boolean>>;
  readonly metrics: readonly PerformanceMetric[];
}

// References reuse v1's published calibration values, now as half-score
// points rather than clipping bounds. These are reviewable value judgements,
// not fitted constants or provider-relative ranks. No weights are changed.
export const PERFORMANCE_PROFILES: Readonly<Record<PerformanceBenchmarkId, PerformanceProfile>> = {
  'oci-tti-stealth': {
    activation: 'review-only', groupBy: 'mechanism', requireData: { verified: true },
    metrics: [{ key: 'ttiMs', curve: 'reciprocal-lower', reference: 6000, weights: { median: 0.6, p95: 0.25, p99: 0.15 } }],
  },
  'sandbox-cpu-burst-stealth': {
    activation: 'review-only',
    metrics: [{ key: 'burstHeadroom', curve: 'burst-delivery', reference: 7, weights: { median: 1, p95: 0, p99: 0 } }],
  },
  'sandbox-cpu-stealth': {
    activation: 'review-only', groupBy: 'phase', requireData: { done: true },
    metrics: [
      { key: 'multiCorePerVcpuMBps', curve: 'reciprocal-higher', reference: 2000, weights: { median: 0.45, p95: 0.1, p99: 0.05 } },
      { key: 'singleCoreMBps', curve: 'reciprocal-higher', reference: 2000, weights: { median: 0.3, p95: 0.07, p99: 0.03 } },
    ],
  },
  'sandbox-fs-api-stealth': {
    activation: 'review-only', requireData: { verified: true },
    // Already a measured completion + speed rank, transformed per record.
    // Its nearest-rank p99 retains the existing end-of-sweep semantics.
    metrics: [{ key: 'performanceRankScoreV2', curve: 'completion-rank', reference: 200, weights: { median: 0, p95: 0, p99: 1 } }],
  },
  'sandbox-fs-io-stealth': {
    activation: 'review-only', groupBy: 'phase', requireData: { verified: true },
    metrics: [{ key: 'totalMs', curve: 'reciprocal-lower', reference: 8000, weights: { median: 0.7, p95: 0.2, p99: 0.1 } }],
  },
  'sandbox-rootfs-stealth': {
    activation: 'review-only', requireData: { destroyPassed: 1 },
    metrics: [
      { key: 'createMs', curve: 'reciprocal-lower', reference: 4000, weights: { median: 0.1, p95: 0.05, p99: 0 } },
      { key: 'seqWriteMBps', curve: 'reciprocal-higher', reference: 500, weights: { median: 0.3, p95: 0, p99: 0 } },
      { key: 'seqReadMBps', curve: 'reciprocal-higher', reference: 1000, weights: { median: 0.25, p95: 0, p99: 0 } },
      { key: 'smallFileOpsPerSec', curve: 'reciprocal-higher', reference: 500, weights: { median: 0.25, p95: 0, p99: 0 } },
      { key: 'destroyMs', curve: 'reciprocal-lower', reference: 3000, weights: { median: 0.05, p95: 0, p99: 0 } },
    ],
  },
};

/** Partial statistics preserve the difference between missing and measured 0. */
export type PerformanceMetricSummary = Partial<Record<Percentile, number>>;
export interface PerformanceSummaryInput {
  metrics: Readonly<Record<string, PerformanceMetricSummary | undefined>>;
  /** Derived using status AND the profile's requireData; null means unknown. */
  successRate: number | null;
  availability?: 'measured' | 'missing' | 'unsupported';
}
export interface PerformanceCandidateResult {
  methodology: typeof PERFORMANCE_CANDIDATE_VERSION;
  state: 'scored' | 'failed' | 'unsupported' | 'missing' | 'insufficient';
  /** Full precision for ordering; rounding belongs only in presentation. */
  compositeScore: number | null;
  missingMeasurements: string[];
}

/** Curve evaluation is AFTER aggregation, preserving raw percentile tails. */
function scoreStatistic(value: number, metric: PerformanceMetric): number {
  switch (metric.curve) {
    case 'reciprocal-lower': return 100 / (1 + value / metric.reference);
    // This form avoids overflowing x + reference for large finite values.
    case 'reciprocal-higher': return value === 0 ? 0 : 100 / (1 + metric.reference / value);
    case 'burst-delivery': return value <= 1 ? 60 * value : 60 + 40 / (1 + metric.reference / (value - 1));
    case 'completion-rank': return 100 * (value / metric.reference);
  }
}

/**
 * Evaluates one provider/group without peers, I/O or live activation. Missing
 * weighted statistics produce no candidate, rather than fabricated zeroes or
 * redistributed weights. A real failed/unsupported result still scores zero.
 */
export function scorePerformanceCandidate(
  id: PerformanceBenchmarkId,
  input: PerformanceSummaryInput,
): PerformanceCandidateResult {
  const result = (state: PerformanceCandidateResult['state'], compositeScore: number | null, missingMeasurements: string[] = []): PerformanceCandidateResult =>
    ({ methodology: PERFORMANCE_CANDIDATE_VERSION, state, compositeScore, missingMeasurements });
  if (input.successRate !== null && (!Number.isFinite(input.successRate) || input.successRate < 0 || input.successRate > 1)) {
    throw new RangeError('successRate must be null or a finite value in [0, 1]');
  }
  if (input.availability === 'missing') return result('missing', null);
  if (input.availability === 'unsupported') {
    if (input.successRate !== 0) throw new RangeError('unsupported requires an explicit successRate of 0');
    return result('unsupported', 0);
  }
  if (input.successRate === null) return result('missing', null, ['successRate']);
  if (input.successRate === 0) return result('failed', 0);

  const missingMeasurements: string[] = [];
  let weightedScore = 0;
  for (const metric of PERFORMANCE_PROFILES[id].metrics) {
    for (const percentile of ['median', 'p95', 'p99'] as const) {
      const weight = metric.weights[percentile];
      if (weight === 0) continue;
      const value = input.metrics[metric.key]?.[percentile];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        (metric.curve === 'completion-rank' && value > metric.reference)) {
        missingMeasurements.push(`${metric.key}.${percentile}`);
        continue;
      }
      weightedScore += weight * scoreStatistic(value, metric);
    }
  }
  if (missingMeasurements.length) return result('insufficient', null, missingMeasurements);
  return result('scored', weightedScore * input.successRate);
}

/**
 * Candidate measurement only: non-completers retain their capability tier,
 * independent of speed. Completers get 100 + soft speed, in [100, 200].
 * Last successful duration per size, shared-sandbox scheduling and the
 * separate success multiplier remain the v1 workload's choices. This helper
 * must run only after write/read/hash/delete succeeded for the current size.
 */
export function performanceFsApiRankScore(
  completedSizes: number,
  totalSizes: number,
  sweepRtMs?: number,
  sweepTargetMs?: number,
): number | undefined {
  if (!Number.isSafeInteger(totalSizes) || totalSizes < 1 || !Number.isSafeInteger(completedSizes) ||
    completedSizes < 0 || completedSizes > totalSizes) return undefined;
  if (completedSizes < totalSizes) return 100 * completedSizes / totalSizes;
  if (typeof sweepRtMs !== 'number' || !Number.isFinite(sweepRtMs) || sweepRtMs < 0 ||
    typeof sweepTargetMs !== 'number' || !Number.isFinite(sweepTargetMs) || sweepTargetMs <= 0) return undefined;
  return 100 + 100 / (1 + sweepRtMs / sweepTargetMs);
}
