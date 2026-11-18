/**
 * pause/resume suite: create -> write marker -> pause the running box ->
 * resume the same box -> verify marker + box identity. The headline metrics
 * are `pauseMs` and `resumeMs`.
 */
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import {
  writeSuiteLegacyResults,
  type SuiteSpec,
  type WorkloadResult,
} from '../src/util/suite.js';

export const SUITE_CONFIG = {
  id: 'pause-resume' as const,
  slug: 'sandbox-pause-resume',
  name: 'Sandbox Pause Resume',
  resultsDir: 'results/sandbox_pause_resume',
  defaultIterations: 3,
  pauseWaitMs: 0,
};

/** Scoring ceilings shared with the .bench.ts scoring config (2x p90 provider median, 2026-11); timeouts stay pass/fail. */
export const PAUSE_RESUME_CEILINGS_MS = { createMs: 4_000, pauseMs: 15_000, resumeMs: 5_000, destroyMs: 2_500 } as const;

export const PAUSE_RESUME_SUITE: SuiteSpec = {
  id: SUITE_CONFIG.id,
  stageMetrics: [
    { key: 'createMs', ceiling: PAUSE_RESUME_CEILINGS_MS.createMs, weight: 0.1 },
    { key: 'pauseMs', ceiling: PAUSE_RESUME_CEILINGS_MS.pauseMs, weight: 0.35 },
    { key: 'resumeMs', ceiling: PAUSE_RESUME_CEILINGS_MS.resumeMs, weight: 0.45 },
    // populateMs/verifyMs are reported for observability but unscored.
    { key: 'populateMs', ceiling: 60_000, weight: 0 },
    { key: 'verifyMs', ceiling: 60_000, weight: 0 },
    { key: 'destroyMs', ceiling: PAUSE_RESUME_CEILINGS_MS.destroyMs, weight: 0.1 },
  ],
  pass: (meta) =>
    meta.pauseSupported === true && !meta.pauseError && meta.verifyPassed === true,
  flags: (iterations) => ({
    pauseSupported: iterations.some(
      (i) => i.meta?.pauseSupported === true && !i.meta?.pauseError && i.meta?.verifyPassed === true,
    ),
    pauseModel:
      iterations.find((i) => typeof i.meta?.pauseModel === 'string')?.meta?.pauseModel ?? 'none',
    sameBox: iterations.some((i) => i.meta?.sameBox === true),
  }),
  configBlock: {
    mode: SUITE_CONFIG.id,
    unit: 'ms',
    higherIsBetter: false,
    pauseWaitMs: SUITE_CONFIG.pauseWaitMs,
  },
};

/** Bridge runner records -> results/<suite>/<date>.json + latest.json. */
export async function writePauseResumeLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  return writeSuiteLegacyResults(PAUSE_RESUME_SUITE, participants, opts);
}

export type PauseResumeWorkloadResult = WorkloadResult;
