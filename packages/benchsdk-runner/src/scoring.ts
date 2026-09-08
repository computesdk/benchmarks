import type { JsonObject, TaskResultRecord } from '@benchsdk/api';
import type { BenchmarkRunOutcome } from './bench-config.js';

export type MetricValue = string | ((record: TaskResultRecord) => number | number[] | undefined);

export interface MetricScoring {
  name: string;
  value?: MetricValue;
  unit?: string;
  ceiling: number;
  floor?: number;
  higherIsBetter?: boolean;
  weights: { median: number; p95: number; p99: number };
  trim?: number;
}

export interface BenchmarkScoringWeights {
  median: number;
  p95: number;
  p99: number;
}

export interface BenchmarkScoringMetric {
  key: string;
  label?: string;
  unit?: string;
  ceiling: number;
  floor?: number;
  higherIsBetter?: boolean;
  weights: BenchmarkScoringWeights;
  trim?: number;
}

/**
 * Serializable counterpart to a `success` predicate: a record counts as
 * successful only if it succeeded *and* every listed data field equals the
 * given value (e.g. `{ verified: true }`, `{ actionsCompleted: 24 }`). Kept to
 * equality on scalar data fields so the platform can express the same rule as
 * a query predicate rather than replaying benchmark code.
 */
export interface BenchmarkScoringSuccess {
  requireData: Record<string, string | number | boolean>;
}

/** Serializable scoring spec declared in a `*.bench.ts` file and uploaded to the platform. */
export interface BenchmarkScoringConfig {
  /** Optional data key to group records by when computing summary rows (e.g. 'file_size'). */
  groupBy?: string;
  /** Extra conditions a record must meet to count as successful. Default: `status === 'success'`. */
  success?: BenchmarkScoringSuccess;
  metrics: BenchmarkScoringMetric[];
}

export interface ScoringSpec {
  dimensions?: Record<string, unknown>;
  /** Optional data key that groups task records into separate summary rows. */
  groupBy?: string;
  success?: (record: TaskResultRecord) => boolean;
  metrics: MetricScoring[];
}

export interface BenchmarkScoreResult {
  provider: string;
  dimensions: JsonObject;
  metrics: { name: string; unit: string; median: number; p95: number; p99: number }[];
  scalars?: { name: string; value: number; unit: string }[];
  compositeScore: number;
  successRate: number;
  scoringVersion?: string;
  skipped: boolean;
  skipReason?: string;
}

export type LowerIsBetter = (
  name: string,
  opts: {
    unit?: string;
    ceiling: number;
    value?: MetricValue;
    weights: { median: number; p95: number; p99: number };
    trim?: number;
  },
) => MetricScoring;

export type HigherIsBetter = (
  name: string,
  opts: {
    unit?: string;
    floor?: number;
    ceiling: number;
    value?: MetricValue;
    weights: { median: number; p95: number; p99: number };
    trim?: number;
  },
) => MetricScoring;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeStats(values: number[], trimPercent: number = 0.05): { median: number; p95: number; p99: number } {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);

  const trimCount = Math.floor(sorted.length * trimPercent);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return { median, p95: percentile(trimmed, 95), p99: percentile(trimmed, 99) };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

function collectSamples(metric: MetricScoring, records: TaskResultRecord[]): number[] {
  const samples: number[] = [];
  for (const record of records) {
    const raw = typeof metric.value === 'function'
      ? metric.value(record)
      : record.data?.[metric.value ?? metric.name];

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (isFiniteNumber(item)) samples.push(item);
      }
    } else if (isFiniteNumber(raw)) {
      samples.push(raw);
    }
  }
  return samples;
}

function scoreStat(stat: number, metric: MetricScoring): number {
  if (metric.higherIsBetter) {
    const floor = metric.floor ?? 0;
    if (stat <= floor) return 0;
    if (stat >= metric.ceiling) return 100;
    return ((stat - floor) / (metric.ceiling - floor)) * 100;
  }
  return Math.max(0, 100 * (1 - stat / metric.ceiling));
}

export const lowerIsBetter: LowerIsBetter = (name, opts) => ({
  name,
  ...opts,
  higherIsBetter: false,
});

export const higherIsBetter: HigherIsBetter = (name, opts) => ({
  name,
  ...opts,
  higherIsBetter: true,
});

const WEIGHT_SUM_TOLERANCE = 0.01;

// Thrown by validateScoringSpec — a distinguishable type so runner.ts can
// tell "this benchmark's onScore is misconfigured" (an authoring bug, must
// fail the run) apart from transient submit/network failures (which should
// keep degrading to a warning, per runner.ts's existing catch behavior).
export class ScoringSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringSpecError';
  }
}

// Each metric's weights.median + weights.p95 + weights.p99 is a share of the
// overall 0-100 compositeScore — summed across every declared metric they
// must total 1.0, or compositeScore silently drifts off its advertised
// scale. Validated against spec.metrics as declared, not the post-sample-
// filter scores in score()'s participant loop, since a metric with zero
// samples for a given participant is legitimately excluded there — a
// per-run runtime fact, not an authoring mistake.
export function validateScoringSpec(spec: ScoringSpec): void {
  const totalWeight = spec.metrics.reduce(
    (sum, m) => sum + m.weights.median + m.weights.p95 + m.weights.p99,
    0,
  );
  if (Math.abs(totalWeight - 1) > WEIGHT_SUM_TOLERANCE) {
    const breakdown = spec.metrics
      .map((m) => `${m.name}=${(m.weights.median + m.weights.p95 + m.weights.p99).toFixed(3)}`)
      .join(', ');
    throw new ScoringSpecError(
      `Scoring spec weights sum to ${totalWeight.toFixed(3)}, expected 1.0 ` +
      `(±${WEIGHT_SUM_TOLERANCE}). Each metric's weights.median + weights.p95 + weights.p99, ` +
      `summed across every declared metric, must total 1.0 for compositeScore to stay a ` +
      `meaningful 0-100 scale. Per-metric totals: ${breakdown || '(no metrics declared)'}`,
    );
  }
}

function groupRecordsByKey(
  records: TaskResultRecord[],
  key: string,
): { value: unknown; records: TaskResultRecord[] }[] {
  const groups = new Map<string, { value: unknown; records: TaskResultRecord[] }>();
  for (const record of records) {
    const raw = record.data?.[key];
    const value = raw === undefined ? undefined : raw;
    const mapKey = value === undefined ? '__undefined__' : JSON.stringify(value);
    let group = groups.get(mapKey);
    if (!group) {
      group = { value, records: [] };
      groups.set(mapKey, group);
    }
    group.records.push(record);
  }
  return Array.from(groups.values());
}

function scoreGroup(
  records: TaskResultRecord[],
  spec: ScoringSpec,
  baseDimensions: JsonObject,
  groupKey: string | undefined,
  groupValue: unknown,
  provider: string,
): BenchmarkScoreResult {
  const successFilter = spec.success ?? ((r: TaskResultRecord) => r.status === 'success');
  const passing = records.filter(successFilter);
  const successRate = records.length === 0 ? 0 : passing.length / records.length;
  const skipped = records.length === 0;

  let metricScoresSum = 0;
  const metrics: BenchmarkScoreResult['metrics'] = [];

  for (const metric of spec.metrics) {
    const samples = collectSamples(metric, passing);
    // A metric with no data points should not contribute to the composite
    // score; otherwise an empty lower-is-better metric would be scored as 100.
    if (samples.length === 0) {
      continue;
    }
    const { median, p95, p99 } = computeStats(samples, metric.trim ?? 0.05);
    const metricScore =
      metric.weights.median * scoreStat(median, metric) +
      metric.weights.p95 * scoreStat(p95, metric) +
      metric.weights.p99 * scoreStat(p99, metric);
    metricScoresSum += metricScore;

    metrics.push({ name: metric.name, unit: metric.unit ?? '', median, p95, p99 });
  }

  const compositeScore = successRate === 0 ? 0 : Math.round(metricScoresSum * successRate * 100) / 100;

  const dimensions = toJsonObject({
    ...baseDimensions,
    ...(groupKey !== undefined && groupValue !== undefined ? { [groupKey]: groupValue } : {}),
  });

  return {
    provider,
    dimensions,
    metrics,
    compositeScore,
    successRate,
    skipped,
  };
}

export function score(outcome: BenchmarkRunOutcome, spec: ScoringSpec): BenchmarkScoreResult[] {
  validateScoringSpec(spec);
  const baseDimensions = toJsonObject(spec.dimensions ?? {});
  const results: BenchmarkScoreResult[] = [];

  for (const { participant, records } of outcome.participants) {
    // A participant that recorded nothing has no group to belong to, but it
    // still has to appear in the summary as skipped rather than vanish from it.
    const groups = spec.groupBy && records.length > 0
      ? [{ value: undefined, records }, ...groupRecordsByKey(records, spec.groupBy)]
      : [{ value: undefined, records }];

    for (const group of groups) {
      results.push(scoreGroup(group.records, spec, baseDimensions, spec.groupBy, group.value, participant));
    }
  }

  return results;
}

/** Builds a runtime {@link ScoringSpec} from a serializable {@link BenchmarkScoringConfig}. */
export function scoringConfigToSpec(
  config: BenchmarkScoringConfig,
  dimensions?: Record<string, unknown>,
  display?: { metrics?: { key: string; unit?: string }[] },
): ScoringSpec {
  const success = config.success;
  const unitByMetric = new Map(display?.metrics?.map((m) => [m.key, m.unit]));
  return {
    ...(dimensions ? { dimensions: toJsonObject(dimensions) } : {}),
    ...(config.groupBy ? { groupBy: config.groupBy } : {}),
    ...(success
      ? {
        success: (record: TaskResultRecord) =>
          record.status === 'success' &&
          Object.entries(success.requireData).every(([key, value]) => record.data?.[key] === value),
      }
      : {}),
    metrics: config.metrics.map((metric) => ({
      name: metric.key,
      value: metric.key,
      unit: (display?.metrics === undefined ? metric.unit : (unitByMetric.get(metric.key) ?? metric.unit)) ?? '',
      ceiling: metric.ceiling,
      floor: metric.floor,
      higherIsBetter: metric.higherIsBetter,
      weights: metric.weights,
      trim: metric.trim,
    })),
  };
}
