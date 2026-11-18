/**
 * snapshot-fanout suite: create -> write marker -> snapshot.create -> destroy
 * source -> restore FANOUT_COUNT boxes concurrently -> verify the marker on
 * every clone. The headline metrics are `restoreMaxMs` (the worst fanned box)
 * and `fanoutWallClockMs` (launch -> all boxes verified).
 */
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import {
  writeSuiteLegacyResults,
  type SuiteSpec,
  type WorkloadResult,
} from '../src/util/suite.js';

export const DEFAULT_FANOUT_COUNT = 5;

export const SUITE_CONFIG = {
  id: 'snapshot-fanout' as const,
  slug: 'sandbox-snapshot-fanout',
  name: 'Sandbox Snapshot Fanout',
  resultsDir: 'results/sandbox_snapshot_fanout',
  defaultIterations: 3,
  fanoutCount: DEFAULT_FANOUT_COUNT,
};

/** Scoring ceilings shared with the .bench.ts scoring config (2x p90 provider median, 2026-11); timeouts stay pass/fail. */
export const SNAPSHOT_FANOUT_CEILINGS_MS = { createMs: 2_500, snapshotCreateMs: 10_000, restoreMaxMs: 5_000, fanoutWallClockMs: 10_000, destroyMs: 3_000 } as const;

export const SNAPSHOT_FANOUT_SUITE: SuiteSpec = {
  id: SUITE_CONFIG.id,
  stageMetrics: [
    { key: 'createMs', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.createMs, weight: 0.05 },
    { key: 'snapshotCreateMs', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.snapshotCreateMs, weight: 0.2 },
    { key: 'restoreMaxMs', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.restoreMaxMs, weight: 0.35 },
    { key: 'fanoutWallClockMs', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.fanoutWallClockMs, weight: 0.3 },
    // downMs/populateMs are reported for observability but unscored.
    { key: 'downMs', ceiling: 15_000, weight: 0 },
    { key: 'populateMs', ceiling: 60_000, weight: 0 },
    { key: 'destroyMs', ceiling: SNAPSHOT_FANOUT_CEILINGS_MS.destroyMs, weight: 0.1 },
  ],
  pass: (meta) =>
    meta.snapshotSupported === true && !meta.snapshotError && meta.verifyPassed === true,
  flags: (iterations) => ({
    snapshotSupported: iterations.some(
      (i) => i.meta?.snapshotSupported === true && !i.meta?.snapshotError && i.meta?.verifyPassed === true,
    ),
    snapshotIsBoxIdentity: iterations.some((i) => i.meta?.snapshotIsBoxIdentity === true),
  }),
  configBlock: {
    mode: SUITE_CONFIG.id,
    unit: 'ms',
    higherIsBetter: false,
    fanoutCount: SUITE_CONFIG.fanoutCount,
  },
};

/** Bridge runner records -> results/<suite>/<date>.json + latest.json. */
export async function writeSnapshotFanoutLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  return writeSuiteLegacyResults(SNAPSHOT_FANOUT_SUITE, participants, opts);
}

export type SnapshotFanoutWorkloadResult = WorkloadResult;
