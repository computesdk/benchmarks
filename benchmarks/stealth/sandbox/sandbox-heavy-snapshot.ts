/**
 * heavy-snapshot suite: create -> load GBs of disk + dirty memory ->
 * snapshot.create -> destroy source -> downtime -> restore -> verify.
 * The headline metrics are `snapshotCreateMs` and `snapshotRestoreMs` on a
 * heavy box — how providers handle long-horizon workloads whose environments
 * have grown to GBs of state.
 */
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import {
  writeSuiteLegacyResults,
  type SuiteSpec,
  type WorkloadResult,
} from '../src/util/suite.js';
import { DEFAULT_DOWNTIME_MS } from '../src/util/snapshot.js';

export const SUITE_CONFIG = {
  id: 'heavy-snapshot' as const,
  slug: 'sandbox-heavy-snapshot',
  name: 'Sandbox Heavy Snapshot',
  resultsDir: 'results/sandbox_heavy_snapshot',
  // Heavy runs cost GBs of snapshot storage per iteration; one is the default.
  defaultIterations: 1,
  downtimeMs: DEFAULT_DOWNTIME_MS,
};

/** Heavy load knobs (env-overridable via BENCH_HEAVY_*). */
export const HEAVY_CONFIG = {
  /** Total incompressible data written to disk before snapshotting. */
  diskMb: 2048,
  /** Resident memory a detached guest process dirties before the snapshot. */
  memMb: 1024,
  /** In-guest populate budget (dd + sha256 manifest + mem allocation). */
  populateTimeoutMs: 15 * 60_000,
  /** Restore of a multi-GB snapshot can far exceed the 120s create timeout. */
  restoreTimeoutMs: 15 * 60_000,
};

export function resolveHeavyDiskMb(): number {
  const n = Number(process.env.BENCH_HEAVY_DISK_MB);
  return Number.isFinite(n) && n >= 0 ? n : HEAVY_CONFIG.diskMb;
}

export function resolveHeavyMemMb(): number {
  const n = Number(process.env.BENCH_HEAVY_MEM_MB);
  return Number.isFinite(n) && n >= 0 ? n : HEAVY_CONFIG.memMb;
}

export function resolveHeavyPopulateTimeoutMs(): number {
  const n = Number(process.env.BENCH_HEAVY_POPULATE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : HEAVY_CONFIG.populateTimeoutMs;
}

export function resolveHeavyRestoreTimeoutMs(): number {
  const n = Number(process.env.BENCH_HEAVY_RESTORE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : HEAVY_CONFIG.restoreTimeoutMs;
}

/** Loose ceilings until real heavy-run medians land (unscored metrics are observability only). */
export const HEAVY_SNAPSHOT_CEILINGS_MS = {
  createMs: 30_000,
  snapshotCreateMs: 300_000,
  snapshotRestoreMs: 180_000,
  destroyMs: 15_000,
} as const;

export const HEAVY_SNAPSHOT_SUITE: SuiteSpec = {
  id: SUITE_CONFIG.id,
  stageMetrics: [
    { key: 'createMs', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.createMs, weight: 0.1 },
    { key: 'snapshotCreateMs', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.snapshotCreateMs, weight: 0.35 },
    { key: 'snapshotRestoreMs', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.snapshotRestoreMs, weight: 0.45 },
    // populateMs/downMs/verifyMs are reported for observability but unscored.
    { key: 'downMs', ceiling: 60_000, weight: 0 },
    { key: 'populateMs', ceiling: HEAVY_CONFIG.populateTimeoutMs, weight: 0 },
    { key: 'verifyMs', ceiling: 300_000, weight: 0 },
    { key: 'destroyMs', ceiling: HEAVY_SNAPSHOT_CEILINGS_MS.destroyMs, weight: 0.1 },
  ],
  pass: (meta) =>
    meta.snapshotSupported === true && !meta.snapshotError && meta.verifyPassed === true,
  flags: (iterations) => ({
    snapshotSupported: iterations.some(
      (i) => i.meta?.snapshotSupported === true && !i.meta?.snapshotError && i.meta?.verifyPassed === true,
    ),
    snapshotIsBoxIdentity: iterations.some((i) => i.meta?.snapshotIsBoxIdentity === true),
    memoryPersisted: iterations.some((i) => i.meta?.memoryPersisted === true),
  }),
  configBlock: {
    mode: SUITE_CONFIG.id,
    unit: 'ms',
    higherIsBetter: false,
    downtimeMs: SUITE_CONFIG.downtimeMs,
    heavyDiskMb: HEAVY_CONFIG.diskMb,
    heavyMemMb: HEAVY_CONFIG.memMb,
  },
};

/** Bridge runner records -> results/<suite>/<date>.json + latest.json. */
export async function writeHeavySnapshotLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  return writeSuiteLegacyResults(HEAVY_SNAPSHOT_SUITE, participants, opts);
}

export type HeavySnapshotWorkloadResult = WorkloadResult;
