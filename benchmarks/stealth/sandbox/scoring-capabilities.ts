import { computeStats } from '../src/util/stats.js';

/** 2× p90 provider medians at the v1 November 2026 calibration. */
export const TTI_MEDIAN_CEILING_MS = 8_000;
export const TTI_MAX_CEILING_MS = 8_000;
export const DESTROY_CEILING_MS = 2_000;

/** The legacy exporters use the runner's 0.05 trim and 0.01 score precision. */
type ScoredRecord = { status: string; data?: Record<string, unknown> | null };

export function medianOfCompleted(records: readonly ScoredRecord[], key: string): number | undefined {
  const samples = records
    .filter((record) => record.status === 'success')
    .map((record) => record.data?.[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return samples.length ? computeStats(samples).median : undefined;
}

export function completedRate(records: readonly ScoredRecord[], requiredData?: string): number {
  if (records.length === 0) return 0;
  return records.filter((record) => record.status === 'success' &&
    (requiredData === undefined || record.data?.[requiredData] === true)).length / records.length;
}

export function roundRunnerScore(score: number): number {
  return Math.round(score * 100) / 100;
}

/** Mirror the v1 scoring manifest. Missing metrics have no contribution. */
export function burstLegacyScore(records: readonly ScoredRecord[]): number {
  const alive = medianOfCompleted(records, 'alivePct');
  const speed = (key: string, ceiling: number): number => {
    const median = medianOfCompleted(records, key);
    return median === undefined ? 0 : Math.max(0, 100 * (1 - median / ceiling));
  };
  return roundRunnerScore(completedRate(records) * (
    0.85 * (alive === undefined ? 0 : Math.min(100, Math.max(0, alive))) +
    0.08 * speed('ttiMaxMs', TTI_MAX_CEILING_MS) +
    0.05 * speed('ttiMedianMs', TTI_MEDIAN_CEILING_MS) +
    0.02 * speed('destroyMs', DESTROY_CEILING_MS)
  ));
}

/** Mirror the v1 measured:true gate; percentages remain pass/fail coverage. */
export function soakLegacyScore(records: readonly ScoredRecord[]): number {
  const uptime = medianOfCompleted(records, 'uptimePct');
  const integrity = medianOfCompleted(records, 'integrityPct');
  return roundRunnerScore(completedRate(records, 'measured') * (
    0.7 * (uptime === undefined ? 0 : Math.min(100, Math.max(0, uptime))) +
    0.3 * (integrity === undefined ? 0 : Math.min(100, Math.max(0, integrity)))
  ));
}
