/**
 * Convert AI-gateway workload records into a legacy JSON report with per-level
 * throughput/latency/error summaries, max-sustained-concurrency detection,
 * and a pricing comparison.
 */
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject, TaskResultRecord } from '@benchsdk/api';
import { computeStats } from '../src/util/stats.js';
import type { WorkloadSummary } from './workload-task.js';
import type { AIGatewayPricing } from './pricing.js';
import { getProviderPricing } from './pricing.js';
import type { AIGatewayProviderConfig } from './types.js';

const SUSTAINED_ERROR_THRESHOLD = 0.05;
const SUSTAINED_P95_TOTAL_MS = 30_000;
const DEGRADATION_THRESHOLD = 0.75;

const RPS_SCORE_CEILING = 100;
const COST_PER_1K_CEILING = 5.0; // USD

export interface WorkloadLevelResult extends JsonObject {
  concurrency: number;
  iterations: number;
  durationMs: number;
  elapsedMs: number;
  totalRequests: number;
  successfulRequests: number;
  errorCount: number;
  timeoutCount: number;
  errorRate: number;
  timeoutRate: number;
  requestsPerSec: number;
  tokensPerSec: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  p50TotalMs: number;
  p95TotalMs: number;
  p99TotalMs: number;
  p50TtfbMs: number;
  p95TtfbMs: number;
  p99TtfbMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
  costPerRequest: number | null;
  costPer1kRequests: number | null;
  costPerHour: number | null;
  tokensPerDollar: number | null;
}

export interface WorkloadBenchmarkResult extends JsonObject {
  provider: string;
  model: string;
  mode: 'ai-gateway-workload';
  levels: WorkloadLevelResult[];
  maxSustainedConcurrency: number | null;
  maxSustainedRps: number | null;
  maxSustainedTps: number | null;
  maxSustainedCostPerHour: number | null;
  maxSustainedCostPer1kRequests: number | null;
  maxSustainedTokensPerDollar: number | null;
  valueScore: number | null;
  compositeScore: number | null;
  successRate: number;
  pricing: AIGatewayPricing | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asNumberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

function recordToWorkloadSummary(r: TaskResultRecord): WorkloadSummary | undefined {
  if (!r.data) return undefined;
  const d = r.data as unknown as Record<string, unknown>;
  return {
    concurrency: asNumber(d.concurrency),
    durationMs: asNumber(d.durationMs),
    elapsedMs: asNumber(d.elapsedMs),
    totalRequests: asNumber(d.totalRequests),
    successfulRequests: asNumber(d.successfulRequests),
    errorCount: asNumber(d.errorCount),
    timeoutCount: asNumber(d.timeoutCount),
    errorRate: asNumber(d.errorRate),
    timeoutRate: asNumber(d.timeoutRate),
    requestsPerSec: asNumber(d.requestsPerSec),
    tokensPerSec: asNumber(d.tokensPerSec),
    totalInputTokens: asNumber(d.totalInputTokens),
    totalOutputTokens: asNumber(d.totalOutputTokens),
    p50TotalMs: asNumber(d.p50TotalMs),
    p95TotalMs: asNumber(d.p95TotalMs),
    p99TotalMs: asNumber(d.p99TotalMs),
    p50TtfbMs: asNumber(d.p50TtfbMs),
    p95TtfbMs: asNumber(d.p95TtfbMs),
    p99TtfbMs: asNumber(d.p99TtfbMs),
    p50TtftMs: asNumber(d.p50TtftMs),
    p95TtftMs: asNumber(d.p95TtftMs),
    p99TtftMs: asNumber(d.p99TtftMs),
    totalMs: asNumberArray(d.totalMs),
    ttfbMs: asNumberArray(d.ttfbMs),
    ttftMs: asNumberArray(d.ttftMs),
    outputTokensPerSec: asNumberArray(d.outputTokensPerSec),
  } as WorkloadSummary;
}

function computeLevelCosts(level: WorkloadLevelResult, pricing: AIGatewayPricing): void {
  const inputCost = (level.totalInputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (level.totalOutputTokens / 1_000_000) * pricing.outputPer1M;
  const totalCost = inputCost + outputCost;

  if (level.successfulRequests > 0 && totalCost > 0) {
    const costPerRequest = totalCost / level.successfulRequests;
    level.costPerRequest = round6(costPerRequest);
    level.costPer1kRequests = round4(costPerRequest * 1000);
    level.costPerHour = round2(costPerRequest * level.requestsPerSec * 3600);
  } else if (totalCost > 0 && level.elapsedMs > 0) {
    // Fallback: no successful requests, spread cost over elapsed time.
    const costPerHour = totalCost / (level.elapsedMs / 3_600_000);
    level.costPerRequest = null;
    level.costPer1kRequests = null;
    level.costPerHour = round2(costPerHour);
  } else {
    level.costPerRequest = null;
    level.costPer1kRequests = null;
    level.costPerHour = null;
  }

  if (level.costPerHour !== null && level.costPerHour > 0) {
    level.tokensPerDollar = round2((level.tokensPerSec * 3600) / level.costPerHour);
  } else {
    level.tokensPerDollar = null;
  }
}

function summarizeLevel(records: TaskResultRecord[]): WorkloadLevelResult {
  const summaries = records.map(recordToWorkloadSummary).filter((s): s is WorkloadSummary => s !== undefined);

  const totalMs = summaries.flatMap((s) => s.totalMs);
  const ttfbMs = summaries.flatMap((s) => s.ttfbMs);
  const ttftMs = summaries.flatMap((s) => s.ttftMs);

  const totalMsStats = computeStats(totalMs);
  const ttfbStats = computeStats(ttfbMs);
  const ttftStats = computeStats(ttftMs);

  const first = summaries[0];
  const level: WorkloadLevelResult = {
    concurrency: first?.concurrency ?? 0,
    iterations: summaries.length,
    durationMs: first?.durationMs ?? 0,
    elapsedMs: round2(summaries.reduce((sum, s) => sum + s.elapsedMs, 0) / Math.max(summaries.length, 1)),
    totalRequests: summaries.reduce((sum, s) => sum + s.totalRequests, 0),
    successfulRequests: summaries.reduce((sum, s) => sum + s.successfulRequests, 0),
    errorCount: summaries.reduce((sum, s) => sum + s.errorCount, 0),
    timeoutCount: summaries.reduce((sum, s) => sum + s.timeoutCount, 0),
    errorRate: round2(
      summaries.reduce((sum, s) => sum + s.errorCount + s.timeoutCount, 0) /
        Math.max(summaries.reduce((sum, s) => sum + s.totalRequests, 0), 1),
    ),
    timeoutRate: round2(
      summaries.reduce((sum, s) => sum + s.timeoutCount, 0) /
        Math.max(summaries.reduce((sum, s) => sum + s.totalRequests, 0), 1),
    ),
    requestsPerSec: round2(
      summaries.reduce((sum, s) => sum + s.successfulRequests, 0) /
        (summaries.reduce((sum, s) => sum + s.elapsedMs, 0) / 1000 || 1),
    ),
    tokensPerSec: round2(
      summaries.reduce((sum, s) => sum + s.totalOutputTokens, 0) /
        (summaries.reduce((sum, s) => sum + s.elapsedMs, 0) / 1000 || 1),
    ),
    totalInputTokens: summaries.reduce((sum, s) => sum + s.totalInputTokens, 0),
    totalOutputTokens: summaries.reduce((sum, s) => sum + s.totalOutputTokens, 0),
    p50TotalMs: round2(totalMsStats.median),
    p95TotalMs: round2(totalMsStats.p95),
    p99TotalMs: round2(totalMsStats.p99),
    p50TtfbMs: round2(ttfbStats.median),
    p95TtfbMs: round2(ttfbStats.p95),
    p99TtfbMs: round2(ttfbStats.p99),
    p50TtftMs: round2(ttftStats.median),
    p95TtftMs: round2(ttftStats.p95),
    p99TtftMs: round2(ttftStats.p99),
    costPerRequest: null,
    costPer1kRequests: null,
    costPerHour: null,
    tokensPerDollar: null,
  };

  // Recompute per-level error/timeout rates from the merged counts.
  const total = level.errorCount + level.timeoutCount + level.successfulRequests;
  level.errorRate = round2((level.errorCount + level.timeoutCount) / Math.max(total, 1));
  level.timeoutRate = round2(level.timeoutCount / Math.max(total, 1));

  return level;
}

function findMaxSustainedLevel(levels: WorkloadLevelResult[]): WorkloadLevelResult | null {
  const sorted = [...levels].sort((a, b) => a.concurrency - b.concurrency);
  let previous: WorkloadLevelResult | null = null;
  let maxSustained: WorkloadLevelResult | null = null;

  for (const level of sorted) {
    const hasErrors = level.errorRate > SUSTAINED_ERROR_THRESHOLD;
    const tooSlow = level.p95TotalMs > SUSTAINED_P95_TOTAL_MS;
    const degraded = previous !== null && level.requestsPerSec < previous.requestsPerSec * DEGRADATION_THRESHOLD;

    if (hasErrors || tooSlow || degraded) {
      break;
    }

    maxSustained = level;
    previous = level;
  }

  return maxSustained;
}

function computeValueScore(rps: number, costPer1kRequests: number): number {
  const throughputScore = Math.min(100, (rps / RPS_SCORE_CEILING) * 100);
  const costEfficiency = Math.max(0, 100 * (1 - costPer1kRequests / COST_PER_1K_CEILING));
  if (throughputScore <= 0 || costEfficiency <= 0) return 0;
  return Math.round(Math.sqrt(throughputScore * costEfficiency) * 10) / 10;
}

export function recordsToWorkloadResults(
  participants: ParticipantRecords[],
  opts: { providers: AIGatewayProviderConfig[] },
): WorkloadBenchmarkResult[] {
  return participants.map((participant) => {
    const providerConfig = opts.providers.find((p) => p.name === participant.participant);
    const model = providerConfig?.model ?? '';
    const pricing = providerConfig ? getProviderPricing(providerConfig.name) ?? null : null;

    // Group records by concurrency level.
    const byConcurrency = new Map<number, TaskResultRecord[]>();
    for (const record of participant.records) {
      const summary = recordToWorkloadSummary(record);
      if (!summary) continue;
      const list = byConcurrency.get(summary.concurrency) ?? [];
      list.push(record);
      byConcurrency.set(summary.concurrency, list);
    }

    const levels: WorkloadLevelResult[] = [];
    for (const records of byConcurrency.values()) {
      const level = summarizeLevel(records);
      if (pricing) computeLevelCosts(level, pricing);
      levels.push(level);
    }
    levels.sort((a, b) => a.concurrency - b.concurrency);

    const maxSustained = findMaxSustainedLevel(levels);
    const totalRequests = levels.reduce((sum, l) => sum + l.totalRequests, 0);
    const successfulRequests = levels.reduce((sum, l) => sum + l.successfulRequests, 0);
    const successRate = totalRequests > 0 ? round2(successfulRequests / totalRequests) : 0;

    let valueScore: number | null = null;
    let compositeScore: number | null = null;
    let maxSustainedConcurrency: number | null = null;
    let maxSustainedRps: number | null = null;
    let maxSustainedTps: number | null = null;
    let maxSustainedCostPerHour: number | null = null;
    let maxSustainedCostPer1kRequests: number | null = null;
    let maxSustainedTokensPerDollar: number | null = null;

    if (maxSustained) {
      maxSustainedConcurrency = maxSustained.concurrency;
      maxSustainedRps = maxSustained.requestsPerSec;
      maxSustainedTps = maxSustained.tokensPerSec;
      maxSustainedCostPerHour = maxSustained.costPerHour;
      maxSustainedCostPer1kRequests = maxSustained.costPer1kRequests;
      maxSustainedTokensPerDollar = maxSustained.tokensPerDollar;

      if (maxSustained.costPer1kRequests !== null) {
        valueScore = computeValueScore(maxSustained.requestsPerSec, maxSustained.costPer1kRequests);
        compositeScore = valueScore;
      }
    }

    return {
      provider: participant.participant,
      model,
      mode: 'ai-gateway-workload' as const,
      levels,
      maxSustainedConcurrency,
      maxSustainedRps,
      maxSustainedTps,
      maxSustainedCostPerHour,
      maxSustainedCostPer1kRequests,
      maxSustainedTokensPerDollar,
      valueScore,
      compositeScore,
      successRate,
      pricing,
    };
  });
}

export async function writeWorkloadResultsJson(results: WorkloadBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('node:fs');
  const os = await import('node:os');

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    results,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Workload results written to ${outPath}`);
}

export async function writeAIGatewayWorkloadResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; providers: AIGatewayProviderConfig[] },
): Promise<void> {
  const results = recordsToWorkloadResults(participants, opts);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeWorkloadResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
