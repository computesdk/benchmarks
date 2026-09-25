import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/api';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { computeCompositeScores } from './scoring.js';
import { writeResultsJson } from './table.js';
import type { BenchmarkResult, BenchmarkMode } from './types.js';

/**
 * When a sandbox launch actually started. Prefer the `create` step, since a
 * staggered task is claimed (record.startedAt) before it sleeps out its ramp
 * delay; fall back to the record for tasks without steps.
 */
function launchedAtMs(record: TaskResultRecord): number | undefined {
  const iso = record.steps?.find((s) => s.name === 'create')?.startedAt ?? record.startedAt;
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Rebuilds the ramp/wall-clock fields the burst ('concurrent') and staggered
 * result shapes carry, from record timestamps. Returns undefined when the
 * records lack usable timings, so the caller can emit an untagged result
 * rather than a malformed one.
 */
function loadProfile(
  records: TaskResultRecord[],
): { wallClockMs: number; timeToFirstReadyMs: number; rampProfile: { launchedAt: number; readyAt: number; ttiMs: number }[] } | undefined {
  const timed = records
    .map((r) => ({ launched: launchedAtMs(r), ttiMs: typeof r.data?.ttiMs === 'number' ? r.data.ttiMs : undefined }))
    .filter((t): t is { launched: number; ttiMs: number } => t.launched !== undefined && t.ttiMs !== undefined);
  if (timed.length === 0) return undefined;

  const t0 = Math.min(...timed.map((t) => t.launched));
  const rampProfile = timed.map((t) => {
    const launchedAt = t.launched - t0;
    return { launchedAt, readyAt: launchedAt + t.ttiMs, ttiMs: t.ttiMs };
  });
  return {
    wallClockMs: Math.max(...rampProfile.map((p) => p.readyAt)),
    timeToFirstReadyMs: Math.min(...rampProfile.map((p) => p.readyAt)),
    rampProfile,
  };
}

/** Map CLI participant records to legacy sandbox BenchmarkResult[] (TTI domain). */
export function recordsToSandboxResults(
  participants: ParticipantRecords[],
  mode?: BenchmarkMode,
  staggerDelayMs?: number,
): BenchmarkResult[] {
  return participants.map((participant) => {
    const records = byTaskIndex(participant.records);
    const iterations = records.map((r) => {
      const ttiMs = typeof r.data?.ttiMs === 'number' ? r.data.ttiMs : undefined;
      return r.status === 'error'
        ? { error: r.errorCode ?? 'error' }
        : { ttiMs };
    });
    const successful = iterations.filter((i): i is { ttiMs: number } => !i.error && i.ttiMs != null);
    const summary = {
      ttiMs:
        successful.length > 0
          ? computeStats(successful.map((i) => i.ttiMs))
          : { median: 0, p95: 0, p99: 0 },
    };
    const base = { provider: participant.participant, iterations, summary };

    // 'concurrent' and 'staggered' results carry extra load-profile fields that
    // the writer and the SVG/README consumers dereference unconditionally, so
    // only tag a result with those modes when the profile could be rebuilt.
    const profile = mode === 'concurrent' || mode === 'staggered' ? loadProfile(records) : undefined;
    if (mode === 'concurrent' && profile) {
      return {
        ...base,
        mode,
        concurrency: records.length,
        wallClockMs: profile.wallClockMs,
        timeToFirstReadyMs: profile.timeToFirstReadyMs,
      };
    }
    if (mode === 'staggered' && profile) {
      return {
        ...base,
        mode,
        concurrency: records.length,
        staggerDelayMs: staggerDelayMs ?? 0,
        wallClockMs: profile.wallClockMs,
        timeToFirstReadyMs: profile.timeToFirstReadyMs,
        rampProfile: profile.rampProfile,
      };
    }
    // Falling through with a profile-carrying mode means the timings couldn't
    // be rebuilt, so drop the tag rather than let the writer's isConcurrent /
    // isStaggered branches dereference fields that aren't there.
    const dropMode = mode === 'concurrent' || mode === 'staggered';
    return { ...base, ...(mode && !dropMode ? { mode } : {}) };
  });
}

/**
 * Map records -> BenchmarkResult[], compute composite scores, and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeSandboxLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; mode?: BenchmarkMode; staggerDelayMs?: number },
): Promise<void> {
  const results = recordsToSandboxResults(participants, opts.mode, opts.staggerDelayMs);
  computeCompositeScores(results);

  const failedProviders = results
    .filter((r) => !r.skipped && r.successRate === 0)
    .map((r) => r.provider);
  if (failedProviders.length > 0) {
    throw new Error(
      `Sandbox TTI smoke test failed: the following providers had 0% success: ${failedProviders.join(', ')}`,
    );
  }

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
