import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';

const SCRAPE_MS_CEILING = 30_000;

interface Options {
  /** Absolute path to results/web_data_scrape/ */
  resultsDir: string;
}

/**
 * Map per-participant task records to legacy result rows and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 *
 * The local compositeScore mirrors the bench's scoring config (scrapeMs vs a
 * 30s ceiling, weighted median .6 / p95 .3 / p99 .1) scaled by success rate.
 */
export function writeWebDataScrapeResults(
  participants: ParticipantRecords[],
  opts: Options,
): void {
  const results = participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const succeeded = records.filter((r) => r.status === 'success').length;
    const successRate = records.length ? succeeded / records.length : 0;

    const scrapeMs = records
      .map((r) => Number((r.data as any)?.scrapeMs))
      .filter((v) => Number.isFinite(v) && v > 0);
    const stats = computeStats(scrapeMs);
    const lowerBetter = (v: number) => Math.max(0, 1 - v / SCRAPE_MS_CEILING);
    const compositeScore =
      scrapeMs.length > 0
        ? Math.round(
            successRate *
              (0.6 * lowerBetter(stats.median) + 0.3 * lowerBetter(stats.p95) + 0.1 * lowerBetter(stats.p99)) *
              1000,
          ) / 10
        : 0;

    const buckets: Record<string, { success: number; total: number }> = {};
    for (const r of records) {
      const bucket = String((r.data as any)?.bucket ?? 'unknown');
      buckets[bucket] ??= { success: 0, total: 0 };
      buckets[bucket].total += 1;
      if (r.status === 'success') buckets[bucket].success += 1;
    }

    return {
      provider: participant.participant,
      iterations: records.map((r) => r.data),
      summary: {
        scrapeMs: stats,
        buckets,
      },
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
