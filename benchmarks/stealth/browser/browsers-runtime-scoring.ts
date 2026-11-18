import { continuousScoring, runtimeRecordScore } from '../sandbox/performance-runtime-scoring.js';
import type { TaskResultRecord } from '@benchsdk/client';

// Capability metrics deliberately keep the existing trimmed-median semantics.
// Only continuous speed dimensions select the reciprocal transform.
export const IDLE_SCORING = continuousScoring({ groupBy: 'phase', metrics: [
  ...Object.entries({ resume10s: 0.1, resume30s: 0.15, resume60s: 0.25, resume300s: 0.3 }).map(([key, weight]) =>
    ({ key, ceiling: 1, higherIsBetter: true, weights: { median: weight, p95: 0, p99: 0 } })),
  { key: 'reconnectMs', ceiling: 2000, weights: { median: 0.15, p95: 0.05, p99: 0 } },
] }, { reconnectMs: 2000 });
export const SESSION_SCORING = continuousScoring({ success: { requireData: { resumeSupported: 1 } }, metrics: [
  { key: 'reconnectMs', ceiling: 2000, weights: { median: 0.35, p95: 0.1, p99: 0.05 } },
  { key: 'totalMs', ceiling: 5000, weights: { median: 0.2, p95: 0, p99: 0 } },
  ...['cookiesPreserved', 'storagePreserved', 'tabsPreserved'].map(key =>
    ({ key, ceiling: 1, higherIsBetter: true, weights: { median: 0.1, p95: 0, p99: 0 } })),
] }, { reconnectMs: 2000, totalMs: 5000 });
export const PROTECTED_SCORING = continuousScoring({ groupBy: 'phase', success: { requireData: { passed: 1 } }, metrics: [
  { key: 'passed', ceiling: 1, higherIsBetter: true, weights: { median: 0.7, p95: 0, p99: 0 } },
  { key: 'timeToPassMs', ceiling: 120000, weights: { median: 0.2, p95: 0.05, p99: 0.05 } },
] }, { timeToPassMs: 120000 });
export const TRANSFER_SCORING = continuousScoring({ success: { requireData: { benchCompleted: 1 } }, metrics: [
  { key: 'compositeScore', ceiling: 100, higherIsBetter: true, weights: { median: 1, p95: 0, p99: 0 } },
] });

/** Fixed budget per direction: verified support earns 35 and measured speed
 * earns up to 15. A supported but corrupt transfer earns no points. */
export function fileTransferPoints(data: Record<string, unknown>): number {
  let points = 0;
  for (const direction of ['download', 'upload']) {
    const supported = data[`${direction}Supported`];
    const match = data[`${direction}Match`];
    if (supported !== 0 && supported !== 1) throw new Error(`Missing ${direction} support evidence`);
    if (supported !== 1) continue;
    if (match !== 0 && match !== 1) throw new Error(`Missing ${direction} verification evidence`);
    if (match !== 1) continue;
    const ms = data[`${direction}Ms`];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error(`Invalid ${direction} timing`);
    points += 35 + 15 / (1 + ms / 30000);
  }
  return points;
}

export function scoreBrowserRecords(kind: 'idle' | 'session' | 'protected' | 'transfer', records: TaskResultRecord[]): number {
  return runtimeRecordScore(records, { idle: IDLE_SCORING, session: SESSION_SCORING,
    protected: PROTECTED_SCORING, transfer: TRANSFER_SCORING }[kind])?.compositeScore ?? 0;
}
