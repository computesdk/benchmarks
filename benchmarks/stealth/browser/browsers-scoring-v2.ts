/**
 * INACTIVE browser scoring candidates for methodology review.
 *
 * Nothing imports this from a benchmark, exporter, workflow or rollup. These
 * functions are an offline reference, NOT a scoring-spec extension understood
 * by @benchsdk/runner 0.8.2. See docs/browsers-scoring-v2.md for integration limits,
 * calibration decisions and the limits of historical evidence.
 */
import { computeStats } from '../src/util/stats.js';
import { computeConcurrentSuccessRate, supportedP95 } from './concurrent-scoring.js';
import {
  CONCURRENCY_LEVELS,
  SWEEP_WEIGHTS,
  type ConcurrentBenchmarkResult,
  type ConcurrentStatsTriple,
} from './concurrent-types.js';

export const BROWSERS_SCORING_CANDIDATE = 'browsers-v2-candidate-1' as const;

export interface BrowserObservation {
  // Status is required. Legacy iterations[] without it cannot be silently
  // promoted into successful measurements for a historical comparison.
  status: 'success' | 'error';
  data?: Record<string, unknown>;
}

export interface BrowserCandidateScore {
  methodology: typeof BROWSERS_SCORING_CANDIDATE;
  /** Full precision; null means no observed outcome, not a measured failure. */
  compositeScore: number | null;
  /** Diagnostic contribution only; never rank an incomplete observation. */
  observedPoints: number | null;
  /** Every unobserved dimension remains visible; its weight is never moved. */
  missingMeasurements: string[];
}

function referenceScale(scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Reference scale must be finite and positive');
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Reciprocal curve applied AFTER computing raw latency percentiles. */
export function browserLatencyPoints(value: unknown, referenceMs: number): number | null {
  referenceScale(referenceMs);
  return nonnegative(value) ? 100 / (1 + value / referenceMs) : null;
}

/** Higher throughput keeps improving after the reference value (50 points). */
export function browserThroughputPoints(value: unknown, referenceAps: number): number | null {
  referenceScale(referenceAps);
  return !nonnegative(value) ? null : value === 0 ? 0 : 100 / (1 + referenceAps / value);
}

function result(compositeScore: number | null, missingMeasurements: string[]): BrowserCandidateScore {
  return { methodology: BROWSERS_SCORING_CANDIDATE,
    compositeScore: missingMeasurements.length ? null : compositeScore,
    observedPoints: compositeScore, missingMeasurements };
}

function observed(records: readonly BrowserObservation[]): BrowserObservation[] {
  return records.filter((record) => record.status === 'success');
}

function values(records: readonly BrowserObservation[], key: string): number[] {
  return records.map((record) => record.data?.[key]).filter(nonnegative);
}

/** Capability fractions use untrimmed observations: minority failures matter. */
function flagMean(records: readonly BrowserObservation[], key: string, missing: string[]): number {
  const flags = records.map((record) => record.data?.[key]).filter((value) => value === 0 || value === 1);
  if (!flags.length || flags.length !== records.length) missing.push(key);
  if (!flags.length) {
    return 0;
  }
  return flags.reduce<number>((sum, flag) => sum + flag, 0) / records.length;
}

function latencyContribution(
  records: readonly BrowserObservation[], key: string, referenceMs: number,
  weights: { median: number; p95: number; p99: number }, missing: string[],
): number {
  const samples = values(records, key);
  if (!samples.length) {
    missing.push(key);
    return 0;
  }
  if (samples.length !== records.length) missing.push(key);
  // Retain the installed runner's 5% symmetric trim and nearest-rank tails.
  // Transforming each latency first would reverse the p95/p99 interpretation.
  const stats = computeStats(samples, 0.05);
  return (['median', 'p95', 'p99'] as const).reduce(
    (sum, stat) => sum + weights[stat] * browserLatencyPoints(stats[stat], referenceMs)!, 0,
  );
}

/**
 * Same 70/30 capability/speed allocation, fixed 50-point budget per direction.
 * Support AND byte/echo verification are required. Missing time is not instant.
 * Per-record precision is retained before the existing median aggregation.
 */
export function scoreFileTransferCandidate(records: readonly BrowserObservation[]): BrowserCandidateScore {
  if (!records.length) return result(null, ['records']);
  const completed = observed(records).filter((record) => record.data?.benchCompleted === 1);
  const missing = new Set<string>();
  if (observed(records).some((record) => record.data?.benchCompleted !== 0 && record.data?.benchCompleted !== 1)) {
    missing.add('benchCompleted');
  }
  const scores = completed.map((record) => {
    let points = 0;
    for (const direction of ['download', 'upload']) {
      const data = record.data ?? {};
      if (data[`${direction}Supported`] !== 0 && data[`${direction}Supported`] !== 1) missing.add(`${direction}Supported`);
      if (data[`${direction}Supported`] === 1 && data[`${direction}Match`] !== 0 && data[`${direction}Match`] !== 1) missing.add(`${direction}Match`);
      if (data[`${direction}Supported`] !== 1 || data[`${direction}Match`] !== 1) continue;
      points += 35;
      const speed = browserLatencyPoints(data[`${direction}Ms`], 30_000);
      if (speed === null) missing.add(`${direction}Ms`);
      else points += 0.15 * speed;
    }
    return points;
  });
  // Completion is the existing benchCompleted/status gate; unsupported is a
  // completed zero, while a transport/harness error lowers this success rate.
  const points = scores.length ? computeStats(scores, 0.05).median * completed.length / records.length : 0;
  return result(points, [...missing]);
}

const IDLE_WEIGHTS = {
  resume10s: { weight: 0.1, phase: 'idle-10s' },
  resume30s: { weight: 0.15, phase: 'idle-30s' },
  resume60s: { weight: 0.25, phase: 'idle-60s' },
  resume300s: { weight: 0.3, phase: 'idle-300s' },
} as const;

/** Survival remains 80% of the score; no second resume-success multiplier. */
export function scoreIdleResumeCandidate(records: readonly BrowserObservation[]): BrowserCandidateScore {
  if (!records.length) return result(null, ['records']);
  if (records.some(record => record.status !== 'success' && record.status !== 'error')) return result(null, ['status']);
  const measured = observed(records);
  if (!measured.length) return result(0, []);
  const missing: string[] = [];
  let points = 0;
  for (const [key, { weight, phase }] of Object.entries(IDLE_WEIGHTS)) {
    const phaseRecords = measured.filter((record) => record.data?.phase === phase || record.data?.[key] !== undefined);
    points += 100 * weight * flagMean(phaseRecords, key, missing);
  }
  // A failed reconnect's attempt duration is not a successful resume latency.
  const resumed = measured.filter((record) => record.data?.resumeSupported === 1);
  if (measured.some(record => record.data?.resumeSupported !== 0 && record.data?.resumeSupported !== 1)) missing.push('resumeSupported');
  if (resumed.length) points += latencyContribution(resumed, 'reconnectMs', 2_000, { median: 0.15, p95: 0.05, p99: 0 }, missing);
  return result(points * measured.length / records.length, missing);
}

/** Existing resume gate, timing weights and three state dimensions retained. */
export function scoreSessionPersistenceCandidate(records: readonly BrowserObservation[]): BrowserCandidateScore {
  if (!records.length) return result(null, ['records']);
  const measured = observed(records);
  const resumed = measured.filter((record) => record.data?.resumeSupported === 1);
  const missing: string[] = [];
  if (measured.some((record) => record.data?.resumeSupported !== 0 && record.data?.resumeSupported !== 1)) missing.push('resumeSupported');
  if (!resumed.length) return result(0, missing);
  let points = latencyContribution(resumed, 'reconnectMs', 2_000, { median: 0.35, p95: 0.1, p99: 0.05 }, missing);
  points += latencyContribution(resumed, 'totalMs', 5_000, { median: 0.2, p95: 0, p99: 0 }, missing);
  for (const key of ['cookiesPreserved', 'storagePreserved', 'tabsPreserved']) {
    points += 10 * flagMean(measured, key, missing);
  }
  return result(points * resumed.length / records.length, missing);
}

/**
 * Keep the existing 70/30 pass/speed budget. Apply the actual pass fraction
 * once; failed visits' sentinel zero timings never enter the latency sample.
 * The matrix's capability-only pass rates intentionally remain unchanged.
 */
export function scoreProtectedSitesCandidate(records: readonly BrowserObservation[]): BrowserCandidateScore {
  if (!records.length) return result(null, ['records']);
  const passed = observed(records).filter((record) => record.data?.passed === 1);
  const missing: string[] = [];
  if (observed(records).some((record) => record.data?.passed !== 0 && record.data?.passed !== 1)) missing.push('passed');
  if (!passed.length) return result(0, missing);
  const timing = latencyContribution(passed, 'timeToPassMs', 120_000, { median: 0.2, p95: 0.05, p99: 0.05 }, missing);
  return result((70 + timing) * passed.length / records.length, missing);
}

export interface BrowserConcurrencyObservation {
  // Preserve the runner's task-status gate in addition to per-session success.
  status: 'success' | 'error';
  result: ConcurrentBenchmarkResult;
}

function statValue(stats: ConcurrentStatsTriple | undefined, key: 'median' | 'p95'): number | undefined {
  return !stats || stats.samples === 0 ? undefined : stats[key];
}

/**
 * Retain level weights, action completion, task-status and measured peak gates.
 * Input is one provider's sweep; no competing provider enters the formula.
 */
export function scoreBrowserConcurrencyCandidate(
  observations: readonly BrowserConcurrencyObservation[],
): BrowserCandidateScore {
  if (!observations.length) return result(null, ['levels']);
  const levels = new Map<number, BrowserConcurrencyObservation>();
  const providers = new Set(observations.map((observation) => observation.result.provider));
  if (providers.size !== 1) throw new Error('Score exactly one provider per sweep');
  for (const observation of observations) {
    const level = observation.result.concurrencyLevel;
    if (!CONCURRENCY_LEVELS.some((known) => known === level) || levels.has(level)) {
      throw new Error(`Unknown or duplicate concurrency level: ${level}`);
    }
    levels.set(level, observation);
  }
  const missing: string[] = [];
  let points = 0;
  let outcomes = 0;
  let successfulTasks = 0;
  for (const level of CONCURRENCY_LEVELS) {
    const observation = levels.get(level);
    const measurement = observation?.result;
    if (!measurement || measurement.skipped || !measurement.rounds.length) {
      missing.push(`c${level}`);
      continue;
    }
    if (observation.status === 'success' && measurement.rounds.some((round) =>
      round.maxLiveSessions === undefined || round.maxConcurrentActions === undefined)) {
      missing.push(`c${level}:peak`);
      continue;
    }
    outcomes++;
    if (observation.status !== 'success') continue;
    // A successful flag cannot override evidence that the requested load was
    // not actually reached. This is also a failure in the current task code.
    if (measurement.rounds.some((round) => round.roundFailed || round.error ||
      round.maxLiveSessions !== level || round.maxConcurrentActions !== level)) continue;
    successfulTasks++;
    const summary = measurement.summary;
    const loop = summary.loopMs ?? summary.taskMs;
    const terms: [string, number, number | null][] = [
      ['createMs', 0.3, browserLatencyPoints(statValue(summary.createMs, 'median'), 30_000)],
      ['loopMs', 0.25, browserLatencyPoints(statValue(loop, 'median'), 30_000)],
      ['loopMs.p95', 0.2, browserLatencyPoints(loop?.samples === 0 ? undefined : supportedP95(loop) ?? loop?.median, 30_000)],
      ['screenshot', 0.15, browserLatencyPoints(statValue(summary.perActionType.screenshot, 'median'), 30_000)],
      ['perSessionAps', 0.1, browserThroughputPoints(statValue(summary.perSessionActionsPerSecond, 'median'), 10)],
    ];
    let levelPoints = 0;
    for (const [key, weight, value] of terms) {
      if (value === null) missing.push(`c${level}:${key}`);
      else levelPoints += weight * value;
    }
    points += SWEEP_WEIGHTS[level] * levelPoints * computeConcurrentSuccessRate(measurement);
  }
  // Keep the runner's run-wide task success multiplier as well as each
  // level's session success. Missing levels keep their fixed zero weight.
  return result(outcomes ? points * successfulTasks / outcomes : null, missing);
}
