import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchmarkScoringConfig, ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { scoreParticipantRecords } from '../src/util/scoring.js';
import {
  computeFilesystemSnapshotStats,
  writeFilesystemSnapshotResultsJson,
  SUITE_CONFIG,
} from './filesystem-snapshot.js';
import type {
  FilesystemSnapshotBenchmarkResult,
  FilesystemSnapshotWorkloadData,
  FilesystemSnapshotWorkloadFailure,
  FilesystemSnapshotWorkloadMeta,
  FilesystemSnapshotWorkloadResult,
} from './filesystem-snapshot.js';

function isWorkloadResult(data: unknown): data is FilesystemSnapshotWorkloadData {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === true && anyData.suite === 'filesystem-snapshot' && typeof anyData.metric?.value === 'number';
}

function isFailureResult(data: unknown): data is FilesystemSnapshotWorkloadFailure {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return anyData.ok === false && anyData.suite === 'filesystem-snapshot';
}

function isFlatResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  return typeof anyData.wallClockMs === 'number' || typeof anyData.createMs === 'number' || typeof anyData.provider === 'string';
}

function recordToWorkloadResult(record: TaskResultRecord): FilesystemSnapshotWorkloadResult | undefined {
  const data = record.data;
  if (!data || typeof data !== 'object') return undefined;
  const anyData = data as any;

  if (isWorkloadResult(anyData)) {
    return anyData as FilesystemSnapshotWorkloadData;
  }

  if (isFailureResult(anyData)) {
    return anyData as FilesystemSnapshotWorkloadResult;
  }

  if (anyData.skipped) {
    return undefined;
  }

  // @benchsdk/runner stores task results as flat metadata objects on record.data.
  // Wrap them in the workload shape the legacy serializer expects.
  if (isFlatResult(anyData)) {
    if (record.status === 'success' && !anyData.error && !anyData.snapshotError) {
      const metricValue = typeof anyData.wallClockMs === 'number' ? anyData.wallClockMs : record.latencyMs ?? 0;
      return {
        ok: true,
        suite: 'filesystem-snapshot',
        metric: { value: metricValue, unit: 'ms', higherIsBetter: false },
        meta: anyData as FilesystemSnapshotWorkloadMeta,
      } as FilesystemSnapshotWorkloadData;
    }

    const error = anyData.snapshotError || anyData.error || anyData.errorMessage || record.errorCode || 'unknown';
    return {
      ok: false,
      suite: 'filesystem-snapshot',
      reason: 'error',
      error: String(error),
      meta: anyData as FilesystemSnapshotWorkloadMeta,
    } as FilesystemSnapshotWorkloadFailure;
  }

  return undefined;
}

/** Map per-participant task records to legacy FilesystemSnapshotBenchmarkResult[]. */
export function recordsToFilesystemSnapshotResults(
  participants: ParticipantRecords[],
  scoring?: BenchmarkScoringConfig,
): FilesystemSnapshotBenchmarkResult[] {
  const scores = scoring ? scoreParticipantRecords(participants, scoring) : undefined;
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations: FilesystemSnapshotWorkloadResult[] = [];
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

    const summary = computeFilesystemSnapshotStats(iterations);
    const score = scores?.find((row) => row.provider === participant.participant);
    if (score) {
      summary.compositeScore = score.compositeScore;
      summary.successRate = score.successRate;
      summary.scoreBeforeReliability = score.successRate === 0 ? 0 : score.compositeScore / score.successRate;
      summary.tier = score.successRate === 0 ? 'fail' : 'pass';
    }
    const result: FilesystemSnapshotBenchmarkResult = {
      provider: participant.participant,
      suite: SUITE_CONFIG.id,
      mode: 'filesystem-snapshot',
      iterations,
      summary,
      wallClockMs,
      replicateMs,
      compositeScore: summary.compositeScore,
      tier: summary.tier,
      filesystemSupported: summary.filesystemSupported,
      snapshotSupported: summary.snapshotSupported,
    };

    if (iterations.length === 0) {
      result.skipped = true;
      if (!result.skipReason) result.skipReason = skipReason ?? 'no records';
    }

    return result;
  });
}

/**
 * Map records -> FilesystemSnapshotBenchmarkResult[] and write both `<YYYY-MM-DD>.json`
 * and `latest.json` into resultsDir, reusing the legacy serializer.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeFilesystemSnapshotLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; scoring?: BenchmarkScoringConfig },
): Promise<void> {
  const results = recordsToFilesystemSnapshotResults(participants, opts.scoring);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeFilesystemSnapshotResultsJson(results, outPath, opts.scoring !== undefined);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
