/**
 * fidelity suite: same create -> snapshot -> destroy -> downtime -> restore
 * lifecycle as `snapshot`, but the payload is a set of state types whose
 * survival is verified independently — file content, exec bits, symlinks,
 * point-in-time isolation — plus informational checks for tmpfs inclusion,
 * rootfs capture (installed package), and process (memory) survival.
 */
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import {
  writeSuiteLegacyResults,
  type SuiteSpec,
  type WorkloadResult,
} from '../src/util/suite.js';
import { DEFAULT_DOWNTIME_MS } from '../src/util/snapshot.js';

export const SUITE_CONFIG = {
  id: 'fidelity' as const,
  slug: 'sandbox-fidelity',
  name: 'Sandbox Fidelity',
  resultsDir: 'results/sandbox_fidelity',
  defaultIterations: 3,
  downtimeMs: DEFAULT_DOWNTIME_MS,
};

/**
 * Checks whose pass/fail rolls into `verifyPassed`. Informational checks
 * (tmpfs, package, processAlive) are recorded in meta but unscored: /tmp
 * exclusion is a legitimate snapshot boundary, npm may be unavailable, and
 * disk-only snapshots are the norm.
 */
export const SCORED_CHECKS = [
  'fileText',
  'fileLarge',
  'executable',
  'symlink',
  'isolationOverwrite',
  'isolationDelete',
] as const;

export const INFORMATIONAL_CHECKS = ['tmpfs', 'package', 'processAlive'] as const;

/** Scoring ceilings shared with the .bench.ts scoring config (2x p90 provider median, 2026-11); timeouts stay pass/fail. */
export const FIDELITY_CEILINGS_MS = { createMs: 1_500, snapshotCreateMs: 8_000, snapshotRestoreMs: 5_000, destroyMs: 400 } as const;

export const FIDELITY_SUITE: SuiteSpec = {
  id: SUITE_CONFIG.id,
  stageMetrics: [
    { key: 'createMs', ceiling: FIDELITY_CEILINGS_MS.createMs, weight: 0.1 },
    { key: 'snapshotCreateMs', ceiling: FIDELITY_CEILINGS_MS.snapshotCreateMs, weight: 0.35 },
    { key: 'snapshotRestoreMs', ceiling: FIDELITY_CEILINGS_MS.snapshotRestoreMs, weight: 0.45 },
    // downMs/populateMs/verifyMs are reported for observability but unscored.
    { key: 'downMs', ceiling: 15_000, weight: 0 },
    { key: 'populateMs', ceiling: 60_000, weight: 0 },
    { key: 'verifyMs', ceiling: 60_000, weight: 0 },
    { key: 'destroyMs', ceiling: FIDELITY_CEILINGS_MS.destroyMs, weight: 0.1 },
  ],
  pass: (meta) =>
    meta.snapshotSupported === true && !meta.snapshotError && meta.verifyPassed === true,
  flags: (iterations) => ({
    snapshotSupported: iterations.some(
      (i) => i.meta?.snapshotSupported === true && !i.meta?.snapshotError && i.meta?.verifyPassed === true,
    ),
    snapshotIsBoxIdentity: iterations.some((i) => i.meta?.snapshotIsBoxIdentity === true),
    // Fidelity rollup: best-scoring iteration's check pass counts, e.g. "6/6 scored, 2/3 info".
    fidelityChecks: (() => {
      const checks = iterations
        .map((i) => i.meta?.checks)
        .filter((c): c is Record<string, boolean | string> => c != null);
      if (checks.length === 0) return undefined;
      const latest = checks[checks.length - 1];
      const scored = SCORED_CHECKS.filter((k) => latest[k] === true).length;
      const info = INFORMATIONAL_CHECKS.filter((k) => latest[k] === true).length;
      return `${scored}/${SCORED_CHECKS.length} scored, ${info}/${INFORMATIONAL_CHECKS.length} info`;
    })(),
  }),
  configBlock: {
    mode: SUITE_CONFIG.id,
    unit: 'ms',
    higherIsBetter: false,
    downtimeMs: SUITE_CONFIG.downtimeMs,
  },
};

/** Bridge runner records -> results/<suite>/<date>.json + latest.json. */
export async function writeFidelityLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  return writeSuiteLegacyResults(FIDELITY_SUITE, participants, opts);
}

export type FidelityWorkloadResult = WorkloadResult;
