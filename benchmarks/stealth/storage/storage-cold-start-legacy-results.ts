import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, scoringConfigToSpec } from '@benchsdk/runner';
import type { BenchmarkDisplayConfig, BenchmarkRunOutcome, BenchmarkScoringConfig } from '@benchsdk/runner';
import { median, p95 } from './storage-cold-start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_COLD_START_RESULTS_DIR = path.resolve(__dirname, '../../../results/storage_cold_start');

export const SUMMARY_METRICS = [
  'coldGetMs',
  'warmGetMs',
  'coldPenaltyMs',
  'coldPutMs',
  'warmPutMs',
  'putColdPenaltyMs',
  'clientInitMs',
  'processSpawnMs',
] as const;

/**
 * Writes one results/storage_cold_start/<provider>.json per participant; the
 * collect job merges them into latest.json with the generic merge-results
 * script (which skips latest.json inputs).
 * compositeScore comes from the runner's own scorer over the bench's
 * `scoring` spec, so there is no second hand-written formula to drift.
 */
export function writeStorageColdStartResults(outcome: BenchmarkRunOutcome, config: { scoring?: BenchmarkScoringConfig; display?: BenchmarkDisplayConfig }): void {
  const scores = config.scoring
    ? score(outcome, scoringConfigToSpec(config.scoring, undefined, config.display), config.display?.metrics)
    : [];

  const results = outcome.participants.map(({ participant, records }) => {
    const ok = records.filter((r) => r.status === 'success');
    const summary: Record<string, { median: number | null; p95: number | null }> = {};
    for (const key of SUMMARY_METRICS) {
      const values = ok.map((r) => r.data?.[key]).filter((v): v is number => typeof v === 'number');
      summary[key] = { median: median(values), p95: p95(values) };
    }
    const scored = scores.find((s) => s.provider === participant);
    return {
      provider: participant,
      compositeScore: scored?.compositeScore,
      successRate: records.length ? ok.length / records.length : 0,
      iterations: records.length,
      summary,
      errors: records
        .filter((r) => r.status !== 'success')
        .map((r) => String(r.data?.errorMessage ?? r.errorCode ?? 'failed'))
        .slice(0, 5),
    };
  });

  fs.mkdirSync(STORAGE_COLD_START_RESULTS_DIR, { recursive: true });
  for (const result of results) {
    const output = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      runId: outcome.runId,
      environment: { node: process.version, platform: os.platform(), arch: os.arch() },
      config: { iterations: outcome.config.iterations, concurrency: outcome.config.concurrency },
      results: [result],
    };
    const file = path.join(STORAGE_COLD_START_RESULTS_DIR, `${result.provider}.json`);
    fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`Storage cold start results written to ${file}`);
  }
}
