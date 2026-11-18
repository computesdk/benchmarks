/**
 * OFFLINE proposal, deliberately not imported by any live benchmark config.
 * This is not a BenchmarkScoringConfig extension: the installed runner and
 * platform cannot serialize/recompute this methodology yet. See
 * docs/state-scoring-audit.md for calibration, parity and activation requirements.
 */
import { computeStats } from '../src/util/stats.js';
import { FILESYSTEM_SNAPSHOT_CEILINGS_MS } from './filesystem-snapshot.js';
import { FIDELITY_CEILINGS_MS } from './sandbox-fidelity.js';
import { PAUSE_RESUME_CEILINGS_MS } from './sandbox-pause-resume.js';
import { SNAPSHOT_FANOUT_CEILINGS_MS } from './sandbox-snapshot-fanout.js';
import { SNAPSHOT_CEILINGS_MS } from './sandbox-snapshot.js';

export const STATE_CANDIDATE_VERSION = 'state-continuous-v2-candidate';

export type StateBenchmarkId =
  | 'filesystem-snapshot-stealth'
  | 'sandbox-fidelity-stealth'
  | 'sandbox-pause-resume-stealth'
  | 'sandbox-snapshot-fanout-stealth'
  | 'sandbox-snapshot-stealth'
  | 'sandbox-volumes-stealth';

export interface StateCandidateMetric {
  readonly key: string;
  readonly unit: string;
  /** Proposed half-score point, frozen from the existing ceiling; not a timeout. */
  readonly reference: number;
  readonly higherIsBetter: boolean;
  readonly weights: { readonly median: number; readonly p95: number; readonly p99: number };
  readonly trim: number;
}

export interface StateCandidateSpec {
  readonly benchmarkId: StateBenchmarkId;
  readonly version: typeof STATE_CANDIDATE_VERSION;
  readonly supportKey: 'snapshotSupported' | 'pauseSupported' | 'volumeSupported';
  readonly requireData: Readonly<Record<string, boolean | number | string>>;
  readonly metrics: readonly StateCandidateMetric[];
}

function lower(key: string, reference: number, median: number, p95 = 0): StateCandidateMetric {
  return { key, reference, unit: 'ms', higherIsBetter: false, weights: { median, p95, p99: 0 }, trim: 0.05 };
}

function higher(key: string, unit: string, reference: number, median: number): StateCandidateMetric {
  return { key, reference, unit, higherIsBetter: true, weights: { median, p95: 0, p99: 0 }, trim: 0.05 };
}

function spec(
  benchmarkId: StateBenchmarkId,
  supportKey: StateCandidateSpec['supportKey'],
  metrics: StateCandidateMetric[],
): StateCandidateSpec {
  return { benchmarkId, version: STATE_CANDIDATE_VERSION, supportKey, requireData: { verifyPassed: supportKey === 'volumeSupported' ? 1 : true }, metrics };
}

// Existing dimensions, weights, percentile direction and trimming are retained.
// Reinterpreting ceilings as half-score references is an explicit proposal,
// not a claim that these historical constants are empirically optimal.
export const STATE_SCORING_CANDIDATES: Readonly<Record<StateBenchmarkId, StateCandidateSpec>> = {
  'filesystem-snapshot-stealth': spec('filesystem-snapshot-stealth', 'snapshotSupported', [
    lower('createMs', FILESYSTEM_SNAPSHOT_CEILINGS_MS.createMs, 0.1),
    lower('populateMs', FILESYSTEM_SNAPSHOT_CEILINGS_MS.populateMs, 0.1),
    lower('snapshotCreateMs', FILESYSTEM_SNAPSHOT_CEILINGS_MS.snapshotCreateMs, 0.15),
    lower('snapshotRestoreMs', FILESYSTEM_SNAPSHOT_CEILINGS_MS.snapshotRestoreMs, 0.45),
    lower('verifyMs', FILESYSTEM_SNAPSHOT_CEILINGS_MS.verifyMs, 0.1),
    lower('destroyMs', FILESYSTEM_SNAPSHOT_CEILINGS_MS.destroyMs, 0.1),
  ]),
  'sandbox-fidelity-stealth': spec('sandbox-fidelity-stealth', 'snapshotSupported', [
    lower('createMs', FIDELITY_CEILINGS_MS.createMs, 0.1),
    lower('snapshotCreateMs', FIDELITY_CEILINGS_MS.snapshotCreateMs, 0.35),
    lower('snapshotRestoreMs', FIDELITY_CEILINGS_MS.snapshotRestoreMs, 0.45),
    lower('destroyMs', FIDELITY_CEILINGS_MS.destroyMs, 0.1),
  ]),
  'sandbox-pause-resume-stealth': spec('sandbox-pause-resume-stealth', 'pauseSupported', [
    lower('createMs', PAUSE_RESUME_CEILINGS_MS.createMs, 0.1),
    lower('pauseMs', PAUSE_RESUME_CEILINGS_MS.pauseMs, 0.35),
    lower('resumeMs', PAUSE_RESUME_CEILINGS_MS.resumeMs, 0.45),
    lower('destroyMs', PAUSE_RESUME_CEILINGS_MS.destroyMs, 0.1),
  ]),
  'sandbox-snapshot-fanout-stealth': spec('sandbox-snapshot-fanout-stealth', 'snapshotSupported', [
    lower('createMs', SNAPSHOT_FANOUT_CEILINGS_MS.createMs, 0.05),
    lower('snapshotCreateMs', SNAPSHOT_FANOUT_CEILINGS_MS.snapshotCreateMs, 0.2),
    lower('restoreMaxMs', SNAPSHOT_FANOUT_CEILINGS_MS.restoreMaxMs, 0.35),
    lower('fanoutWallClockMs', SNAPSHOT_FANOUT_CEILINGS_MS.fanoutWallClockMs, 0.3),
    lower('destroyMs', SNAPSHOT_FANOUT_CEILINGS_MS.destroyMs, 0.1),
  ]),
  'sandbox-snapshot-stealth': spec('sandbox-snapshot-stealth', 'snapshotSupported', [
    lower('createMs', SNAPSHOT_CEILINGS_MS.createMs, 0.1),
    lower('snapshotCreateMs', SNAPSHOT_CEILINGS_MS.snapshotCreateMs, 0.35),
    lower('snapshotRestoreMs', SNAPSHOT_CEILINGS_MS.snapshotRestoreMs, 0.45),
    lower('destroyMs', SNAPSHOT_CEILINGS_MS.destroyMs, 0.1),
  ]),
  // Raw companion keys are collected without changing v1 scored keys. Historical
  // rounded values must not be represented as recovered full-precision samples.
  'sandbox-volumes-stealth': spec('sandbox-volumes-stealth', 'volumeSupported', [
    lower('volumeCreateRawMs', 8_000, 0.05),
    lower('mountedReadyRawMs', 8_000, 0.10, 0.05),
    higher('seqWriteRawMBps', 'MB/s', 500, 0.15),
    higher('seqReadRawMBps', 'MB/s', 1_000, 0.10),
    higher('smallFileRawOpsPerSec', 'ops/s', 500, 0.15),
    lower('reattachRawMs', 60_000, 0.25, 0.10),
    lower('verifyRawMs', 30_000, 0.05),
  ]),
};

export interface StateCandidateObservation {
  readonly status: 'success' | 'error';
  readonly data: Readonly<Record<string, unknown>>;
}

export interface StateCandidateResult {
  version: typeof STATE_CANDIDATE_VERSION;
  outcome: 'missing' | 'unsupported' | 'failed' | 'incomplete' | 'scored';
  /** null means no comparable score, distinct from an observed failure's 0. */
  compositeScore: number | null;
  successRate: number | null;
  attempts: number;
  passed: number;
  invalidMetrics: string[];
  metrics: Record<string, { median: number; p95: number; p99: number }>;
}

/** Strictly monotone on finite nonnegative observations, without a score cap. */
export function stateCandidateUtility(value: unknown, reference: number, higherIsBetter: boolean): number | null {
  if (!Number.isFinite(reference) || reference <= 0) throw new Error('reference must be finite and positive');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (!higherIsBetter) return 100 / (1 + value / reference);
  return value === 0 ? 0 : 100 / (1 + reference / value);
}

function validateSpec(candidate: StateCandidateSpec): void {
  if (candidate.metrics.length === 0) throw new Error('candidate has no metrics');
  const keys = new Set<string>();
  let weight = 0;
  for (const metric of candidate.metrics) {
    if (keys.has(metric.key)) throw new Error(`duplicate metric ${metric.key}`);
    keys.add(metric.key);
    if (!Number.isFinite(metric.reference) || metric.reference <= 0) throw new Error('reference must be finite and positive');
    if (!Number.isFinite(metric.trim) || metric.trim < 0 || metric.trim >= 0.5) throw new Error('invalid trim');
    for (const value of Object.values(metric.weights)) {
      if (!Number.isFinite(value) || value < 0) throw new Error('invalid weight');
      weight += value;
    }
  }
  if (Math.abs(weight - 1) > 1e-12) throw new Error('candidate weights must sum to one');
}

/**
 * Offline per-participant scoring. Passing means status success + the existing
 * verification gate. Explicit unsupported metadata can never override failure.
 * A verified task missing any weighted measurement yields an incomplete result;
 * it is not substituted with zero, rewarded or reweighted over fewer metrics.
 * All percentiles are computed BEFORE utility, using the existing stats helper.
 */
export function evaluateStateCandidate(
  candidate: StateCandidateSpec,
  observations: readonly StateCandidateObservation[],
): StateCandidateResult {
  validateSpec(candidate);
  const passing = observations.filter((record) =>
    record.status === 'success' && record.data[candidate.supportKey] !== false &&
    Object.entries(candidate.requireData).every(([key, value]) => record.data[key] === value),
  );
  const result: StateCandidateResult = {
    version: STATE_CANDIDATE_VERSION,
    outcome: 'scored',
    compositeScore: null,
    successRate: observations.length ? passing.length / observations.length : null,
    attempts: observations.length,
    passed: passing.length,
    invalidMetrics: [],
    metrics: {},
  };
  if (observations.length === 0) return { ...result, outcome: 'missing' };
  if (passing.length === 0) {
    return { ...result, compositeScore: 0, outcome: observations.every((r) => r.data[candidate.supportKey] === false) ? 'unsupported' : 'failed' };
  }
  let weightedScore = 0;
  for (const metric of candidate.metrics) {
    const values = passing.map((r) => r.data[metric.key]);
    if (values.some((value) => stateCandidateUtility(value, metric.reference, metric.higherIsBetter) === null)) {
      result.invalidMetrics.push(metric.key);
      continue;
    }
    const stats = computeStats(values as number[], metric.trim);
    result.metrics[metric.key] = stats;
    for (const stat of ['median', 'p95', 'p99'] as const) {
      weightedScore += metric.weights[stat] * stateCandidateUtility(stats[stat], metric.reference, metric.higherIsBetter)!;
    }
  }
  if (result.invalidMetrics.length) return { ...result, outcome: 'incomplete' };
  // Keep full numeric precision for comparisons. Presentation rounding is not
  // a deterministic tie-breaker and must not become the weekly stored score.
  result.compositeScore = weightedScore * result.successRate!;
  return result;
}
