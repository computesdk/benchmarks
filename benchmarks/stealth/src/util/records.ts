import type { TaskResultRecord } from '@benchsdk/client';

/**
 * Platform records arrive in completion order, while the legacy result files
 * list iterations in launch order, so every legacy bridge orders records by
 * `taskIndex` before mapping them.
 */
export function byTaskIndex(records: TaskResultRecord[]): TaskResultRecord[] {
  return [...records].sort((a, b) => a.taskIndex - b.taskIndex);
}

/**
 * The real failure behind an errored record. A task that throws a plain
 * Error leaves only `{ errorMessage }` (plus measures) on record.data, which
 * no workload shape matches — without this the iteration is dropped and the
 * provider shows up as skipped 'no records' instead of its actual error.
 */
export function recordFailureMessage(record: TaskResultRecord): string | undefined {
  if (record.status === 'success') return undefined;
  const data = (record.data ?? {}) as Record<string, unknown>;
  const message =
    data.snapshotError ?? data.error ?? data.errorMessage ?? record.errorCode ?? record.status;
  return String(message || 'unknown');
}
