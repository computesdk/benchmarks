import fs from 'node:fs';
import { FS_API_SCORING, iterationRecord, runtimeRecordScore } from './performance-runtime-scoring.js';
import os from 'node:os';
import path from 'node:path';
import { percentile, computeStats } from '../src/util/stats.js';

// ---------------------------------------------------------------------------
// Suite configuration
// ---------------------------------------------------------------------------

/**
 * The file-size sweep. One shared sandbox runs `iterations` tasks, each a
 * write/read/verify/delete test at every size in order — a failing size
 * ends that task's sweep as a partial result (the "where it breaks"
 * signal). `targetMs` is the write+read+delete round-trip that scores 100
 * for that size — per-size targets reflect that small files are
 * per-call-latency bound while large files are transfer bound.
 */
export interface SweepSize {
  label: string;
  bytes: number;
  targetMs: number;
}

export const SIZE_SWEEP: SweepSize[] = [
  { label: '40k', bytes: 40 * 1024, targetMs: 20 },
  { label: '1m', bytes: 1024 * 1024, targetMs: 67 },
  { label: '16m', bytes: 16 * 1024 * 1024, targetMs: 533 },
  { label: '64m', bytes: 64 * 1024 * 1024, targetMs: 2133 },
  { label: '128m', bytes: 128 * 1024 * 1024, targetMs: 4266 },
];

export const SUITE_CONFIG = {
  id: 'sandbox-fs-api' as const,
  label: 'Sandbox Filesystem API Throughput — file-size write/read sweep',
  unit: 'ms' as const,
  higherIsBetter: false,
  ceiling: 120000,
  defaultReplicas: 3,
  timeoutMs: 300_000,
  sizeSweepBytes: SIZE_SWEEP.map((s) => s.bytes),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxFilesystemWorkloadMeta {
  /** Size group this record belongs to (per-size view records, e.g. '40k'). */
  file_size?: string;
  fileSizeBytes?: number;
  /** Tasks run inside the shared sandbox in this run (the --iterations value). */
  iterations?: number;
  /** Tests this record's size actually completed (per-size view records). */
  repsCompleted?: number;
  writeMs?: number;
  readMs?: number;
  /** Timed fs.remove() of the verified file. */
  deleteMs?: number;
  /** Write+read+delete round-trip ms — the scored workload number. */
  rtMs?: number;
  /** Total sweep wall time across all sizes (flat records). */
  sweepMs?: number;
  /** Read-back content hash matched the written bytes. */
  verified?: boolean;
  /** min(100, targetMs / rtMs * 100) for the record's size — 0 on mismatch. */
  sizeScore?: number;
  /** Sizes this task completed, out of the configured sweep (flat records). */
  completedSizes?: number;
  /** Every configured size completed (flat records). */
  sweepComplete?: boolean;
  /** completedSizes / total sizes x 100 — the displayed completion axis. */
  sweepCompletion?: number;
  /** Mean size score over only the sizes this task completed. */
  speedScore?: number;
  /** Sum of per-size write+read+delete round-trips across completed sizes. */
  sweepRtMs?: number;
  /** min(100, summed targetMs / sweepRtMs * 100) — the scored speed axis. */
  sweepScore?: number;
  /** Ranked score: completion tier (0-80) or 100 + sweepScore once every
   * configured size has been completed at least once. */
  rankScore?: number;
  /** Review-only continuous rank; v1 composite ignores it. */
  performanceRankScoreV2?: number;
  /** Fixed sum of the configured size targets, retained for reproduction. */
  sweepTargetMs?: number;
  /** Stage that failed, when ok=false: create | probe | write | read | destroy. */
  failedStage?: string;
  provider?: string;
  baseDir?: string;
  createMs?: number;
  probeMs?: number;
  /** Largest size that passed write+read+verify (provider summary only). */
  maxFileBytes?: number;
  /** First size with no passing record, when the sweep broke (summary only). */
  breakAtBytes?: number;
  /** ok | io_failed | verify_mismatch | no_size_completed (summary only). */
  breakReason?: string;
  /** Async provider-SDK errors captured by the process-level guard. */
  sdkAsyncError?: string;
  sdkAsyncErrorCount?: number;
  destroyMs?: number;
  destroyFailed?: boolean;
  destroyError?: string;
  wallClockMs?: number;
  errorMessage?: string;
  providerNotes?: string;
  [key: string]: number | string | boolean | undefined;
}

export interface SandboxFilesystemWorkloadData {
  ok: true;
  suite: 'sandbox-fs-api';
  metric: { value: number; unit: 'ms'; higherIsBetter: false };
  meta: SandboxFilesystemWorkloadMeta;
}

export interface SandboxFilesystemWorkloadFailure {
  ok: false;
  suite: 'sandbox-fs-api';
  reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
  error?: string;
  meta: SandboxFilesystemWorkloadMeta;
}

export type SandboxFilesystemWorkloadResult = SandboxFilesystemWorkloadData | SandboxFilesystemWorkloadFailure;

export interface SandboxFilesystemMetricSummary {
  median: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
}

export interface SandboxFilesystemSuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: SandboxFilesystemWorkloadMeta;
}

export interface SandboxFilesystemBenchmarkResult {
  provider: string;
  suite: 'sandbox-fs-api';
  mode: 'sandbox-fs-api';
  iterations: SandboxFilesystemWorkloadResult[];
  summary: SandboxFilesystemSuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface SerializedSandboxFilesystemBenchmarkResult {
  provider: string;
  suite: 'sandbox-fs-api';
  mode: 'sandbox-fs-api';
  iterations: SandboxFilesystemWorkloadResult[];
  summary: Record<string, SandboxFilesystemMetricSummary>;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  meta: SandboxFilesystemWorkloadMeta;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The composite scores only the filesystem workload — what a developer
 * actually pays for when their code touches /tmp. Sandbox create and destroy
 * are timed and reported but carry no weight: they fail or pass a record,
 * they don't shape its score. Boot latency is measured by other benchmarks.
 */

/** Score one size's write+read round-trip ms against its target, 0-100. */
export function scoreRoundTripMs(sizeLabel: string, rtMs: number): number {
  const size = SIZE_SWEEP.find((s) => s.label === sizeLabel);
  if (!size || !Number.isFinite(rtMs) || rtMs < 0) return 0;
  return rtMs === 0 ? 100 : clamp((size.targetMs / rtMs) * 100, 0, 100);
}

/** Metrics written to the legacy JSON summary — the scored workload only. */
const SUMMARY_METRICS = SIZE_SWEEP.flatMap(({ label }) => [
  `size${label}WriteMs`,
  `size${label}ReadMs`,
  `size${label}DeleteMs`,
  `size${label}Ms`,
] as const);

function iterationPassed(result: SandboxFilesystemWorkloadResult): boolean {
  if (!result.ok) return false;
  const meta = result.meta as SandboxFilesystemWorkloadMeta;
  return meta.taskStatus !== 'error' && meta.verified === true && meta.destroyFailed !== true;
}

function recordSizeLabel(result: SandboxFilesystemWorkloadResult): string | undefined {
  const label = (result.meta as SandboxFilesystemWorkloadMeta)?.file_size;
  return typeof label === 'string' ? label : undefined;
}

/**
 * Compute per-provider filesystem stats over per-size records. Each record is
 * one size's write+read+verify in one sandbox. Records group by `file_size`:
 * a group's score is the mean `sizeScore` of its passing records times its
 * own success rate, and the provider composite is the mean across size
 * groups — equal weight per size, so a provider that breaks early forfeits
 * the sizes it never completed. Failing providers get compositeScore 0.
 */
export function computeSandboxFilesystemStats(
  results: SandboxFilesystemWorkloadResult[],
): SandboxFilesystemSuiteStats {
  const ok: SandboxFilesystemWorkloadResult[] = [];
  for (const r of results) {
    if (iterationPassed(r)) ok.push(r);
  }

  const total = results.length;

  if (ok.length === 0) {
    return {
      median: 0, p95: 0, p99: 0, min: 0, max: 0,
      successRate: 0, n: 0, scoreBeforeReliability: 0,
      compositeScore: 0, meta: deriveMeta(results, ok),
    };
  }

  const wallClockValues = ok
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

  // Export and matrix composites use the same active metric and raw sample
  // population as the runner, not a separate average of per-size caps.
  const scored = runtimeRecordScore(results.map(r => iterationRecord(r, { ...r.meta })), FS_API_SCORING);
  const successRate = scored?.successRate ?? 0;
  const compositeScore = scored?.compositeScore ?? 0;
  const scoreBeforeReliability = successRate > 0 ? compositeScore / successRate : 0;

  return {
    median, p95, p99,
    min: sorted[0], max: sorted[sorted.length - 1],
    successRate,
    n: ok.length,
    scoreBeforeReliability,
    compositeScore,
    meta: deriveMeta(results, ok),
  };
}

/**
 * Provider-level break info for the summary: the largest size with a passing
 * record, the first size (in sweep order) with none, and why — plus the last
 * failing record's error detail for the notes column.
 */
function deriveMeta(
  results: SandboxFilesystemWorkloadResult[],
  ok: SandboxFilesystemWorkloadResult[],
): SandboxFilesystemWorkloadMeta {
  const passedLabels = new Set(ok.map(recordSizeLabel).filter((l): l is string => !!l));
  const attemptedLabels = new Set(results.map(recordSizeLabel).filter((l): l is string => !!l));

  const meta: SandboxFilesystemWorkloadMeta = {};
  let maxFileBytes = 0;
  for (const size of SIZE_SWEEP) {
    if (passedLabels.has(size.label)) maxFileBytes = Math.max(maxFileBytes, size.bytes);
  }
  meta.maxFileBytes = maxFileBytes;

  // First sweep size that was attempted but never passed.
  const firstFailed = SIZE_SWEEP.find((s) => attemptedLabels.has(s.label) && !passedLabels.has(s.label));
  if (!firstFailed) {
    meta.breakReason = 'ok';
  } else if (maxFileBytes === 0) {
    meta.breakReason = 'no_size_completed';
    meta.breakAtBytes = firstFailed.bytes;
  } else {
    meta.breakAtBytes = firstFailed.bytes;
    const groupFailures = results.filter((r) => !iterationPassed(r) && recordSizeLabel(r) === firstFailed.label);
    const sawMismatch = groupFailures.some((r) => {
      const m = r.meta as SandboxFilesystemWorkloadMeta;
      return m?.verified === false || /mismatch|verify/i.test(String(m?.errorMessage ?? (r as any).error ?? ''));
    });
    meta.breakReason = sawMismatch ? 'verify_mismatch' : 'io_failed';
  }

  // Carry the last failing record's diagnostics into the summary notes.
  const lastFailure = [...results].reverse().find((r) => !iterationPassed(r));
  if (lastFailure) {
    const m = lastFailure.meta as SandboxFilesystemWorkloadMeta;
    if (m?.failedStage) meta.failedStage = m.failedStage;
    if (m?.errorMessage) meta.errorMessage = m.errorMessage;
    if (m?.sdkAsyncError) meta.sdkAsyncError = m.sdkAsyncError;
    if (m?.destroyFailed) meta.destroyFailed = true;
    if (m?.verified === false) meta.verified = false;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

export async function writeSandboxFilesystemResultsJson(
  results: SandboxFilesystemBenchmarkResult[],
  outPath: string,
): Promise<void> {
  const cleanResults: SerializedSandboxFilesystemBenchmarkResult[] = results.map((r) => ({
    provider: r.provider,
    suite: r.suite,
    mode: r.mode,
    iterations: r.iterations.map((i) => {
      if (i.ok) {
        return {
          ok: true,
          suite: i.suite,
          metric: { value: i.metric.value, unit: i.metric.unit, higherIsBetter: i.metric.higherIsBetter },
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
    summary: Object.fromEntries(
      SUMMARY_METRICS.map((m) => [m, roundStats(extractMetric(r.iterations, m))]),
    ),
    wallClockMs: round(r.wallClockMs),
    replicateMs: r.replicateMs.map(round),
    compositeScore: r.compositeScore,
    successRate: r.summary.successRate,
    n: r.summary.n,
    scoreBeforeReliability: r.summary.scoreBeforeReliability,
    meta: r.summary.meta ?? lastMeta(r.iterations) ?? {},
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: {
      mode: 'sandbox-fs-api',
      ceiling: SUITE_CONFIG.ceiling,
      unit: SUITE_CONFIG.unit,
      timeoutMs: SUITE_CONFIG.timeoutMs,
      sizeSweepBytes: SUITE_CONFIG.sizeSweepBytes,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractMetric(iterations: SandboxFilesystemWorkloadResult[], key: string): number[] {
  // size<label>{Write,Read,}Ms keys resolve to the record fields for that
  // size group: writeMs/readMs/rtMs of records whose file_size matches.
  const match = /^size([a-z0-9]+?)(Write|Read|)Ms$/.exec(key);
  const sizeLabel = match?.[1];
  const field = match?.[2] === 'Write' ? 'writeMs' : match?.[2] === 'Read' ? 'readMs' : 'rtMs';
  const values: number[] = [];
  for (const iteration of iterations) {
    if (!iterationPassed(iteration)) continue;
    const meta = iteration.meta as SandboxFilesystemWorkloadMeta;
    if (sizeLabel && meta?.file_size !== sizeLabel) continue;
    const v = meta?.[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
    }
  }
  return values;
}

function roundStats(values: number[]): SandboxFilesystemMetricSummary {
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

export function lastMeta(results: SandboxFilesystemWorkloadResult[]): SandboxFilesystemWorkloadMeta | undefined {
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
