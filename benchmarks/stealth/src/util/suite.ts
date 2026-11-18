/**
 * Generic suite machinery shared by every sandbox-snapshot benchmark:
 * stage-metric scoring, per-provider stats, the results JSON serializer, and
 * the @benchsdk/runner ParticipantRecords -> legacy results bridge.
 *
 * Each suite declares a SuiteSpec (metric keys + ceilings + weights + pass
 * predicate); everything below is spec-driven so the suites stay consistent.
 */
import fs, { copyFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex, recordFailureMessage } from './records.js';
import { percentile, computeStats } from './stats.js';
import { scoreParticipantRecords } from './scoring.js';

// ---------------------------------------------------------------------------
// Spec + result types
// ---------------------------------------------------------------------------

export interface StageMetricSpec {
  /** Meta key holding the stage timing, e.g. 'snapshotRestoreMs'. */
  key: string;
  /** Calibration ceiling for `100 * (1 - value/ceiling)` scoring. */
  ceiling: number;
  /** Composite weight; stages with weight 0 are reported but unscored. */
  weight: number;
}

export interface SuiteSpec {
  /** Suite id stamped on every iteration + result, e.g. 'snapshot'. */
  id: string;
  /** Stage metrics scored into the composite. */
  stageMetrics: StageMetricSpec[];
  /** Iteration pass predicate over its recorded meta. */
  pass: (meta: Record<string, any>) => boolean;
  /** Extra result-level flags derived from the iteration list (e.g. snapshotSupported). */
  flags?: (iterations: WorkloadResult[]) => Record<string, any>;
  /** `config` block written into the serialized results file. */
  configBlock: Record<string, any>;
}

export interface WorkloadData {
  ok: true;
  suite: string;
  metric: { value: number; unit: 'ms'; higherIsBetter: false };
  meta: Record<string, any>;
}

export interface WorkloadFailure {
  ok: false;
  suite: string;
  reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
  error?: string;
  meta: Record<string, any>;
}

export type WorkloadResult = WorkloadData | WorkloadFailure;

export interface SuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: Record<string, any>;
  tier: string;
}

export interface SuiteBenchmarkResult {
  provider: string;
  suite: string;
  mode: string;
  iterations: WorkloadResult[];
  summary: SuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  tier?: string;
  flags?: Record<string, any>;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Lower is better: 100 * (1 - value/ceiling), clamped to [0, 100]. */
export function scoreMetric(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = 1 - value / ceiling;
  return clamp(ratio * 100, 0, 100);
}

function iterationPassed(spec: SuiteSpec, result: WorkloadResult): boolean {
  return spec.pass(result.meta);
}

/**
 * Per-provider stats: pass/fail from the spec's predicate, then a weighted
 * performance score (0-100) over each stage's median, multiplied by the
 * success rate. Providers with no passing iteration get compositeScore 0.
 */
export function computeSuiteStats(spec: SuiteSpec, results: WorkloadResult[]): SuiteStats {
  const passing = results.filter((r) => iterationPassed(spec, r));
  const total = results.length;

  if (passing.length === 0) {
    return {
      median: 0, p95: 0, p99: 0, min: 0, max: 0,
      successRate: 0, n: 0, scoreBeforeReliability: 0,
      compositeScore: 0, meta: lastMeta(results) ?? {}, tier: 'fail',
    };
  }

  const wallClockValues = passing
    .map((r) => r.meta?.wallClockMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);

  const sorted = [...wallClockValues].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const trimmed = stripOutliersBySigma(sorted, 2);
  const statsValues = trimmed.length >= 1 ? trimmed : sorted;
  const p95 = percentile(statsValues, 95);
  const p99 = percentile(statsValues, 99);

  const totalWeight = spec.stageMetrics.reduce((a, m) => a + m.weight, 0);
  let weightedScore = 0;
  for (const metric of spec.stageMetrics) {
    if (metric.weight === 0) continue;
    const values = extractMetric(spec, passing, metric.key);
    const metricMedian = values.length > 0 ? computeStats(values).median : 0;
    weightedScore += scoreMetric(metricMedian, metric.ceiling) * (metric.weight / totalWeight);
  }

  const successRate = passing.length / total;

  return {
    median, p95, p99,
    min: sorted[0], max: sorted[sorted.length - 1],
    successRate,
    n: passing.length,
    scoreBeforeReliability: weightedScore,
    compositeScore: weightedScore * successRate,
    meta: lastMeta(passing) ?? lastMeta(results) ?? {},
    tier: 'pass',
  };
}

// ---------------------------------------------------------------------------
// Results serializer
// ---------------------------------------------------------------------------

export interface MetricSummary {
  median: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
}

export async function writeSuiteResultsJson(
  spec: SuiteSpec,
  results: SuiteBenchmarkResult[],
  outPath: string,
  preserveScorePrecision = false,
): Promise<void> {
  const scorePrecision = preserveScorePrecision ? (value: number) => value : round;
  const cleanResults = results.map((r) => {
    const stageSummaries: Record<string, MetricSummary> = {};
    for (const metric of spec.stageMetrics) {
      stageSummaries[metric.key] = roundStats(extractMetric(spec, r.iterations, metric.key));
    }
    stageSummaries.totalMs = {
      median: round(r.summary.median),
      p95: round(r.summary.p95),
      p99: round(r.summary.p99),
      min: round(r.summary.min),
      max: round(r.summary.max),
    };

    return {
      provider: r.provider,
      suite: r.suite,
      mode: r.mode,
      iterations: r.iterations.map((i) =>
        i.ok
          ? {
              ok: true,
              suite: i.suite,
              metric: { value: round(i.metric.value), unit: i.metric.unit, higherIsBetter: i.metric.higherIsBetter },
              meta: i.meta,
            }
          : {
              ok: false,
              suite: i.suite,
              reason: i.reason,
              ...(i.error ? { error: i.error } : {}),
              meta: i.meta,
            },
      ),
      summary: stageSummaries,
      wallClockMs: round(r.wallClockMs),
      replicateMs: r.replicateMs.map(round),
      compositeScore: scorePrecision(r.compositeScore),
      successRate: scorePrecision(r.summary.successRate),
      n: r.summary.n,
      scoreBeforeReliability: scorePrecision(r.summary.scoreBeforeReliability),
      tier: r.tier ?? r.summary.tier,
      ...(r.flags ?? {}),
      meta: lastMeta(r.iterations) ?? r.summary.meta,
      ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
    };
  });

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: spec.configBlock,
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);
}

// ---------------------------------------------------------------------------
// ParticipantRecords -> legacy results bridge
// ---------------------------------------------------------------------------

function isWorkloadResult(spec: SuiteSpec, data: any): data is WorkloadData {
  return (
    data && typeof data === 'object' &&
    data.ok === true && data.suite === spec.id && typeof data.metric?.value === 'number'
  );
}

function isFailureResult(spec: SuiteSpec, data: any): data is WorkloadFailure {
  return data && typeof data === 'object' && data.ok === false && data.suite === spec.id;
}

function isFlatResult(data: any): boolean {
  return (
    data && typeof data === 'object' &&
    (typeof data.wallClockMs === 'number' || typeof data.provider === 'string')
  );
}

function recordToWorkloadResult(spec: SuiteSpec, record: TaskResultRecord): WorkloadResult | undefined {
  const data = record.data;
  const failure = recordFailureMessage(record);
  if (!data || typeof data !== 'object') {
    return failure === undefined ? undefined : { ok: false, suite: spec.id, reason: 'error', error: failure, meta: {} };
  }
  const anyData = data as any;

  if (isWorkloadResult(spec, anyData)) return anyData;
  if (isFailureResult(spec, anyData)) return anyData;
  if (anyData.skipped) return undefined;

  // @benchsdk/runner stores task results as flat metadata objects on
  // record.data. Wrap them in the workload shape the serializer expects.
  if (isFlatResult(anyData)) {
    if (record.status === 'success' && !anyData.error && !anyData.snapshotError) {
      const metricValue = typeof anyData.wallClockMs === 'number' ? anyData.wallClockMs : record.latencyMs ?? 0;
      return {
        ok: true,
        suite: spec.id,
        metric: { value: metricValue, unit: 'ms', higherIsBetter: false },
        meta: anyData,
      };
    }

    const error = anyData.snapshotError || anyData.error || anyData.errorMessage || record.errorCode || 'unknown';
    return {
      ok: false,
      suite: spec.id,
      reason: 'error',
      error: String(error),
      meta: anyData,
    };
  }

  if (failure !== undefined && !anyData.skipped) {
    return { ok: false, suite: spec.id, reason: 'error', error: failure, meta: anyData };
  }

  return undefined;
}

/** Map per-participant task records to legacy SuiteBenchmarkResult[]. */
export function recordsToSuiteResults(
  spec: SuiteSpec,
  participants: ParticipantRecords[],
  scoring?: BenchmarkScoringConfig,
): SuiteBenchmarkResult[] {
  const scores = scoring ? scoreParticipantRecords(participants, scoring) : undefined;
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations: WorkloadResult[] = [];
    const replicateMs: number[] = [];
    let wallClockMs = 0;
    let skipped = false;
    let skipReason: string | undefined;

    for (const record of records) {
      const data = record.data as any;
      if (data && typeof data === 'object') {
        if (data.skipped) {
          skipped = true;
          skipReason = data.skipReason;
          continue;
        }
        if (Array.isArray(data.replicateMs)) {
          replicateMs.push(...(data.replicateMs as number[]));
        }
        if (typeof data.wallClockMs === 'number') {
          wallClockMs += data.wallClockMs;
        }
      }

      const workload = recordToWorkloadResult(spec, record);
      if (workload) iterations.push(workload);
    }

    const summary = computeSuiteStats(spec, iterations);
    const score = scores?.find((row) => row.provider === participant.participant);
    if (score) {
      summary.compositeScore = score.compositeScore;
      summary.successRate = score.successRate;
      summary.scoreBeforeReliability = score.successRate === 0 ? 0 : score.compositeScore / score.successRate;
      summary.tier = score.successRate === 0 ? 'fail' : 'pass';
    }
    const result: SuiteBenchmarkResult = {
      provider: participant.participant,
      suite: spec.id,
      mode: spec.id,
      iterations,
      summary,
      wallClockMs,
      replicateMs,
      compositeScore: summary.compositeScore,
      tier: summary.tier,
      flags: spec.flags?.(iterations),
    };

    if (iterations.length === 0) {
      result.skipped = true;
      if (!result.skipReason) result.skipReason = skipReason ?? 'no records';
    }

    return result;
  });
}

/**
 * Map records -> SuiteBenchmarkResult[] and write both `<YYYY-MM-DD>.json`
 * and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeSuiteLegacyResults(
  spec: SuiteSpec,
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  const results = recordsToSuiteResults(spec, participants, opts.scoring);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeSuiteResultsJson(spec, results, outPath, opts.scoring !== undefined);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractMetric(spec: SuiteSpec, iterations: WorkloadResult[], key: string): number[] {
  const values: number[] = [];
  for (const iteration of iterations) {
    if (!iterationPassed(spec, iteration)) continue;
    const v = iteration.meta?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
    }
  }
  return values;
}

function roundStats(values: number[]): MetricSummary {
  if (values.length === 0) return { median: 0 };
  const { median, p95, p99 } = computeStats(values);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: round(median),
    p95: round(p95),
    p99: round(p99),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    avg: round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

function lastMeta(results: WorkloadResult[]): Record<string, any> | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].meta) return results[i].meta;
  }
  return undefined;
}

function stripOutliersBySigma(sorted: number[], sigma: number): number[] {
  if (sorted.length < 4) return sorted;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return sorted;
  const lo = mean - sigma * sd;
  const hi = mean + sigma * sd;
  const trimmed = sorted.filter((v) => v >= lo && v <= hi);
  return trimmed.length >= 1 ? trimmed : sorted;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
