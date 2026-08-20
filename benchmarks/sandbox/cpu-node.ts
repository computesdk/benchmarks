import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderConfig } from './types.js';
import { percentile } from '../src/util/stats.js';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';

// ---------------------------------------------------------------------------
// Suite configuration
// ---------------------------------------------------------------------------

const SUITE_CONFIG = {
  id: 'cpu-node' as const,
  label: 'CPU — node-web-tooling build',
  unit: 'ms' as const,
  higherIsBetter: false,
  ceiling: 45000,
  defaultReplicas: 3,
  workloadPath: 'cpu-node-workload.js',
  timeoutMs: 300_000,
};

const BENCH_SCRIPT_PATH = path.resolve(import.meta.dirname, '../scripts/cpu-node-workload.js');
const BENCH_STDOUT_PATH = path.resolve(import.meta.dirname, '../scripts/cpu-node-stdout.js');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CpuNodeWorkloadMeta {
  cpuCount?: number;
  memoryMb?: number;
  workloadMs?: number;
  iterationsReported?: number;
  providerNotes?: string;
}

export type CpuNodeWorkloadResult =
  | {
      ok: true;
      suite: 'cpu-node';
      metric: { value: number; unit: 'ms'; higherIsBetter: boolean };
      meta: CpuNodeWorkloadMeta;
      notes?: string;
    }
  | {
      ok: false;
      suite: 'cpu-node';
      reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
      error?: string;
      meta: CpuNodeWorkloadMeta;
    };

export interface CpuNodeSuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: CpuNodeWorkloadMeta;
}

export interface CpuNodeBenchmarkResult {
  provider: string;
  suite: 'cpu-node';
  mode: 'cpu-node';
  iterations: CpuNodeWorkloadResult[];
  summary: CpuNodeSuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  skipped?: boolean;
  skipReason?: string;
}

// Schema-compliant shape written to results/cpu_node/*.json.
export interface MetricSummary {
  median: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
}

export interface SerializedCpuNodeBenchmarkResult {
  provider: string;
  suite: 'cpu-node';
  mode: 'cpu-node';
  iterations: CpuNodeWorkloadResult[];
  summary: { totalMs: MetricSummary };
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  meta: CpuNodeWorkloadMeta;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single value against the suite's calibration ceiling.
 * Lower is better: 100 * (1 - value/ceiling). Clamped to [0, 100].
 */
export function scoreMetric(value: number, suite: typeof SUITE_CONFIG): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = suite.higherIsBetter ? value / suite.ceiling : 1 - value / suite.ceiling;
  return clamp(ratio * 100, 0, 100);
}

/**
 * Compute median/min/max/p95/p99/score for a single provider cell.
 * 2-sigma outlier trim. If trim leaves < 1 sample, keep the raw median.
 */
export function computeStats(results: CpuNodeWorkloadResult[], suite: typeof SUITE_CONFIG): CpuNodeSuiteStats {
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

  return {
    median, p95, p99,
    min: sorted[0], max: sorted[sorted.length - 1],
    successRate: ok / total, n: ok,
    scoreBeforeReliability: scoreMetric(median, suite),
    compositeScore: round1(scoreMetric(median, suite) * (ok / total)),
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
export function parseWorkloadResult(stdout: string): CpuNodeWorkloadResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as CpuNodeWorkloadResult;
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.suite !== 'string' || parsed.suite !== 'cpu-node') continue;
      return parsed;
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    suite: 'cpu-node',
    reason: 'unexpected',
    error: 'no parseable WorkloadResult JSON line found in stdout',
    meta: {},
  };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

/**
 * Run the cpu-node benchmark for one provider at the given replicate count.
 *
 * Each replicate:
 *   - creates a fresh sandbox via ComputeSDK
 *   - uploads the workload script + stdout helper via heredoc and executes
 *     node in a SINGLE runCommand call
 *   - parses the last WorkloadResult JSON line from stdout
 *   - destroys the sandbox unconditionally
 */
export async function runCpuNodeBenchmark(
  config: ProviderConfig & { replicas?: number },
): Promise<CpuNodeBenchmarkResult> {
  const { name, replicas = SUITE_CONFIG.defaultReplicas, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;
  const suite = SUITE_CONFIG;

  const t0 = performance.now();

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name, suite: suite.id, mode: suite.id,
      iterations: [], summary: emptyStats(), wallClockMs: 0,
      replicateMs: [], compositeScore: 0,
      skipped: true, skipReason: 'Missing: ' + missingVars.join(', '),
    };
  }

  const payload = buildPayload();
  if (!payload.ok) {
    return {
      provider: name, suite: suite.id, mode: suite.id,
      iterations: [{ ok: false, suite: suite.id, reason: 'error', error: payload.error, meta: {} }],
      summary: emptyStats(), wallClockMs: 0, replicateMs: [], compositeScore: 0,
    };
  }

  const iterations: CpuNodeWorkloadResult[] = [];
  const replicateMs: number[] = [];

  for (let r = 0; r < replicas; r++) {
    console.log('  [' + name + '/' + suite.id + '] replicate ' + (r + 1) + '/' + replicas + '...');
    const rStart = performance.now();

    let sandbox: any = null;
    try {
      const compute = config.createCompute();
      sandbox = await withTimeout(
        compute.sandbox.create(sandboxOptions),
        timeout,
        'Sandbox creation timed out',
      );

      const shellCmd = buildSingleCommand(suite, payload);
      const result = await withTimeout(
        sandbox.runCommand(shellCmd, { timeout: suite.timeoutMs }),
        suite.timeoutMs,
        suite.id + ' workload timed out',
      ) as { exitCode: number; stdout?: string; stderr?: string };

      if (result.exitCode !== 0) {
        const errTail = (result.stderr || '').slice(-500);
        iterations.push({ ok: false, suite: suite.id, reason: 'error', error: 'non-zero exit: ' + (errTail || 'no stderr'), meta: {} });
      } else {
        const parsed = parseWorkloadResult(result.stdout || '');
        if (!parsed.ok && parsed.reason === 'unexpected') {
          const stderrTail = (result.stderr || '').slice(-200);
          parsed.error = stderrTail
            ? parsed.error + '; stderr: ' + stderrTail
            : parsed.error + '; stdout was empty (exitCode=0) — provider may not wait for command completion';
        }
        iterations.push(parsed);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      iterations.push({ ok: false, suite: suite.id, reason: classifyError(message), error: message, meta: {} });
    } finally {
      replicateMs.push(performance.now() - rStart);
      if (sandbox) {
        try {
          await withTimeout(sandbox.destroy(), destroyTimeoutMs, 'destroy timeout');
        } catch (err) {
          console.warn('    [cleanup] destroy failed: ' + formatError(err));
        }
      }
    }
  }

  const summary = computeStats(iterations, suite);
  const wallClockMs = performance.now() - t0;

  console.log('  [' + name + '/' + suite.id + '] ' + summary.n + '/' + replicas + ' OK · median ' + summary.median.toFixed(1) + 'ms · score ' + summary.compositeScore);

  return {
    provider: name, suite: suite.id, mode: suite.id,
    iterations, summary, wallClockMs, replicateMs,
    compositeScore: summary.compositeScore,
  };
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

export async function writeCpuNodeResultsJson(results: CpuNodeBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults: SerializedCpuNodeBenchmarkResult[] = results.map(r => ({
    provider: r.provider,
    suite: r.suite,
    mode: r.mode,
    iterations: r.iterations.map(i => {
      if (i.ok) {
        return {
          ok: true,
          suite: i.suite,
          metric: { value: round(i.metric.value), unit: i.metric.unit, higherIsBetter: i.metric.higherIsBetter },
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
    compositeScore: round(r.compositeScore),
    successRate: round(r.summary.successRate),
    n: r.summary.n,
    scoreBeforeReliability: round(r.summary.scoreBeforeReliability),
    meta: r.summary.meta,
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: { mode: 'cpu-node', ceiling: SUITE_CONFIG.ceiling, unit: SUITE_CONFIG.unit, timeoutMs: SUITE_CONFIG.timeoutMs },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyStats(): CpuNodeSuiteStats {
  return { median: 0, p95: 0, p99: 0, min: 0, max: 0, successRate: 0, n: 0, scoreBeforeReliability: 0, compositeScore: 0, meta: {} };
}

type FailureReason = Extract<CpuNodeWorkloadResult, { ok: false }>['reason'];

function classifyError(message: string): FailureReason {
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

function buildSingleCommand(suite: typeof SUITE_CONFIG, payload: Payload): string {
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

  lines.push('BENCH_SUITE=' + suite.id + ' node /tmp/bench/' + payload.scriptName);

  return lines.join('\n');
}

function lastMeta(results: CpuNodeWorkloadResult[]): CpuNodeWorkloadMeta | undefined {
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

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Export SUITE_CONFIG for smoke test and SVG generator
export { SUITE_CONFIG };
