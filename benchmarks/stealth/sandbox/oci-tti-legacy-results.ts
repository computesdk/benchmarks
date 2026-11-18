import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type BenchmarkRunOutcome,
  type BenchmarkScoringConfig,
  score,
  scoringConfigToSpec,
} from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';

interface Options {
  /** Absolute path to results/oci_tti/ */
  resultsDir: string;
  /** measure() keys to summarize with median/p95/p99. */
  metricKeys: string[];
  /** The bench's scoring config; the rank key is the platform's overall composite. */
  scoring: BenchmarkScoringConfig;
}

/**
 * Map per-participant task records to legacy result rows and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
/** Scoring ceilings shared with the .bench.ts scoring config (2x p90 provider median, 2026-11); timeouts stay pass/fail. */
export const TTI_CEILING_MS = 6_000;

export function writeOciTtiLegacyResults(
  outcome: BenchmarkRunOutcome,
  opts: Options,
): void {
  // Without groupBy, score() returns one overall row per participant, in order.
  const scored = score(outcome, scoringConfigToSpec({ ...opts.scoring, groupBy: undefined }));
  const results = outcome.participants.map((participant, i) => {
    const records = byTaskIndex(participant.records);
    const summary: Record<string, unknown> = {};
    for (const key of opts.metricKeys) {
      const values = records
        .map((r: TaskResultRecord) => Number((r.data as any)?.[key]))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (values.length) summary[key] = computeStats(values);
    }
    const { compositeScore, successRate } = scored[i];
    const mechanism = (records[0]?.data as { mechanism?: string } | undefined)?.mechanism;
    return {
      provider: participant.participant,
      ...(mechanism ? { mechanism } : {}),
      iterations: records.map((r) => r.data),
      records: records.map(({ taskIndex, status, data }) => ({ taskIndex, status, data })),
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
