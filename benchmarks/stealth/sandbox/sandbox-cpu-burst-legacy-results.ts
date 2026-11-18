import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex, recordFailureMessage } from '../src/util/records.js';
import { computeStats, writeCpuBurstResultsJson, SUITE_CONFIG } from './sandbox-cpu-burst.js';
import type { CpuBurstBenchmarkResult, CpuBurstWorkloadResult } from './sandbox-cpu-burst.js';

/**
 * Unwrap one cpu-burst task record into the single CpuBurstWorkloadResult it ran.
 * The bench file may attach either a full CpuBurstBenchmarkResult (with one
 * iteration) or the raw CpuBurstWorkloadResult.
 */
function recordToWorkloadResult(record: TaskResultRecord): CpuBurstWorkloadResult | undefined {
  const data = record.data;
  if (!data || typeof data !== 'object') return undefined;
  const anyData = data as any;

  if (Array.isArray(anyData.iterations) && anyData.iterations.length > 0) {
    return anyData.iterations[0] as CpuBurstWorkloadResult;
  }

  if (typeof anyData.ok === 'boolean' && anyData.suite === 'cpu-burst') {
    return anyData as CpuBurstWorkloadResult;
  }

  return undefined;
}

/** Map per-participant task records to legacy cpu-burst CpuBurstBenchmarkResult[]. */
export function recordsToCpuBurstResults(participants: ParticipantRecords[]): CpuBurstBenchmarkResult[] {
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations: CpuBurstWorkloadResult[] = [];
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
        ok: false as const, suite: 'cpu-burst' as const, reason: 'error' as const,
        error: recordFailureMessage(record) ?? 'missing workload evidence', meta: {},
      };
      if (workload) {
        const resourceMeta = data && typeof data === 'object'
          ? {
              resourceProfile: data.resourceProfile,
              resourceStatus: data.resourceStatus,
              resourceNote: data.resourceNote,
            }
          : {};
        iterations.push({
          ...workload,
          meta: { ...workload.meta, ...resourceMeta, taskStatus: record.status },
        });
      }
    }

    const summary = computeStats(iterations, SUITE_CONFIG);
    const result: CpuBurstBenchmarkResult = {
      provider: participant.participant,
      suite: SUITE_CONFIG.id,
      mode: 'cpu-burst',
      iterations,
      summary,
      wallClockMs,
      replicateMs,
      compositeScore: summary.compositeScore,
    };

    if (skipped && records.every(record => record.data?.skipped === true)) {
      result.skipped = true;
      if (skipReason) result.skipReason = skipReason;
    }

    return result;
  });
}

/**
 * Map records -> CpuBurstBenchmarkResult[] and write both `<YYYY-MM-DD>.json`
 * and `latest.json` into resultsDir, reusing the legacy serializer so the
 * `results/sandbox_cpu_burst/` shape is preserved verbatim, including `burstDetected`
 * and the burst-specific metrics stored in each iteration's meta.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeCpuBurstLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string },
): Promise<void> {
  const results = recordsToCpuBurstResults(participants);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeCpuBurstResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
