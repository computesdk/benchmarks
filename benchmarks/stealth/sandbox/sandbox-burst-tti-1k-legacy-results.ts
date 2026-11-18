import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';

const METRIC_KEYS = [
  'ttiMinMs',
  'ttiMedianMs',
  'ttiP95Ms',
  'ttiP99Ms',
  'ttiMaxMs',
  'burstCreateWallClockMs',
  'idleWaitMs',
  'readyCount',
  'readyPct',
  'aliveCount',
  'alivePct',
  'livenessMs',
  'destroyMs',
  'wallClockMs',
];

/**
 * Scoring ceilings for 1000-way contention, shared with the .bench.ts scoring
 * config. The public bench scores ttiMs against 10s; a 1000-box burst queues
 * behind provider rate limits, so the median gets 60s and the tail gets
 * proportionally more room (p99 = 2x the p90 provider median, 2026-11), all
 * inside the 300s create timeout.
 */
export const TTI_MEDIAN_CEILING_MS = 60_000;
export const TTI_P95_CEILING_MS = 120_000;
export const TTI_P99_CEILING_MS = 150_000;

interface Options {
  /** Absolute path to results/sandbox_burst_tti_1k/ */
  resultsDir: string;
}

function lowerBetterScore(median: number | undefined, ceiling: number): number {
  if (!median || median <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - median / ceiling)));
}

/**
 * Map per-participant task records to legacy result rows and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 *
 * Same shape as the burst-survival writer: successRate counts iterations the
 * task completed at all, and alivePct's dominant weight penalizes lost boxes
 * proportionally in compositeScore.
 */
export function writeBurstTti1kLegacyResults(
  participants: ParticipantRecords[],
  opts: Options,
): void {
  const results = participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const summary: Record<string, unknown> = {};
    for (const key of METRIC_KEYS) {
      const values = records
        .map((r: TaskResultRecord) => Number((r.data as any)?.[key]))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (values.length) summary[key] = computeStats(values);
    }
    const succeeded = records.filter((r) => r.status === 'success').length;
    const successRate = records.length ? succeeded / records.length : 0;
    // Rank key for the collector's summary table — mirrors the platform
    // scoring weights (alivePct .85 / ttiMedian .09 / ttiP95 .04 / ttiP99 .02).
    const med = (k: string) => (summary[k] as { median: number } | undefined)?.median;
    const weighted =
      0.85 * (med('alivePct') ?? 0) +
      0.09 * lowerBetterScore(med('ttiMedianMs'), TTI_MEDIAN_CEILING_MS) +
      0.04 * lowerBetterScore(med('ttiP95Ms'), TTI_P95_CEILING_MS) +
      0.02 * lowerBetterScore(med('ttiP99Ms'), TTI_P99_CEILING_MS);
    const compositeScore = Math.round(successRate * weighted * 10) / 10;
    return {
      provider: participant.participant,
      iterations: records.map((r) => r.data),
      summary,
      compositeScore,
      successRate,
    };
  });

  mkdirSync(opts.resultsDir, { recursive: true });
  const out = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    results,
  };
  const datePath = path.join(opts.resultsDir, `${out.timestamp.slice(0, 10)}.json`);
  writeFileSync(datePath, JSON.stringify(out, null, 2));
  copyFileSync(datePath, path.join(opts.resultsDir, 'latest.json'));
}
