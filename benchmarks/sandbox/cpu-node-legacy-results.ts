import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats, writeCpuNodeResultsJson, SUITE_CONFIG } from './cpu-node.js';
import type { CpuNodeBenchmarkResult, CpuNodeWorkloadResult } from './cpu-node.js';

/**
 * Unwrap one cpu-node task record into the single CpuNodeWorkloadResult it ran.
 * The bench file may attach either a full CpuNodeBenchmarkResult (with one
 * iteration) or the raw CpuNodeWorkloadResult.
 */
function recordToWorkloadResult(record: TaskResultRecord): CpuNodeWorkloadResult | undefined {
  const data = record.data;
  if (!data || typeof data !== 'object') return undefined;
  const anyData = data as any;

  if (Array.isArray(anyData.iterations) && anyData.iterations.length > 0) {
    return anyData.iterations[0] as CpuNodeWorkloadResult;
  }

  if (typeof anyData.ok === 'boolean' && anyData.suite === 'cpu-node') {
    return anyData as CpuNodeWorkloadResult;
  }

  return undefined;
}

/** Map per-participant task records to legacy cpu-node CpuNodeBenchmarkResult[]. */
export function recordsToCpuNodeResults(participants: ParticipantRecords[]): CpuNodeBenchmarkResult[] {
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations: CpuNodeWorkloadResult[] = [];
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

    const summary = computeStats(iterations, SUITE_CONFIG);
    const result: CpuNodeBenchmarkResult = {
      provider: participant.participant,
      suite: SUITE_CONFIG.id,
      mode: 'cpu-node',
      iterations,
      summary,
      wallClockMs,
      replicateMs,
      compositeScore: summary.compositeScore,
    };

    if (skipped && iterations.length === 0) {
      result.skipped = true;
      if (skipReason) result.skipReason = skipReason;
    }

    return result;
  });
}

/**
 * Map records -> CpuNodeBenchmarkResult[] and write both `<YYYY-MM-DD>.json`
 * and `latest.json` into resultsDir, reusing the legacy serializer so the
 * `results/cpu_node/` shape is preserved verbatim.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeCpuNodeLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string },
): Promise<void> {
  const results = recordsToCpuNodeResults(participants);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeCpuNodeResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
