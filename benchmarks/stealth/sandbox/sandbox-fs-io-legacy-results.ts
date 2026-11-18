import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex, recordFailureMessage } from '../src/util/records.js';
import {
  computeFsIoStats,
  writeFsIoResultsJson,
  SUITE_CONFIG,
} from './sandbox-fs-io.js';
import type {
  FsIoBenchmarkResult,
  FsIoMode,
  FsIoWorkloadData,
  FsIoWorkloadFailure,
  FsIoWorkloadMeta,
  FsIoWorkloadResult,
} from './sandbox-fs-io.js';

function isWorkloadResult(data: unknown): data is FsIoWorkloadData {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === true && anyData.suite === 'fs-io' && typeof anyData.metric?.value === 'number';
}

function isFailureResult(data: unknown): data is FsIoWorkloadFailure {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === false && anyData.suite === 'fs-io';
}

function isFlatResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return typeof anyData.wallClockMs === 'number' || typeof anyData.totalMs === 'number';
}

function recordToWorkloadResult(record: TaskResultRecord): FsIoWorkloadResult | undefined {
  const data = record.data;
  if (!data || typeof data !== 'object') return undefined;
  const anyData = data as any;

  if (isWorkloadResult(anyData) || isFailureResult(anyData)) {
    return anyData as FsIoWorkloadResult;
  }

  if (anyData.skipped) return undefined;

  // @benchsdk/runner stores task results as flat metadata objects on
  // record.data. Wrap them in the workload shape the legacy serializer
  // expects.
  if (isFlatResult(anyData)) {
    if (record.status === 'success' && !anyData.error) {
      const metricValue = typeof anyData.totalMs === 'number'
        ? anyData.totalMs
        : typeof anyData.metric?.value === 'number'
          ? anyData.metric.value
          : Number.NaN;
      return {
        ok: true,
        suite: 'fs-io',
        metric: { value: metricValue, unit: 'ms', higherIsBetter: false },
        meta: anyData as FsIoWorkloadMeta,
      } as FsIoWorkloadData;
    }

    const error = anyData.error || anyData.errorMessage || record.errorCode || 'unknown';
    return {
      ok: false,
      suite: 'fs-io',
      reason: /timed? ?out/i.test(String(error)) ? 'timeout' : 'error',
      error: String(error),
      meta: anyData as FsIoWorkloadMeta,
    } as FsIoWorkloadFailure;
  }

  return undefined;
}

/** Map per-participant task records (already filtered to one mode) to FsIoBenchmarkResult[]. */
export function recordsToFsIoResults(
  participants: ParticipantRecords[],
  mode: FsIoMode,
): FsIoBenchmarkResult[] {
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations: FsIoWorkloadResult[] = [];
    const replicateMs: number[] = [];
    let wallClockMs = 0;
    let skipped = false;
    let skipReason: string | undefined;

    for (const record of records) {
      const data = record.data as any;
      if (data && typeof data === 'object') {
        if (data.skipped) {
          skipped = true;
          skipReason = data.skipReason;
        }
        if (Array.isArray(data.replicateMs)) {
          replicateMs.push(...(data.replicateMs as number[]));
        }
        if (typeof data.wallClockMs === 'number') {
          wallClockMs += data.wallClockMs;
        }
      }

      const workload = recordToWorkloadResult(record) ?? {
        ok: false as const, suite: 'fs-io' as const, reason: 'error' as const,
        error: recordFailureMessage(record) ?? 'missing workload evidence', meta: {},
      };
      iterations.push({ ...workload, meta: { ...workload.meta, taskStatus: record.status } });
    }

    const summary = computeFsIoStats(iterations);
    const result: FsIoBenchmarkResult = {
      provider: participant.participant,
      suite: SUITE_CONFIG.id,
      mode,
      iterations,
      summary,
      wallClockMs,
      replicateMs,
      compositeScore: summary.compositeScore,
    };

    if (iterations.length === 0 || (skipped && records.every(record => record.data?.skipped === true))) {
      result.skipped = true;
      if (!result.skipReason) result.skipReason = skipReason ?? 'no records';
    }

    return result;
  });
}

/**
 * Map records -> FsIoBenchmarkResult[] and write both `<YYYY-MM-DD>.json`
 * and `latest.json` into resultsDir, reusing the legacy serializer.
 * Returns the converted results so the caller can print them.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeFsIoLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; mode: FsIoMode },
): Promise<FsIoBenchmarkResult[]> {
  const results = recordsToFsIoResults(participants, opts.mode);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeFsIoResultsJson(results, outPath, opts.mode);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);

  return results;
}
