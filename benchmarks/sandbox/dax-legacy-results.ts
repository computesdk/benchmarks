import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject, TaskResultRecord } from '@benchsdk/api';
import { byTaskIndex } from '../src/util/records.js';
import { summarize, emptySummary, writeDaxResultsJson } from './dax.js';
import type { DaxBenchmarkResult, DaxTimingResult } from './dax.js';

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Reconstruct one legacy `DaxTimingResult` from a task record. The dax task
 * stores the whole timing object in `record.data` (phase timings, disk usage,
 * meta, and — on failure — the error message), so reconstruction is a direct
 * field read. Records whose data carries no `totalMs` (e.g. a sandbox-create
 * failure) collapse to the legacy `{ totalMs: 0, error }` shape.
 */
function recordToDaxTiming(r: TaskResultRecord): DaxTimingResult {
  const d = (r.data ?? {}) as JsonObject;
  const totalMs = num(d.totalMs);

  if (r.status === 'error' && totalMs === undefined) {
    return {
      totalMs: 0,
      error: str(d.error) ?? str(d.errorMessage) ?? r.errorCode ?? 'error',
    };
  }

  const timing: DaxTimingResult = { totalMs: totalMs ?? 0 };
  const bag = timing as unknown as Record<string, unknown>;
  const copyNum = (key: keyof DaxTimingResult) => {
    const v = num(d[key as string]);
    if (v !== undefined) bag[key as string] = v;
  };
  const copyStr = (key: keyof DaxTimingResult) => {
    const v = str(d[key as string]);
    if (v !== undefined) bag[key as string] = v;
  };

  (
    [
      'phasesCompleted',
      'phasesTotal',
      'prepareMs',
      'cacheClearMs',
      'bunDownloadMs',
      'bunUnpackMs',
      'cloneMs',
      'installMs',
      'typecheckMs',
      'diskAfterClone',
      'diskAfterInstall',
      'diskAfterTypecheck',
    ] as (keyof DaxTimingResult)[]
  ).forEach(copyNum);

  (['commit', 'bunVersion', 'nodeVersion', 'architecture', 'kernel', 'logicalCpus', 'cpuModel', 'memoryKib'] as (keyof DaxTimingResult)[]).forEach(
    copyStr,
  );

  const error = str(d.error);
  if (error) timing.error = error;

  return timing;
}

/** Map CLI participant records to legacy dax `DaxBenchmarkResult[]`. */
export function recordsToDaxResults(participants: ParticipantRecords[]): DaxBenchmarkResult[] {
  return participants.map((participant) => {
    const iterations = byTaskIndex(participant.records).map(recordToDaxTiming);
    const successful = iterations.filter((r) => !r.error);
    const withTiming = iterations.filter((r) => r.totalMs > 0 && (r.phasesCompleted ?? 0) > 0);
    return {
      provider: participant.participant,
      mode: 'sandbox-dax' as const,
      iterations,
      summary: withTiming.length > 0 ? summarize(withTiming) : emptySummary(),
      successRate: iterations.length > 0 ? successful.length / iterations.length : 0,
    };
  });
}

/**
 * Map records -> DaxBenchmarkResult[] and write both `<YYYY-MM-DD>.json` and
 * `latest.json` into resultsDir, reusing the legacy serializer so the
 * `results/sandbox-dax/` shape is preserved verbatim.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeDaxLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string },
): Promise<void> {
  const results = recordsToDaxResults(participants);

  const failedProviders = results
    .filter((r) => !r.skipped && r.successRate === 0)
    .map((r) => r.provider);
  if (failedProviders.length > 0) {
    throw new Error(
      `Sandbox DAX smoke test failed: the following providers had 0% success: ${failedProviders.join(', ')}`,
    );
  }

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeDaxResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
