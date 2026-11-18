import type { BenchmarkScoringConfig } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { scoreParticipantRecords } from '../src/util/scoring.js';

/** Structural extension until the compatible runner release ships. */
export type ContinuousScoring = Omit<BenchmarkScoringConfig, 'metrics'> & {
  precision: 'full';
  metrics: (BenchmarkScoringConfig['metrics'][number] & {
    transform?: { kind: 'reciprocal'; reference: number };
  })[];
};

export function continuousScoring(config: BenchmarkScoringConfig, references: Record<string, number> = {}): ContinuousScoring {
  return { ...config, precision: 'full', metrics: config.metrics.map(metric => {
    const reference = references[metric.key];
    if (reference === undefined) return metric;
    if (!Number.isFinite(reference) || reference <= 0) throw new Error(`Invalid reference for ${metric.key}`);
    return { ...metric, transform: { kind: 'reciprocal' as const, reference } };
  }) };
}

/** Use the actual runner for exporters too: no second percentile/gate formula.
 * Overall rows deliberately aggregate raw records, rather than averaging groups. */
export function runtimeRecordScore(records: TaskResultRecord[], config: BenchmarkScoringConfig) {
  return scoreParticipantRecords([{ participant: 'legacy', records }], { ...config, groupBy: undefined })[0];
}

export const CPU_BURST_SCORING = continuousScoring({ metrics: [
  { key: 'cpuBurstScore', ceiling: 100, higherIsBetter: true, weights: { median: 1, p95: 0, p99: 0 } },
] });
export const FS_API_SCORING = continuousScoring({ success: { requireData: { verified: true } }, metrics: [
  { key: 'rankScore', ceiling: 200, higherIsBetter: true, weights: { median: 0, p95: 0, p99: 1 } },
] });
export const FS_IO_SCORING = continuousScoring({ success: { requireData: { verified: true } }, metrics: [
  { key: 'totalMs', ceiling: 8000, weights: { median: 0.7, p95: 0.2, p99: 0.1 } },
] }, { totalMs: 8000 });

/** Task status survives legacy serialization and matrix recomputation. Do not
 * omit errors without recognizable workload payloads from the denominator. */
export function iterationRecord(iteration: { ok: boolean; meta: object }, data: Record<string, unknown>): TaskResultRecord {
  return { status: (iteration.meta as { taskStatus?: string }).taskStatus ?? (iteration.ok ? 'success' : 'error'), data } as TaskResultRecord;
}
