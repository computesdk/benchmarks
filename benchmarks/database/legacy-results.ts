import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { computeDatabaseCompositeScores } from './scoring.js';
import { writeDatabaseResultsJson } from './benchmark.js';
import type {
  DatabaseBenchmarkResult,
  DatabaseProviderConfig,
  DatabaseTimingResult,
} from './types.js';

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function recordsToDatabaseResults(
  participants: ParticipantRecords[],
  opts: { payloadBytes: number; providers: DatabaseProviderConfig[] },
): DatabaseBenchmarkResult[] {
  return participants.map((participant) => {
    const provider = opts.providers.find((p) => p.name === participant.participant);
    const iterations = byTaskIndex(participant.records).map((record): DatabaseTimingResult => {
      const data = (record.data ?? {}) as JsonObject;
      const base = {
        createMs: num(data.createMs),
        readMs: num(data.readMs),
        updateMs: num(data.updateMs),
        readAfterUpdateMs: num(data.readAfterUpdateMs),
        deleteMs: num(data.deleteMs),
        totalMs: num(data.totalMs),
        payloadBytes: num(data.payloadBytes) || opts.payloadBytes,
      };
      return record.status === 'error'
        ? { ...base, error: record.errorCode ?? 'error' }
        : base;
    });
    const successful = iterations.filter((iteration) => !iteration.error);
    const summary = {
      createMs: computeStats(successful.map((i) => i.createMs)),
      readMs: computeStats(successful.map((i) => i.readMs)),
      updateMs: computeStats(successful.map((i) => i.updateMs)),
      readAfterUpdateMs: computeStats(successful.map((i) => i.readAfterUpdateMs)),
      deleteMs: computeStats(successful.map((i) => i.deleteMs)),
      totalMs: computeStats(successful.map((i) => i.totalMs)),
    };
    return {
      provider: participant.participant,
      mode: 'database',
      table: provider?.table ?? 'benchmark_crud',
      payloadBytes: opts.payloadBytes,
      iterations,
      summary,
    };
  });
}

/**
 * Map records -> database results and write the dated and latest files.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeDatabaseLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; providers: DatabaseProviderConfig[]; payloadBytes: number },
): Promise<void> {
  const results = recordsToDatabaseResults(participants, opts);
  computeDatabaseCompositeScores(results);
  mkdirSync(opts.resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeDatabaseResultsJson(results, outPath);
  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
