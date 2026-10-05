import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BenchmarkRunOutcome } from '@benchsdk/runner';
import { ACTION_TYPES } from '../throughput-types.js';

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

export function writeNativeResults(outcome: BenchmarkRunOutcome, suite: 'readiness' | 'throughput', articleUrls?: string[]): string {
  const summaries = outcome.participants.map(({ participant, records }) => {
    const attempted = records.filter(record => record.data?.attemptStarted === true);
    const complete = attempted.filter(record => record.data?.workloadSuccess === true);
    const metrics = Object.fromEntries(['readinessMs', 'taskMs', 'actionsPerSecond', 'screenshotMs', 'cleanupMs'].map(key => [key,
      distribution((key === 'cleanupMs' ? attempted : complete).flatMap(record => {
        const value = record.data?.[key];
        return typeof value === 'number' && Number.isFinite(value) ? [value] : [];
      })),
    ]));
    const perActionType = Object.fromEntries(ACTION_TYPES.map(type => [type, distribution(complete.flatMap(record => {
      const actions = record.data?.actions;
      if (!Array.isArray(actions)) return [];
      return actions.flatMap(action => {
        if (!action || typeof action !== 'object' || Array.isArray(action)) return [];
        return action.type === type && action.success === true && typeof action.durationMs === 'number' ? [action.durationMs] : [];
      });
    }))]));
    const rate = (key: string) => attempted.length ? attempted.filter(record => record.data?.[key] === true).length / attempted.length : null;
    return { participant, scheduled: records.length, attempts: attempted.length, workloadSuccessRate: rate('workloadSuccess'), cleanupSuccessRate: rate('cleanupSuccess'), successRate: rate('sessionSuccess'), metrics, perActionType };
  });
  const directory = path.resolve(process.env.PLAYWRIGHT_NATIVE_RESULTS_DIR ?? 'results/playwright-native', suite);
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${randomUUID()}.json`);
  writeFileSync(filename, JSON.stringify({ suite, runId: outcome.runId, createdAt: new Date().toISOString(), config: outcome.config, ...(articleUrls ? { articleUrls } : {}), summaries, participants: outcome.participants }, null, 2));
  console.log(`Raw Playwright-native records and untrimmed summaries: ${filename}`);
  return filename;
}
