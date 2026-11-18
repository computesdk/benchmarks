/**
 * Result writers for the Playwright-native suites.
 *
 * writeNativeResults — the raw, untrimmed artifact: every record plus
 * nearest-rank median/P95/P99 distributions per metric and per action type.
 * This is the methodology artifact for provider comparisons.
 *
 * writeLegacyResults — the platform-shape per-provider file
 * (`results/<slug_snake>/results.json`) consumed by the generic
 * `pnpm merge-results` collect step in CI, with a locally computed
 * compositeScore mirroring the config's scoring block.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { filterParticipantsByEnv } from '@benchsdk/client';
import type { BenchmarkRunOutcome, BenchmarkScoringConfig } from '@benchsdk/runner';
import { playwrightProviders } from './playwright-providers.js';
import { ACTION_TYPES } from './playwright-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Untrimmed nearest-rank percentiles; missing observations are not zeroes. */
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { count: 0, median: null, p95: null, p99: null };
  const mid = Math.floor(n / 2);
  return {
    count: n,
    median: n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1],
    p99: sorted[Math.ceil(n * 0.99) - 1],
  };
}

export const METRIC_KEYS = ['readinessMs', 'taskMs', 'actionsPerSecond', 'screenshotMs', 'cleanupMs'] as const;

interface ParticipantSummary {
  participant: string;
  scheduled: number;
  attempts: number;
  workloadSuccessRate: number | null;
  cleanupSuccessRate: number | null;
  successRate: number | null;
  metrics: Record<string, { count: number; median: number | null; p95: number | null; p99: number | null }>;
  perActionType: Record<string, { count: number; median: number | null; p95: number | null; p99: number | null }>;
  environment: Record<string, unknown>;
}

export function summarize(outcome: BenchmarkRunOutcome): ParticipantSummary[] {
  return outcome.participants.map(({ participant, records }) => {
    const attempted = records.filter(record => record.data?.attemptStarted === true);
    const complete = attempted.filter(record => record.data?.workloadSuccess === true);
    const metrics = Object.fromEntries(METRIC_KEYS.map(key => [key,
      distribution((key === 'cleanupMs' ? attempted : complete).flatMap(record => {
        const value = record.data?.[key];
        return typeof value === 'number' && Number.isFinite(value) ? [value] : [];
      })),
    ]));
    const actions = complete.flatMap(record => {
      const actions = record.data?.actions;
      if (!Array.isArray(actions)) return [];
      return actions.flatMap(action => {
        if (!action || typeof action !== 'object' || Array.isArray(action)) return [];
        if (action.success !== true || typeof action.durationMs !== 'number') return [];
        return [{ type: action.type, durationMs: action.durationMs }];
      });
    });
    const perActionType = Object.fromEntries(ACTION_TYPES.map(type => [type,
      distribution(actions.filter(action => action.type === type).map(action => action.durationMs)),
    ]));
    const rate = (key: string) => attempted.length ? attempted.filter(record => record.data?.[key] === true).length / attempted.length : null;
    const envData = attempted[0]?.data ?? records[0]?.data ?? {};
    return {
      participant, scheduled: records.length, attempts: attempted.length,
      workloadSuccessRate: rate('workloadSuccess'), cleanupSuccessRate: rate('cleanupSuccess'), successRate: rate('sessionSuccess'),
      metrics, perActionType,
      environment: {
        region: envData.region, metadataSource: envData.metadataSource,
        serverPlaywrightVersion: envData.serverPlaywrightVersion,
        clientPlaywrightVersion: envData.clientPlaywrightVersion,
        chromiumVersion: envData.chromiumVersion,
      },
    };
  });
}

export function writeNativeResults(outcome: BenchmarkRunOutcome, suite: 'readiness' | 'throughput', articleUrls?: string[]): void {
  const comparison = playwrightProviders.every(provider => outcome.participants.some(p => p.participant === provider.name));
  const { skipped: unavailableParticipants } = filterParticipantsByEnv(playwrightProviders);
  const directory = path.resolve(process.env.PLAYWRIGHT_NATIVE_RESULTS_DIR ?? 'results/playwright-native', suite);
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${randomUUID()}.json`);
  writeFileSync(filename, JSON.stringify({
    suite, mode: comparison ? 'comparison' : 'provider-diagnostic', unavailableParticipants,
    runId: outcome.runId, createdAt: new Date().toISOString(), config: outcome.config,
    ...(articleUrls ? { articleUrls } : {}),
    summaries: summarize(outcome), participants: outcome.participants,
  }, null, 2));
  console.log(`Raw Playwright-native records and untrimmed summaries: ${filename}`);
}

function metricScore(value: number | null, ceiling: number, higherIsBetter?: boolean): number {
  if (value === null || !Number.isFinite(value)) return 0;
  const ratio = higherIsBetter ? value / ceiling : 1 - value / ceiling;
  return Math.max(0, Math.min(100, 100 * ratio));
}

export function compositeScore(summary: ParticipantSummary, metrics: BenchmarkScoringConfig['metrics']): number {
  if (summary.workloadSuccessRate === 0 || summary.attempts === 0) return 0;
  return metrics.reduce((score, metric) => {
    const dist = summary.metrics[metric.key];
    if (!dist || !metric.weights) return score;
    const w = metric.weights as { median?: number; p95?: number; p99?: number };
    return score
      + (w.median ?? 0) * metricScore(dist.median, metric.ceiling, metric.higherIsBetter)
      + (w.p95 ?? 0) * metricScore(dist.p95, metric.ceiling, metric.higherIsBetter)
      + (w.p99 ?? 0) * metricScore(dist.p99, metric.ceiling, metric.higherIsBetter);
  }, 0);
}

/**
 * Legacy `{results: [...]}` file for the generic collect step. `ttiMs` carries
 * the suite's headline metric per attempt (readinessMs or taskMs); untrimmed
 * distributions live in `summary` and per-attempt detail in `meta`.
 */
export function writeLegacyResults(
  outcome: BenchmarkRunOutcome,
  slug: string,
  headlineKey: 'readinessMs' | 'taskMs',
  metrics: BenchmarkScoringConfig['metrics'],
): void {
  const summaries = summarize(outcome);
  const results = outcome.participants.map(({ participant, records }, index) => {
    const summary = summaries[index];
    const attempted = records.filter(record => record.data?.attemptStarted === true);
    return {
      provider: participant,
      iterations: records.map(record => {
        const value = record.data?.[headlineKey];
        return {
          ...(record.data?.attemptStarted === true && typeof value === 'number' ? { ttiMs: value } : {}),
          ...(record.errorCode || record.data?.errorMessage ? { error: String(record.errorCode ?? record.data?.errorMessage) } : {}),
        };
      }),
      summary: Object.fromEntries(METRIC_KEYS.flatMap(key => {
        const dist = summary.metrics[key];
        return dist && dist.count > 0 ? [[key, { median: dist.median, p95: dist.p95, p99: dist.p99 }]] : [];
      })),
      compositeScore: compositeScore(summary, metrics),
      meta: {
        scheduled: summary.scheduled,
        attempts: summary.attempts,
        workloadSuccessRate: summary.workloadSuccessRate,
        cleanupSuccessRate: summary.cleanupSuccessRate,
        successRate: summary.successRate,
        environment: summary.environment,
        perActionType: summary.perActionType,
        errorMessage: attempted.find(record => record.data?.errorMessage)?.data?.errorMessage,
      },
    };
  });
  const outputDir = path.resolve(__dirname, `../../../results/${slug.replace(/-/g, '_')}`);
  mkdirSync(outputDir, { recursive: true });
  const filename = path.join(outputDir, 'results.json');
  writeFileSync(filename, JSON.stringify({
    version: '1.0', timestamp: new Date().toISOString(),
    environment: { platform: 'benchmarks-stealth', node: process.version },
    config: { iterations: outcome.config.iterations, concurrency: outcome.config.concurrency, groupBy: 'round' },
    results,
  }, null, 2));
  console.log(`Wrote legacy results: ${filename}`);
}
