import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex, recordFailureMessage } from '../src/util/records.js';
import {
  computeSandboxFilesystemStats,
  writeSandboxFilesystemResultsJson,
  SUITE_CONFIG,
} from './sandbox-fs-api.js';
import type {
  SandboxFilesystemBenchmarkResult,
  SandboxFilesystemWorkloadData,
  SandboxFilesystemWorkloadFailure,
  SandboxFilesystemWorkloadMeta,
  SandboxFilesystemWorkloadResult,
} from './sandbox-fs-api.js';

function isWorkloadResult(data: unknown): data is SandboxFilesystemWorkloadData {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === true && anyData.suite === 'sandbox-fs-api' && typeof anyData.metric?.value === 'number';
}

function isFailureResult(data: unknown): data is SandboxFilesystemWorkloadFailure {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === false && anyData.suite === 'sandbox-fs-api';
}

function isFlatResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return typeof anyData.wallClockMs === 'number' || typeof anyData.createMs === 'number' || typeof anyData.provider === 'string';
}

function recordToWorkloadResult(record: TaskResultRecord): SandboxFilesystemWorkloadResult | undefined {
  const data = record.data;
  const failure = recordFailureMessage(record);
  if (!data || typeof data !== 'object') {
    return failure === undefined
      ? undefined
      : ({ ok: false, suite: 'sandbox-fs-api', reason: 'error', error: failure, meta: {} } as unknown as SandboxFilesystemWorkloadFailure);
  }
  const anyData = data as any;

  if (isWorkloadResult(anyData)) {
    return anyData as SandboxFilesystemWorkloadResult;
  }

  if (isFailureResult(anyData)) {
    return anyData as SandboxFilesystemWorkloadResult;
  }

  if (anyData.skipped) {
    return undefined;
  }

  // @benchsdk/runner stores task results as flat metadata objects on record.data.
  // Wrap them in the workload shape the legacy serializer expects.
  if (isFlatResult(anyData)) {
    if (record.status === 'success' && !anyData.error) {
      const metricValue = typeof anyData.rtMs === 'number'
        ? anyData.rtMs
        : typeof anyData.wallClockMs === 'number'
          ? anyData.wallClockMs
          : record.latencyMs ?? 0;
      return {
        ok: true,
        suite: 'sandbox-fs-api',
        metric: { value: metricValue, unit: 'ms', higherIsBetter: false },
        meta: anyData as SandboxFilesystemWorkloadMeta,
      } as SandboxFilesystemWorkloadData;
    }

    const error = anyData.error || anyData.errorMessage || record.errorCode || 'unknown';
    return {
      ok: false,
      suite: 'sandbox-fs-api',
      reason: 'error',
      error: String(error),
      meta: anyData as SandboxFilesystemWorkloadMeta,
    } as SandboxFilesystemWorkloadFailure;
  }

  if (failure !== undefined && !anyData.skipped) {
    return {
      ok: false,
      suite: 'sandbox-fs-api',
      reason: 'error',
      error: failure,
      meta: anyData as SandboxFilesystemWorkloadMeta,
    } as SandboxFilesystemWorkloadFailure;
  }

  return undefined;
}

/** Map per-participant task records to legacy SandboxFilesystemBenchmarkResult[]. */
export function recordsToSandboxFilesystemResults(participants: ParticipantRecords[]): SandboxFilesystemBenchmarkResult[] {
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations: SandboxFilesystemWorkloadResult[] = [];
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
        ok: false as const, suite: 'sandbox-fs-api' as const, reason: 'error' as const,
        error: recordFailureMessage(record) ?? 'missing workload evidence', meta: {},
      };
      iterations.push({ ...workload, meta: { ...workload.meta, taskStatus: record.status } });
    }

    const summary = computeSandboxFilesystemStats(iterations);
    const result: SandboxFilesystemBenchmarkResult = {
      provider: participant.participant,
      suite: SUITE_CONFIG.id,
      mode: 'sandbox-fs-api',
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
 * Map records -> SandboxFilesystemBenchmarkResult[] and write both `<YYYY-MM-DD>.json`
 * and `latest.json` into resultsDir, reusing the legacy serializer.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeSandboxFilesystemLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string },
): Promise<void> {
  const results = recordsToSandboxFilesystemResults(participants);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeSandboxFilesystemResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
