import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { percentile, computeStats } from '../src/util/stats.js';

// ---------------------------------------------------------------------------
// Suite configuration
// ---------------------------------------------------------------------------

export const SUITE_CONFIG = {
  id: 'filesystem-snapshot' as const,
  label: 'Filesystem — snapshot, downtime, and restore',
  unit: 'ms' as const,
  higherIsBetter: false,
  ceiling: 120000,
  defaultReplicas: 3,
  timeoutMs: 300_000,
  fileCount: 10,
  fileSizeBytes: 100 * 1024, // 100 KiB per file
  downtimeMs: 60_000,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilesystemSnapshotWorkloadMeta {
  snapshotSupported?: boolean;
  snapshotIsBoxIdentity?: boolean;
  snapshotError?: string;
  verifyPassed?: boolean;
  filesVerified?: number;
  verifiedBytes?: number;
  fileCount?: number;
  totalBytes?: number;
  downMs?: number;
  downtimeMs?: number;
  cpuCount?: number;
  memoryMb?: number;
  providerNotes?: string;
}

export interface FilesystemSnapshotWorkloadData {
  ok: true;
  suite: 'filesystem-snapshot';
  metric: { value: number; unit: 'ms'; higherIsBetter: false };
  meta: FilesystemSnapshotWorkloadMeta;
}

export interface FilesystemSnapshotWorkloadFailure {
  ok: false;
  suite: 'filesystem-snapshot';
  reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
  error?: string;
  meta: FilesystemSnapshotWorkloadMeta;
}

export type FilesystemSnapshotWorkloadResult = FilesystemSnapshotWorkloadData | FilesystemSnapshotWorkloadFailure;

export interface FilesystemSnapshotSuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: FilesystemSnapshotWorkloadMeta;
  filesystemSupported: boolean;
  snapshotSupported: boolean;
  featureScore: number;
  tier: string;
}

export interface FilesystemSnapshotBenchmarkResult {
  provider: string;
  suite: 'filesystem-snapshot';
  mode: 'filesystem-snapshot';
  iterations: FilesystemSnapshotWorkloadResult[];
  summary: FilesystemSnapshotSuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  tier?: string;
  filesystemSupported?: boolean;
  snapshotSupported?: boolean;
  skipped?: boolean;
  skipReason?: string;
}

export interface FilesystemSnapshotMetricSummary {
  median: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
}

export interface SerializedFilesystemSnapshotBenchmarkResult {
  provider: string;
  suite: 'filesystem-snapshot';
  mode: 'filesystem-snapshot';
  iterations: FilesystemSnapshotWorkloadResult[];
  summary: {
    createMs: FilesystemSnapshotMetricSummary;
    populateMs: FilesystemSnapshotMetricSummary;
    snapshotCreateMs: FilesystemSnapshotMetricSummary;
    downMs: FilesystemSnapshotMetricSummary;
    snapshotRestoreMs: FilesystemSnapshotMetricSummary;
    verifyMs: FilesystemSnapshotMetricSummary;
    destroyMs: FilesystemSnapshotMetricSummary;
    totalMs: FilesystemSnapshotMetricSummary;
  };
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  meta: FilesystemSnapshotWorkloadMeta;
  tier: string;
  filesystemSupported: boolean;
  snapshotSupported: boolean;
  skipped?: boolean;
  skipReason?: string;
}

export interface FilesystemSnapshotIterationData {
  createMs: number;
  populateMs: number;
  snapshotCreateMs: number;
  downMs: number;
  downtimeMs: number;
  snapshotRestoreMs: number;
  verifyMs: number;
  destroyMs: number;
  snapshotSupported: boolean;
  snapshotIsBoxIdentity?: boolean;
  snapshotError?: string;
  verifyPassed: boolean;
  filesVerified?: number;
  verifiedBytes?: number;
  fileCount: number;
  totalBytes: number;
  wallClockMs: number;
  replicateMs: number[];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single value against the suite's calibration ceiling.
 * Lower is better: 100 * (1 - value/ceiling). Clamped to [0, 100].
 */
export function scoreMetric(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = 1 - value / ceiling;
  return clamp(ratio * 100, 0, 100);
}

const STAGE_METRICS = [
  'createMs',
  'populateMs',
  'snapshotCreateMs',
  'downMs',
  'snapshotRestoreMs',
  'verifyMs',
  'destroyMs',
] as const;

/** Scoring ceilings shared with the .bench.ts scoring config (2x p90 provider median, 2026-11); timeouts stay pass/fail. */
export const FILESYSTEM_SNAPSHOT_CEILINGS_MS: Record<(typeof STAGE_METRICS)[number], number> = {
  createMs: 3_000,
  populateMs: 2_000,
  snapshotCreateMs: 15_000,
  downMs: 15_000,
  snapshotRestoreMs: 5_000,
  verifyMs: 1_500,
  destroyMs: 2_000,
};

// Restore-after-downtime is the headline metric for the persistent-box use
// case, so it carries nearly half the composite weight. downMs is reported
// for observability but not scored.
const STAGE_WEIGHTS: Record<(typeof STAGE_METRICS)[number], number> = {
  createMs: 0.1,
  populateMs: 0.1,
  snapshotCreateMs: 0.15,
  downMs: 0,
  snapshotRestoreMs: 0.45,
  verifyMs: 0.1,
  destroyMs: 0.1,
};

const TOTAL_STAGE_WEIGHT = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);

/**
 * An iteration passes only if the provider supports snapshots and the full
 * lifecycle (create, populate, snapshot, restore, verify, destroy) succeeds.
 * Filesystem-only providers are treated as failing the benchmark.
 */
function iterationPassed(result: FilesystemSnapshotWorkloadResult): boolean {
  const meta = result.meta as FilesystemSnapshotWorkloadMeta;
  return (
    meta.snapshotSupported === true &&
    !meta.snapshotError &&
    meta.verifyPassed === true
  );
}

/**
 * Compute per-provider stats. The benchmark now requires snapshot support to
 * pass. Providers without a successful snapshot lifecycle get compositeScore 0.
 * For passing providers, the composite score is a weighted performance score
 * (0-100, higher is better) built from the median of each stage metric and
 * multiplied by the snapshot success rate.
 */
export function computeFilesystemSnapshotStats(
  results: FilesystemSnapshotWorkloadResult[],
  _ceiling?: number,
): FilesystemSnapshotSuiteStats {
  const snapshotOk: FilesystemSnapshotWorkloadResult[] = [];
  for (const r of results) {
    if (iterationPassed(r)) snapshotOk.push(r);
  }

  const total = results.length;
  const filesystemSupported = results.some((r) => r.ok === true);
  const snapshotSupported = snapshotOk.length > 0;
  const tier = snapshotSupported ? 'pass' : 'fail';

  if (snapshotOk.length === 0) {
    return {
      median: 0, p95: 0, p99: 0, min: 0, max: 0,
      successRate: 0, n: 0, scoreBeforeReliability: 0,
      compositeScore: 0, meta: lastMeta(results) ?? {},
      filesystemSupported, snapshotSupported, featureScore: 0, tier,
    };
  }

  const wallClockValues = snapshotOk
    .map((r) => (r.meta as any)?.wallClockMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);

  const sorted = [...wallClockValues].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const trimmed = stripOutliersBySigma(sorted, 2);
  const statsValues = trimmed.length >= 1 ? trimmed : sorted;

  const p95 = percentile(statsValues, 95);
  const p99 = percentile(statsValues, 99);

  let weightedScore = 0;
  for (const metric of STAGE_METRICS) {
    const values = extractMetric(snapshotOk, metric);
    const metricMedian = values.length > 0 ? computeStats(values).median : 0;
    const weight = STAGE_WEIGHTS[metric] / TOTAL_STAGE_WEIGHT;
    weightedScore += scoreMetric(metricMedian, FILESYSTEM_SNAPSHOT_CEILINGS_MS[metric]) * weight;
  }

  const successRate = snapshotOk.length / total;

  return {
    median, p95, p99,
    min: sorted[0], max: sorted[sorted.length - 1],
    successRate,
    n: snapshotOk.length,
    scoreBeforeReliability: weightedScore,
    compositeScore: weightedScore * successRate,
    meta: lastMeta(snapshotOk) ?? lastMeta(results) ?? {},
    filesystemSupported, snapshotSupported, featureScore: 1, tier,
  };
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

export async function writeFilesystemSnapshotResultsJson(
  results: FilesystemSnapshotBenchmarkResult[],
  outPath: string,
  preserveScorePrecision = false,
): Promise<void> {
  const scorePrecision = preserveScorePrecision ? (value: number) => value : round;
  const cleanResults: SerializedFilesystemSnapshotBenchmarkResult[] = results.map((r) => ({
    provider: r.provider,
    suite: r.suite,
    mode: r.mode,
    iterations: r.iterations.map((i) => {
      if (i.ok) {
        return {
          ok: true,
          suite: i.suite,
          metric: { value: round(i.metric.value), unit: i.metric.unit, higherIsBetter: i.metric.higherIsBetter },
          meta: i.meta,
        };
      }
      return {
        ok: false,
        suite: i.suite,
        reason: i.reason,
        ...(i.error ? { error: i.error } : {}),
        meta: i.meta,
      };
    }),
    summary: {
      createMs: roundStats(extractMetric(r.iterations, 'createMs')),
      populateMs: roundStats(extractMetric(r.iterations, 'populateMs')),
      snapshotCreateMs: roundStats(extractMetric(r.iterations, 'snapshotCreateMs')),
      downMs: roundStats(extractMetric(r.iterations, 'downMs')),
      snapshotRestoreMs: roundStats(extractMetric(r.iterations, 'snapshotRestoreMs')),
      verifyMs: roundStats(extractMetric(r.iterations, 'verifyMs')),
      destroyMs: roundStats(extractMetric(r.iterations, 'destroyMs')),
      totalMs: {
        median: round(r.summary.median),
        p95: round(r.summary.p95),
        p99: round(r.summary.p99),
        min: round(r.summary.min),
        max: round(r.summary.max),
      },
    },
    wallClockMs: round(r.wallClockMs),
    replicateMs: r.replicateMs.map(round),
    compositeScore: scorePrecision(r.compositeScore),
    successRate: scorePrecision(r.summary.successRate),
    n: r.summary.n,
    scoreBeforeReliability: scorePrecision(r.summary.scoreBeforeReliability),
    tier: r.tier ?? r.summary.tier,
    filesystemSupported: r.filesystemSupported ?? r.summary.filesystemSupported,
    snapshotSupported: r.snapshotSupported ?? r.summary.snapshotSupported,
    meta: lastMeta(r.iterations) ?? r.summary.meta,
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: {
      mode: 'filesystem-snapshot',
      ceiling: SUITE_CONFIG.ceiling,
      unit: SUITE_CONFIG.unit,
      timeoutMs: SUITE_CONFIG.timeoutMs,
      fileCount: SUITE_CONFIG.fileCount,
      fileSizeBytes: SUITE_CONFIG.fileSizeBytes,
      downtimeMs: SUITE_CONFIG.downtimeMs,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractMetric(iterations: FilesystemSnapshotWorkloadResult[], key: keyof FilesystemSnapshotIterationData): number[] {
  const values: number[] = [];
  for (const iteration of iterations) {
    if (!iterationPassed(iteration)) continue;
    const anyMeta = iteration.meta as any;
    const v = anyMeta?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
    }
  }
  return values;
}

function roundStats(values: number[]): FilesystemSnapshotMetricSummary {
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

function lastMeta(results: FilesystemSnapshotWorkloadResult[]): FilesystemSnapshotWorkloadMeta | undefined {
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

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
