import fs from 'node:fs';
import { FS_IO_SCORING, iterationRecord, runtimeRecordScore } from './performance-runtime-scoring.js';
import path from 'node:path';
import { percentile } from '../src/util/stats.js';
import { withTimeout } from '../src/util/timeout.js';

// ---------------------------------------------------------------------------
// Suite configuration
// ---------------------------------------------------------------------------

export const SUITE_CONFIG = {
  id: 'fs-io' as const,
  label: 'Filesystem I/O — SQLite operation suite',
  unit: 'ms' as const,
  higherIsBetter: false,
  /** Scoring ceiling for a single mode's totalMs, shared with the .bench.ts scoring config (2x p90 provider median, 2026-11). */
  ceiling: 8_000,
  defaultReplicas: 3,
  workloadPath: 'fs-io-workload.js',
  /** Wall-clock limit for the whole in-sandbox suite; large mode needs headroom. */
  timeoutMs: 600_000,
};

const BENCH_SCRIPT_PATH = path.resolve(import.meta.dirname, '../scripts/fs-io-workload.js');
const BENCH_STDOUT_PATH = path.resolve(import.meta.dirname, '../scripts/fs-io-stdout.js');

export const MODES = ['default', 'fsync', 'large'] as const;
export type FsIoMode = (typeof MODES)[number];

/**
 * The per-operation keys the workload emits, in display order. Step keys use
 * the kebab-case form; metric keys are the camelCase `<op>Ms` fields.
 */
export const OPS: { stepKey: string; metricKey: string; label: string }[] = [
  { stepKey: 'seq-inserts', metricKey: 'sequentialInsertsMs', label: 'Sequential inserts' },
  { stepKey: 'batch-inserts', metricKey: 'batchInsertsMs', label: 'Batch inserts' },
  { stepKey: 'select-count', metricKey: 'selectCountMs', label: 'SELECT COUNT(*)' },
  { stepKey: 'range-queries', metricKey: 'rangeQueriesMs', label: 'Range queries' },
  { stepKey: 'like-queries', metricKey: 'likeQueriesMs', label: 'LIKE queries' },
  { stepKey: 'updates', metricKey: 'updatesMs', label: 'Updates' },
  { stepKey: 'deletes', metricKey: 'deletesMs', label: 'Deletes' },
  { stepKey: 'tx-inserts', metricKey: 'transactionInsertsMs', label: 'Transaction inserts' },
  { stepKey: 'aggregates', metricKey: 'aggregatesMs', label: 'Aggregates' },
  { stepKey: 'join-query', metricKey: 'joinQueryMs', label: 'Join query' },
  { stepKey: 'concurrent-reads', metricKey: 'concurrentReadsMs', label: 'Concurrent reads' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FsIoWorkloadMeta {
  mode?: FsIoMode;
  modeLabel?: string;
  nodeVersion?: string;
  sqliteVersion?: string;
  arch?: string;
  platform?: string;
  kernel?: string;
  cpuCount?: number;
  memoryMb?: number;
  concurrentReadsFailures?: number;
  concurrentReadsError?: string;
  providerNotes?: string;
  [key: string]: unknown;
}

export interface FsIoWorkloadData {
  ok: true;
  suite: 'fs-io';
  metric: { value: number; unit: 'ms'; higherIsBetter: false };
  meta: FsIoWorkloadMeta;
}

export interface FsIoWorkloadFailure {
  ok: false;
  suite: 'fs-io';
  reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
  error?: string;
  meta: FsIoWorkloadMeta;
}

export type FsIoWorkloadResult = FsIoWorkloadData | FsIoWorkloadFailure;

export interface FsIoMetricSummary {
  median: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
}

export interface FsIoSuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: FsIoWorkloadMeta;
}

export interface FsIoBenchmarkResult {
  provider: string;
  suite: 'fs-io';
  mode: FsIoMode;
  iterations: FsIoWorkloadResult[];
  summary: FsIoSuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  meta?: FsIoWorkloadMeta;
  skipped?: boolean;
  skipReason?: string;
}

export interface SerializedFsIoBenchmarkResult {
  provider: string;
  suite: 'fs-io';
  mode: FsIoMode;
  iterations: FsIoWorkloadResult[];
  summary: Record<string, unknown> & { successRate: number; n: number };
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  meta: FsIoWorkloadMeta;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Same reciprocal reference as the active lower-is-better metric. */
export function scoreMetric(value: number, suite: typeof SUITE_CONFIG = SUITE_CONFIG): number {
  return Number.isFinite(value) && value >= 0 ? 100 / (1 + value / suite.ceiling) : 0;
}

export function computeFsIoStats(
  results: FsIoWorkloadResult[],
  suite: typeof SUITE_CONFIG = SUITE_CONFIG,
): FsIoSuiteStats {
  const successful = results.filter((r) => r.ok === true);
  const ok = successful.length;
  const total = results.length;

  if (ok === 0) {
    return {
      median: 0, p95: 0, p99: 0, min: 0, max: 0,
      successRate: 0, n: 0, scoreBeforeReliability: 0,
      compositeScore: 0, meta: {},
    };
  }

  const values = successful.map((r) => r.metric.value);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    : sorted[Math.floor(sorted.length / 2)]!;

  const trimmed = stripOutliersBySigma(sorted, 2);
  const statsValues = trimmed.length >= 1 ? trimmed : sorted;

  const scored = runtimeRecordScore(results.map(r => iterationRecord(r, {
    ...r.meta,
    ...(r.ok ? { totalMs: r.metric.value } : {}),
  })), FS_IO_SCORING);
  const successRate = scored?.successRate ?? 0;
  const compositeScore = scored?.compositeScore ?? 0;

  return {
    median, p95: percentile(statsValues, 95), p99: percentile(statsValues, 99),
    min: sorted[0]!, max: sorted[sorted.length - 1]!,
    successRate, n: ok,
    scoreBeforeReliability: successRate > 0 ? compositeScore / successRate : 0,
    compositeScore,
    meta: lastMeta(successful) ?? {},
  };
}

/** Per-op median summaries for the legacy result file's summary block. */
export function summarizeOps(results: FsIoWorkloadResult[]): Record<string, FsIoMetricSummary> {
  const successful = results.filter((r): r is FsIoWorkloadData => r.ok === true);
  const out: Record<string, FsIoMetricSummary> = {};
  const keys = [...OPS.map((o) => o.metricKey), 'totalMs', 'concurrentReadsQps', 'dbSizeMb'];
  for (const key of keys) {
    const values = successful
      .map((r) => r.meta[key])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
      : sorted[Math.floor(sorted.length / 2)]!;
    out[key] = {
      median: round(median),
      p95: round(percentile(sorted, 95)),
      min: round(sorted[0]!),
      max: round(sorted[sorted.length - 1]!),
      avg: round(values.reduce((a, v) => a + v, 0) / values.length),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stdout parsing — last WorkloadResult JSON line wins
// ---------------------------------------------------------------------------

export function parseWorkloadResult(stdout: string): FsIoWorkloadResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as FsIoWorkloadResult;
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.suite !== SUITE_CONFIG.id) continue;
      return parsed;
    } catch {
      continue;
    }
  }
  return {
    ok: false,
    suite: SUITE_CONFIG.id,
    reason: 'unexpected',
    error: 'no parseable WorkloadResult JSON line found in stdout',
    meta: {},
  };
}

// ---------------------------------------------------------------------------
// In-sandbox runner — heredoc upload + single `node` invocation
// ---------------------------------------------------------------------------

interface FsIoSandbox {
  runCommand(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  filesystem?: {
    mkdir?(path: string): Promise<unknown>;
    writeFile?(path: string, content: string): Promise<unknown>;
  };
}

interface Payload {
  ok: true;
  scriptName: string;
  scriptContent: string;
  stdoutContent: string;
}

interface PayloadErr {
  ok: false;
  error: string;
}

function buildPayload(): Payload | PayloadErr {
  if (!fs.existsSync(BENCH_SCRIPT_PATH)) {
    return { ok: false, error: 'Workload script missing on disk: ' + BENCH_SCRIPT_PATH };
  }
  if (!fs.existsSync(BENCH_STDOUT_PATH)) {
    return { ok: false, error: 'Stdout helper missing on disk: ' + BENCH_STDOUT_PATH };
  }
  return {
    ok: true,
    scriptName: SUITE_CONFIG.workloadPath,
    scriptContent: fs.readFileSync(BENCH_SCRIPT_PATH, 'utf8'),
    stdoutContent: fs.readFileSync(BENCH_STDOUT_PATH, 'utf8'),
  };
}

function randomMarker(prefix: string): string {
  return '__BENCH_' + prefix + '_' + Math.random().toString(36).slice(2, 10) + '__';
}

/**
 * Land both payload files under /tmp/bench and return the command that runs
 * the suite. `filesystem.writeFile` first (no command-size limit); heredoc
 * runCommand when the provider has no fs API or the write fails.
 */
async function buildUploadCommand(
  sandbox: FsIoSandbox,
  payload: Payload,
  mode: FsIoMode,
): Promise<string> {
  const fsApi = sandbox.filesystem;
  if (fsApi && typeof fsApi.writeFile === 'function') {
    try {
      if (typeof fsApi.mkdir === 'function') await fsApi.mkdir('/tmp/bench');
      await fsApi.writeFile('/tmp/bench/stdout.js', payload.stdoutContent);
      await fsApi.writeFile(`/tmp/bench/${payload.scriptName}`, payload.scriptContent);
      return `BENCH_SUITE=${SUITE_CONFIG.id} BENCH_MODE=${mode} node /tmp/bench/${payload.scriptName}`;
    } catch { /* fall back to the heredoc upload */ }
  }
  return buildSingleCommand(payload, mode);
}

function buildSingleCommand(payload: Payload, mode: FsIoMode): string {
  const lines: string[] = [];
  lines.push('set -e');
  lines.push('mkdir -p /tmp/bench');

  const m1 = randomMarker('STDOUT');
  lines.push('cat > /tmp/bench/stdout.js <<\'' + m1 + '\'');
  lines.push(payload.stdoutContent);
  lines.push(m1);

  const m2 = randomMarker('WORKLOAD');
  lines.push('cat > /tmp/bench/' + payload.scriptName + ' <<\'' + m2 + '\'');
  lines.push(payload.scriptContent);
  lines.push(m2);

  lines.push(`BENCH_SUITE=${SUITE_CONFIG.id} BENCH_MODE=${mode} node /tmp/bench/${payload.scriptName}`);

  return lines.join('\n');
}

/**
 * Upload the stdout helper + workload script into the sandbox and execute
 * the suite for one mode. The fs API is the preferred upload path — several
 * providers cap exec command size (buddy rejects runCommand > 16,384 bytes),
 * which the single-heredoc payload exceeds. Where the fs API is absent the
 * heredoc stays the fallback. Returns the parsed WorkloadResult — never
 * throws for workload-side failures (they arrive as ok:false results);
 * throws only on transport-level errors.
 */
export async function runFsIoWorkload(
  sandbox: FsIoSandbox,
  mode: FsIoMode,
  opts: { timeout?: number } = {},
): Promise<FsIoWorkloadResult> {
  const timeout = opts.timeout ?? SUITE_CONFIG.timeoutMs;

  const payload = buildPayload();
  if (!payload.ok) {
    return { ok: false, suite: SUITE_CONFIG.id, reason: 'error', error: payload.error, meta: { mode } };
  }

  const shellCmd = await buildUploadCommand(sandbox, payload, mode);

  try {
    const result = await withTimeout(
      sandbox.runCommand(shellCmd, { timeout }),
      timeout,
      `${SUITE_CONFIG.id} workload timed out`,
    );

    if (result.exitCode !== 0) {
      const errTail = (result.stderr || '').slice(-500);
      return {
        ok: false,
        suite: SUITE_CONFIG.id,
        reason: 'error',
        error: 'non-zero exit: ' + (errTail || 'no stderr'),
        meta: { mode },
      };
    }

    const parsed = parseWorkloadResult(result.stdout || '');
    if (!parsed.ok && parsed.reason === 'unexpected') {
      const stderrTail = (result.stderr || '').slice(-200);
      parsed.error = stderrTail
        ? parsed.error + '; stderr: ' + stderrTail
        : parsed.error + '; stdout was empty (exitCode=0) — provider may not wait for command completion';
      parsed.meta = { ...parsed.meta, mode };
    }
    if (parsed.ok && !parsed.meta.mode) parsed.meta = { ...parsed.meta, mode };
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = /timed out/i.test(message);
    return {
      ok: false,
      suite: SUITE_CONFIG.id,
      reason: isTimeout ? 'timeout' : 'error',
      error: message,
      meta: { mode },
    };
  }
}

// ---------------------------------------------------------------------------
// Result writer — legacy JSON shape shared across the fs-* benchmark family
// ---------------------------------------------------------------------------

export async function writeFsIoResultsJson(
  results: FsIoBenchmarkResult[],
  outPath: string,
  mode: FsIoMode | 'combined',
): Promise<void> {
  const cleanResults: SerializedFsIoBenchmarkResult[] = results.map((r) => ({
    provider: r.provider,
    suite: r.suite,
    mode: r.mode,
    iterations: r.iterations,
    summary: {
      ...summarizeOps(r.iterations),
      totalMs: {
        median: round(r.summary.median),
        p95: round(r.summary.p95),
        p99: round(r.summary.p99),
        min: round(r.summary.min),
        max: round(r.summary.max),
      },
      successRate: r.summary.successRate,
      n: r.summary.n,
    },
    wallClockMs: round(r.wallClockMs),
    replicateMs: r.replicateMs.map(round),
    compositeScore: r.compositeScore,
    successRate: r.summary.successRate,
    n: r.summary.n,
    scoreBeforeReliability: r.summary.scoreBeforeReliability,
    meta: r.summary.meta,
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    suite: SUITE_CONFIG.id,
    mode,
    config: {
      unit: SUITE_CONFIG.unit,
      higherIsBetter: SUITE_CONFIG.higherIsBetter,
      ceiling: SUITE_CONFIG.ceiling,
      timeoutMs: SUITE_CONFIG.timeoutMs,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    results: cleanResults,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function lastMeta(results: FsIoWorkloadResult[]): FsIoWorkloadMeta | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    const meta = results[i]!.meta;
    if (meta && Object.keys(meta).length > 0) return meta;
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
