import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import {
  computeOsCapabilitiesStats,
  writeOsCapabilitiesResultsJson,
  SUITE_CONFIG,
} from './os-capabilities.js';
import type {
  OsCapabilitiesBenchmarkResult,
  OsCapabilitiesWorkloadData,
  OsCapabilitiesWorkloadFailure,
  OsCapabilitiesWorkloadMeta,
  OsCapabilitiesWorkloadResult,
} from './os-capabilities.js';

function isWorkloadResult(data: unknown): data is OsCapabilitiesWorkloadData {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === true && anyData.suite === 'os-capabilities' && typeof anyData.metric?.value === 'number';
}

function isFailureResult(data: unknown): data is OsCapabilitiesWorkloadFailure {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === false && anyData.suite === 'os-capabilities';
}

function isFlatResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return typeof anyData.wallClockMs === 'number' || typeof anyData.provider === 'string';
}

function recordToWorkloadResult(record: TaskResultRecord): OsCapabilitiesWorkloadResult | undefined {
  const data = record.data;
  if (!data || typeof data !== 'object') return undefined;
  const anyData = data as any;

  if (isWorkloadResult(anyData)) {
    return anyData as OsCapabilitiesWorkloadResult;
  }

  if (isFailureResult(anyData)) {
    return anyData as OsCapabilitiesWorkloadFailure;
  }

  if (anyData.skipped) {
    return undefined;
  }

  // @benchsdk/runner stores task results as flat metadata objects on record.data.
  // Wrap them in the workload shape the legacy serializer expects.
  if (isFlatResult(anyData)) {
    if (record.status === 'success' && !anyData.error) {
      const metricValue = typeof anyData.capabilityScore === 'number' ? anyData.capabilityScore : 0;
      return {
        ok: true,
        suite: 'os-capabilities',
        metric: { value: metricValue, unit: 'score', higherIsBetter: true },
        meta: anyData as OsCapabilitiesWorkloadMeta,
      } as OsCapabilitiesWorkloadData;
    }

    const error = anyData.error || anyData.errorMessage || record.errorCode || 'unknown';
    return {
      ok: false,
      suite: 'os-capabilities',
      reason: 'error',
      error: String(error),
      meta: anyData as OsCapabilitiesWorkloadMeta,
    } as OsCapabilitiesWorkloadFailure;
  }

  return undefined;
}

/** Map per-participant task records to legacy OsCapabilitiesBenchmarkResult[]. */
export function recordsToOsCapabilitiesResults(participants: ParticipantRecords[]): OsCapabilitiesBenchmarkResult[] {
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations: OsCapabilitiesWorkloadResult[] = [];
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
          continue;
        }
        if (Array.isArray(data.replicateMs)) {
          replicateMs.push(...(data.replicateMs as number[]));
        }
        if (typeof data.wallClockMs === 'number') {
          wallClockMs += data.wallClockMs;
        }
      }

      const workload = recordToWorkloadResult(record);
      if (workload) iterations.push(workload);
    }

    const summary = computeOsCapabilitiesStats(iterations);
    const result: OsCapabilitiesBenchmarkResult = {
      provider: participant.participant,
      suite: SUITE_CONFIG.id,
      mode: 'os-capabilities',
      iterations,
      summary,
      wallClockMs,
      replicateMs,
      compositeScore: summary.compositeScore,
    };

    if (iterations.length === 0) {
      result.skipped = true;
      if (!result.skipReason) result.skipReason = skipReason ?? 'no records';
    }

    return result;
  });
}

/**
 * Map records -> OsCapabilitiesBenchmarkResult[] and write both `<YYYY-MM-DD>.json`
 * and `latest.json` into resultsDir, reusing the legacy serializer.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeOsCapabilitiesLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string },
): Promise<void> {
  const results = recordsToOsCapabilitiesResults(participants);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeOsCapabilitiesResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
