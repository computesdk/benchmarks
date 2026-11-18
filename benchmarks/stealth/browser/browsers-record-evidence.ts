import type { TaskResultRecord } from '@benchsdk/client';

/**
 * Additive raw evidence for private browser legacy artifacts. Keep iterations[]
 * for existing readers; new scoring comparisons must use status-bearing
 * records[] rather than guessing status from a measurement or resume flag.
 * This helper does not score, ingest, or rewrite any historical result.
 */
export function browserRecordEvidence(records: readonly TaskResultRecord[]) {
  return records.map((record) => ({
    taskIndex: record.taskIndex,
    status: record.status,
    data: record.data,
    ...(record.latencyMs !== undefined ? { latencyMs: record.latencyMs } : {}),
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
  }));
}
