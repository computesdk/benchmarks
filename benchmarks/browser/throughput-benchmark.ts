/**
 * Throughput result summarization + legacy JSON writer. The workload itself
 * lives in browser-throughput.bench.ts; this module only turns collected
 * iterations into the `results/browser-throughput/` JSON shape.
 */
import {
  ACTION_TYPES,
  ACTIONS_PER_SESSION,
  type ActionType,
  type ThroughputBenchmarkResult,
  type ThroughputStats,
  type ThroughputStatsTriple,
  type ThroughputTimingResult,
} from './throughput-types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

function computeStats(values: number[]): ThroughputStatsTriple {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  // Trim 5% tails when we have enough samples to make trimming meaningful
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

export function summarizeIterations(iterations: ThroughputTimingResult[]): ThroughputStats {
  const createValues = iterations.map(i => i.createMs).filter(v => v > 0);
  const taskValues = iterations.map(i => i.taskMs).filter(v => v > 0);
  const totalValues = iterations.map(i => i.totalMs).filter(v => v > 0);
  const apsValues = iterations.map(i => i.actionsPerSecond).filter(v => v > 0);

  const perActionType = {} as Record<ActionType, ThroughputStatsTriple>;
  for (const type of ACTION_TYPES) {
    const values: number[] = [];
    for (const iter of iterations) {
      for (const a of iter.actions) {
        if (a.type === type && a.success) values.push(a.durationMs);
      }
    }
    perActionType[type] = computeStats(values);
  }

  return {
    createMs: computeStats(createValues),
    taskMs: computeStats(taskValues),
    totalMs: computeStats(totalValues),
    actionsPerSecond: computeStats(apsValues),
    perActionType,
  };
}

export function emptySummary(): ThroughputStats {
  const empty: ThroughputStatsTriple = { median: 0, p95: 0, p99: 0 };
  const perActionType = {} as Record<ActionType, ThroughputStatsTriple>;
  for (const t of ACTION_TYPES) perActionType[t] = { ...empty };
  return {
    createMs: { ...empty },
    taskMs: { ...empty },
    totalMs: { ...empty },
    actionsPerSecond: { ...empty },
    perActionType,
  };
}

function roundStats(s: ThroughputStatsTriple): ThroughputStatsTriple {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeThroughputResultsJson(
  results: ThroughputBenchmarkResult[],
  outPath: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      createMs: round(i.createMs),
      connectMs: round(i.connectMs),
      releaseMs: round(i.releaseMs),
      totalMs: round(i.totalMs),
      taskMs: round(i.taskMs),
      actionsCompleted: i.actionsCompleted,
      actionsPerSecond: round(i.actionsPerSecond),
      actions: i.actions.map(a => ({
        index: a.index,
        type: a.type,
        durationMs: round(a.durationMs),
        success: a.success,
        ...(a.error ? { error: a.error } : {}),
        ...(a.navigationEvents?.length ? { navigationEvents: a.navigationEvents } : {}),
      })),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      createMs: roundStats(r.summary.createMs),
      taskMs: roundStats(r.summary.taskMs),
      totalMs: roundStats(r.summary.totalMs),
      actionsPerSecond: roundStats(r.summary.actionsPerSecond),
      perActionType: Object.fromEntries(
        ACTION_TYPES.map(t => [t, roundStats(r.summary.perActionType[t])]),
      ),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  // Derive iteration count from the largest run across providers, so a
  // skipped first provider doesn't make the header read 0.
  const iterations = results.reduce((max, r) => Math.max(max, r.iterations.length), 0);

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations,
      actionsPerSession: ACTIONS_PER_SESSION,
      timeoutMs: options.timeoutMs ?? 120_000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
