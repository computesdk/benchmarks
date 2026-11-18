import fs from 'node:fs';
import { CPU_BURST_SCORING, iterationRecord, runtimeRecordScore } from './performance-runtime-scoring.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from '../src/util/stats.js';
import { withTimeout } from '../src/util/timeout.js';

// ---------------------------------------------------------------------------
// Suite configuration
// ---------------------------------------------------------------------------

const SUITE_CONFIG = {
  id: 'cpu-burst' as const,
  label: 'CPU burst',
  unit: 'x' as const,
  higherIsBetter: true,
  ceiling: 8,
  defaultReplicas: 5,
  workloadPath: 'cpu-burst-workload.js',
  timeoutMs: 300_000,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_SCRIPT_PATH = path.resolve(__dirname, '../scripts/cpu-burst-workload.js');
const BENCH_STDOUT_PATH = path.resolve(__dirname, '../scripts/cpu-burst-stdout.js');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CpuBurstWorkloadMeta {
  taskStatus?: string;
  provisionedCpu?: number;
  provisionedMemoryMb?: number;
  resourceProfile?: string;
  resourceStatus?: string;
  resourceNote?: string;
  numWorkers?: number;
  burstDetected?: boolean;
  baselineMs?: number | null;
  burstMs?: number | null;
  baselineOpsPerSec?: number | null;
  burstOpsPerSec?: number | null;
  effectiveCores?: number | null;
  burstHeadroom?: number | null;
  peakRssMb?: number;
  oomKilled?: boolean;
  providerNotes?: string;
}

export type CpuBurstWorkloadResult =
  | {
      ok: true;
      suite: 'cpu-burst';
      metric: { value: number; unit: 'x'; higherIsBetter: true };
      meta: CpuBurstWorkloadMeta;
      notes?: string;
    }
  | {
      ok: false;
      suite: 'cpu-burst';
      reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
      error?: string;
      meta: CpuBurstWorkloadMeta;
    };

export interface CpuBurstSuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: CpuBurstWorkloadMeta;
}

export interface CpuBurstBenchmarkResult {
  provider: string;
  suite: 'cpu-burst';
  mode: 'cpu-burst';
  iterations: CpuBurstWorkloadResult[];
  summary: CpuBurstSuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  /** Top-level meta mirrors summary.meta after JSON round-trips. */
  meta?: CpuBurstWorkloadMeta;
  skipped?: boolean;
  skipReason?: string;
}

export interface MetricSummary {
  median: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
}

export interface SerializedCpuBurstBenchmarkResult {
  provider: string;
  suite: 'cpu-burst';
  mode: 'cpu-burst';
  iterations: CpuBurstWorkloadResult[];
  summary: { burstHeadroom: MetricSummary };
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  meta: CpuBurstWorkloadMeta;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Same continuous unit score used by task evidence and exports. */
export function scoreMetric(value: number, suite: typeof SUITE_CONFIG): number {
  return cpuBurstScore(value, suite);
}

/**
 * Two-part composite score for one headroom measurement.
 *
 * - Delivery (60%): how much of the provisioned CPU the provider actually
 *   delivered — `min(headroom, 1)`. A provider granting exactly the
 *   provisioned allocation earns the full delivery share instead of 0.
 * - Bonus (40%): the extra burst beyond 1x, scaled to the suite ceiling.
 */
export const CPU_BURST_DELIVERY_WEIGHT = 0.6;
export const CPU_BURST_BONUS_WEIGHT = 0.4;

export function cpuBurstScore(headroom: number, suite: typeof SUITE_CONFIG): number {
  if (!Number.isFinite(headroom) || headroom <= 0) return 0;
  const delivery = Math.min(headroom, 1);
  const excess = Math.max(0, headroom - 1);
  const bonus = excess / (excess + suite.ceiling - 1);
  return clamp(
    100 * (CPU_BURST_DELIVERY_WEIGHT * delivery + CPU_BURST_BONUS_WEIGHT * bonus),
    0,
    100,
  );
}

/**
 * Compute median/min/max/p95/p99/score for a single provider cell.
 * 2-sigma outlier trim. If trim leaves < 1 sample, keep the raw median.
 */
export function computeStats(results: CpuBurstWorkloadResult[], suite: typeof SUITE_CONFIG): CpuBurstSuiteStats {
  const successful = results.filter(r => r.ok === true);
  const ok = successful.length;
  const total = results.length;

  if (ok === 0) {
    return {
      median: 0, p95: 0, p99: 0, min: 0, max: 0,
      successRate: 0, n: 0, scoreBeforeReliability: 0,
      compositeScore: 0, meta: {},
    };
  }

  const values = successful.map(r => r.metric.value);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const trimmed = stripOutliersBySigma(sorted, 2);
  const statsValues = trimmed.length >= 1 ? trimmed : sorted;

  const p95 = percentile(statsValues, 95);
  const p99 = percentile(statsValues, 99);

  const scored = runtimeRecordScore(results.map(r => iterationRecord(r, {
    ...r.meta,
    ...(r.ok ? { cpuBurstScore: cpuBurstScore(r.metric.value, suite) } : {}),
  })), CPU_BURST_SCORING);
  const successRate = scored?.successRate ?? 0;
  const compositeScore = scored?.compositeScore ?? 0;

  return {
    median, p95, p99,
    min: sorted[0], max: sorted[sorted.length - 1],
    successRate, n: ok,
    scoreBeforeReliability: successRate > 0 ? compositeScore / successRate : 0,
    compositeScore,
    meta: lastMeta(successful) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Stdout parsing
// ---------------------------------------------------------------------------

/**
 * Read the last JSON line of stdout. Returns a gap WorkloadResult if
 * no line parses — never throws.
 */
export function parseWorkloadResult(stdout: string): CpuBurstWorkloadResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as CpuBurstWorkloadResult;
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.suite !== 'string' || parsed.suite !== 'cpu-burst') continue;
      return parsed;
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    suite: 'cpu-burst',
    reason: 'unexpected',
    error: 'no parseable WorkloadResult JSON line found in stdout',
    meta: {},
  };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

/**
 * Run the cpu-burst benchmark for one provider at the given replicate count.
 *
 * Each replicate:
 *   - creates a fresh sandbox via ComputeSDK
 *   - uploads the workload script + stdout helper via heredoc and executes
 *     node in a SINGLE runCommand call
 *   - parses the last WorkloadResult JSON line from stdout
 *   - destroys the sandbox unconditionally
 */
export interface RunCpuBurstWorkloadOptions {
  providerName: string;
  timeout?: number;
  provisionedCpu?: number;
  provisionedMemoryMb?: number;
}

/**
 * Run one iteration of the cpu-burst workload inside an already-created sandbox.
 * The caller owns sandbox creation and destruction.
 */
export async function runCpuBurstWorkload(
  sandbox: { runCommand(cmd: string, opts?: { timeout?: number }): Promise<{ exitCode: number; stdout?: string; stderr?: string }> },
  opts: RunCpuBurstWorkloadOptions,
): Promise<CpuBurstWorkloadResult> {
  const { providerName, timeout = SUITE_CONFIG.timeoutMs } = opts;

  const payload = buildPayload();
  if (!payload.ok) {
    return { ok: false, suite: SUITE_CONFIG.id, reason: 'error', error: payload.error, meta: {} };
  }

  const shellCmd = buildSingleCommand(SUITE_CONFIG, payload, {
    provisionedCpu: opts.provisionedCpu,
    provisionedMemoryMb: opts.provisionedMemoryMb,
  });

  try {
    const result = await withTimeout(
      sandbox.runCommand(shellCmd, { timeout }),
      timeout,
      SUITE_CONFIG.id + ' workload timed out',
    ) as { exitCode: number; stdout?: string; stderr?: string };

    if (result.exitCode !== 0) {
      const errTail = (result.stderr || '').slice(-500);
      return { ok: false, suite: SUITE_CONFIG.id, reason: 'error', error: 'non-zero exit: ' + (errTail || 'no stderr'), meta: {} };
    }

    const parsed = parseWorkloadResult(result.stdout || '');
    if (!parsed.ok && parsed.reason === 'unexpected') {
      const stderrTail = (result.stderr || '').slice(-200);
      parsed.error = stderrTail
        ? parsed.error + '; stderr: ' + stderrTail
        : parsed.error + '; stdout was empty (exitCode=0) — provider may not wait for command completion';
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, suite: SUITE_CONFIG.id, reason: classifyError(message), error: message, meta: {} };
  }
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

export async function writeCpuBurstResultsJson(results: CpuBurstBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults: SerializedCpuBurstBenchmarkResult[] = results.map(r => ({
    provider: r.provider,
    suite: r.suite,
    mode: r.mode,
    iterations: r.iterations.map(i => {
      if (i.ok) {
        return {
          ok: true,
          suite: i.suite,
          metric: { value: i.metric.value, unit: i.metric.unit, higherIsBetter: i.metric.higherIsBetter },
          meta: i.meta,
          ...(i.notes ? { notes: i.notes } : {}),
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
      burstHeadroom: {
        median: round(r.summary.median),
        p95: round(r.summary.p95),
        p99: round(r.summary.p99),
        min: round(r.summary.min),
        max: round(r.summary.max),
      },
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
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: { mode: 'cpu-burst', ceiling: SUITE_CONFIG.ceiling, unit: SUITE_CONFIG.unit, timeoutMs: SUITE_CONFIG.timeoutMs },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type FailureReason = Extract<CpuBurstWorkloadResult, { ok: false }>['reason'];

export function classifyError(message: string): FailureReason {
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/gap|skip|not available/i.test(message)) return 'gap';
  return 'error';
}

interface Payload {
  ok: true; scriptName: string; scriptContent: string; stdoutContent: string;
}
interface PayloadErr { ok: false; error: string }

function buildPayload(): Payload | PayloadErr {
  if (!fs.existsSync(BENCH_SCRIPT_PATH)) {
    return { ok: false, error: 'Workload script missing on disk: ' + BENCH_SCRIPT_PATH };
  }
  if (!fs.existsSync(BENCH_STDOUT_PATH)) {
    return { ok: false, error: 'Stdout helper missing on disk: ' + BENCH_STDOUT_PATH };
  }
  const scriptContent = fs.readFileSync(BENCH_SCRIPT_PATH, 'utf8');
  const stdoutContent = fs.readFileSync(BENCH_STDOUT_PATH, 'utf8');

  return {
    ok: true,
    scriptName: SUITE_CONFIG.workloadPath,
    scriptContent, stdoutContent,
  };
}

function randomMarker(prefix: string): string {
  return '__BENCH_' + prefix + '_' + Math.random().toString(36).slice(2, 10) + '__';
}

function buildSingleCommand(
  suite: typeof SUITE_CONFIG,
  payload: Payload,
  resources: { provisionedCpu?: number; provisionedMemoryMb?: number } = {},
): string {
  const lines: string[] = [];
  lines.push('set -e');
  lines.push('mkdir -p /tmp/bench');

  if (payload.stdoutContent) {
    const m1 = randomMarker('STDOUT');
    lines.push('cat > /tmp/bench/stdout.js <<\'' + m1 + '\'');
    lines.push(payload.stdoutContent);
    lines.push(m1);
  }

  const m2 = randomMarker('WORKLOAD');
  lines.push('cat > /tmp/bench/' + payload.scriptName + ' <<\'' + m2 + '\'');
  lines.push(payload.scriptContent);
  lines.push(m2);

  const env = [
    resources.provisionedCpu !== undefined
      ? `CPU_BURST_PROVISIONED_CPU=${resources.provisionedCpu}`
      : '',
    resources.provisionedMemoryMb !== undefined
      ? `CPU_BURST_PROVISIONED_MEMORY_MB=${resources.provisionedMemoryMb}`
      : '',
    'BENCH_SUITE=' + suite.id,
  ].filter(Boolean).join(' ');
  lines.push(env + ' node /tmp/bench/' + payload.scriptName);

  return lines.join('\n');
}

function lastMeta(results: CpuBurstWorkloadResult[]): CpuBurstWorkloadMeta | undefined {
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
  const trimmed = sorted.filter(v => v >= lo && v <= hi);
  return trimmed.length >= 1 ? trimmed : sorted;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Export SUITE_CONFIG for smoke test and SVG generator
export { SUITE_CONFIG };
