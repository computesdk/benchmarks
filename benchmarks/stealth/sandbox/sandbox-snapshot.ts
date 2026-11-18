/**
 * snapshot suite: create -> write marker -> snapshot.create -> destroy source
 * -> downtime -> restore -> verify marker. The headline metrics are
 * `snapshotCreateMs` and `snapshotRestoreMs`.
 */
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import {
  writeSuiteLegacyResults,
  type SuiteSpec,
  type WorkloadResult,
} from '../src/util/suite.js';
import { DEFAULT_DOWNTIME_MS } from '../src/util/snapshot.js';

export const SUITE_CONFIG = {
  id: 'snapshot' as const,
  slug: 'sandbox-snapshot',
  name: 'Sandbox Snapshot',
  resultsDir: 'results/sandbox_snapshot',
  defaultIterations: 3,
  downtimeMs: DEFAULT_DOWNTIME_MS,
};

/** Scoring ceilings shared with the .bench.ts scoring config (2x p90 provider median, 2026-11); timeouts stay pass/fail. */
export const SNAPSHOT_CEILINGS_MS = { createMs: 2_500, snapshotCreateMs: 10_000, snapshotRestoreMs: 5_000, destroyMs: 2_000 } as const;

export const SNAPSHOT_SUITE: SuiteSpec = {
  id: SUITE_CONFIG.id,
  stageMetrics: [
    { key: 'createMs', ceiling: SNAPSHOT_CEILINGS_MS.createMs, weight: 0.1 },
    { key: 'snapshotCreateMs', ceiling: SNAPSHOT_CEILINGS_MS.snapshotCreateMs, weight: 0.35 },
    { key: 'snapshotRestoreMs', ceiling: SNAPSHOT_CEILINGS_MS.snapshotRestoreMs, weight: 0.45 },
    // downMs/populateMs/verifyMs are reported for observability but unscored.
    { key: 'downMs', ceiling: 15_000, weight: 0 },
    { key: 'populateMs', ceiling: 60_000, weight: 0 },
    { key: 'verifyMs', ceiling: 60_000, weight: 0 },
    { key: 'destroyMs', ceiling: SNAPSHOT_CEILINGS_MS.destroyMs, weight: 0.1 },
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
    downtimeMs: SUITE_CONFIG.downtimeMs,
  },
};

/** Bridge runner records -> results/<suite>/<date>.json + latest.json. */
export async function writeSnapshotLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  return writeSuiteLegacyResults(SNAPSHOT_SUITE, participants, opts);
}

export type SnapshotWorkloadResult = WorkloadResult;
