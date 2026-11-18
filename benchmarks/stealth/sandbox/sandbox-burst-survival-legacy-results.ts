import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { burstLegacyScore } from './scoring-capabilities.js';
import { scoreParticipantRecords } from '../src/util/scoring.js';
export { TTI_MEDIAN_CEILING_MS, TTI_MAX_CEILING_MS, DESTROY_CEILING_MS } from './scoring-capabilities.js';

const METRIC_KEYS = [
  'ttiMinMs',
  'ttiMedianMs',
  'ttiMaxMs',
  'burstCreateWallClockMs',
  'idleWaitMs',
  'aliveCount',
  'alivePct',
  'livenessMs',
  'destroyMs',
  'wallClockMs',
];

/**
 * Scoring ceilings shared with the .bench.ts scoring config (2x p90 provider
 * median, 2026-11); the create/destroy timeouts stay pass/fail.
 */
interface Options {
  /** Absolute path to results/sandbox_burst_survival/ */
  resultsDir: string;
  scoring?: BenchmarkScoringConfig;
}

/**
 * Map per-participant task records to legacy result rows and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 *
 * successRate counts iterations the task completed at all; there is no
 * allAlive pass/fail gate — alivePct's dominant weight penalizes reaped
 * boxes proportionally in compositeScore. Failed iterations remain in the
 * raw iterations but do not contribute metric samples, as in the runner.
 */
export function writeBurstSurvivalLegacyResults(
  participants: ParticipantRecords[],
  opts: Options,
): void {
  const scores = opts.scoring ? scoreParticipantRecords(participants, opts.scoring) : undefined;
  const results = participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const summary: Record<string, unknown> = {};
    for (const key of METRIC_KEYS) {
      const values = records
        .filter((r: TaskResultRecord) => r.status === 'success')
        .map((r: TaskResultRecord) => (r.data as Record<string, unknown> | undefined)?.[key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (values.length) summary[key] = computeStats(values);
    }
    const succeeded = records.filter((r) => r.status === 'success').length;
    const successRate = records.length ? succeeded / records.length : 0;
    const compositeScore = scores?.find((score) => score.provider === participant.participant)?.compositeScore ?? burstLegacyScore(records);
    return {
      provider: participant.participant,
      iterations: records.map((r) => ({ ...r.data, status: r.status })),
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
