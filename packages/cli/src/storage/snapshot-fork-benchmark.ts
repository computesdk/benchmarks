import crypto from 'crypto';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../util/timeout.js';
import { formatError } from '../util/error.js';
import { round, roundStats, computeStats } from './stats.js';
import type { StorageProviderConfig } from './types.js';
import {
  DATASET_PRESETS,
  type DatasetPreset,
  type DatasetSpec,
  type SnapshotForkBenchmarkResult,
  type SnapshotForkTimingResult,
} from './snapshot-fork-types.js';

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/** Best-effort cleanup that never throws — logs and swallows. */
async function safeCleanup(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await withTimeout(Promise.resolve(fn()), 30000, `${label} timed out`);
  } catch (err) {
    console.warn(`    [cleanup] ${label} failed: ${formatError(err)}`);
  }
}

/**
 * Run one snapshot/fork iteration:
 *   seed dataset -> snapshot -> fork(from snapshot) -> fork(from live) ->
 *   read-back-from-fork (verify) -> teardown.
 *
 * Every created resource (objects, snapshot, both forks) is torn down in a
 * `finally` so a failure mid-iteration does not leak real storage or siblings.
 */
async function runIteration(
  storage: Storage,
  spec: DatasetSpec,
  payload: Buffer,
  timeout: number,
): Promise<SnapshotForkTimingResult> {
  const datasetBytes = spec.objectCount * spec.objectSizeBytes;
  const runId = `${Date.now()}-${randomId()}`;
  const prefix = `snapfork/${runId}/`;
  const keys = Array.from({ length: spec.objectCount }, (_, i) => `${prefix}obj-${i}`);
  // Snapshot/fork names must be unique within the parent bucket.
  const snapshotName = `snap-${runId}`;
  const forkFromSnapName = `fork-snap-${runId}`;
  const forkFromLiveName = `fork-live-${runId}`;

  let snapshotId: string | undefined;
  let forkFromSnapCreated = false;
  let forkFromLiveCreated = false;

  try {
    // 1. Seed the dataset.
    const seedStart = performance.now();
    await withTimeout(
      Promise.all(keys.map(k => storage.upload(k, payload))),
      timeout,
      'Seed upload timed out',
    );
    const seedMs = performance.now() - seedStart;

    // 2. Snapshot the current bucket state.
    const snapStart = performance.now();
    const snapshot = await withTimeout(
      storage.snapshots.create({ name: snapshotName }),
      timeout,
      'Snapshot create timed out',
    );
    const snapshotCreateMs = performance.now() - snapStart;
    snapshotId = snapshot.id;

    // 3. Fork from the snapshot (reproducible branch).
    const forkSnapStart = performance.now();
    await withTimeout(
      storage.forks.create({ name: forkFromSnapName, fromSnapshot: snapshot.id }),
      timeout,
      'Fork-from-snapshot timed out',
    );
    const forkFromSnapshotMs = performance.now() - forkSnapStart;
    forkFromSnapCreated = true;

    // 4. Fork from live parent state (no snapshot seed).
    const forkLiveStart = performance.now();
    await withTimeout(
      storage.forks.create({ name: forkFromLiveName }),
      timeout,
      'Fork-from-live timed out',
    );
    const forkFromLiveMs = performance.now() - forkLiveStart;
    forkFromLiveCreated = true;

    // 5. Time-to-usable + correctness: read one object back out of the fork.
    const readStart = performance.now();
    const bytes = await withTimeout(
      storage.forks.get(forkFromSnapName).download(keys[0], { as: 'bytes' }),
      timeout,
      'Fork read timed out',
    );
    const forkFirstReadMs = performance.now() - readStart;
    const verified = bytes.length === payload.length;

    return {
      seedMs,
      snapshotCreateMs,
      forkFromSnapshotMs,
      forkFromLiveMs,
      forkFirstReadMs,
      verified,
      datasetBytes,
      objectCount: spec.objectCount,
    };
  } catch (err) {
    const error = formatError(err);
    return {
      seedMs: 0,
      snapshotCreateMs: 0,
      forkFromSnapshotMs: 0,
      forkFromLiveMs: 0,
      forkFirstReadMs: 0,
      verified: false,
      datasetBytes,
      objectCount: spec.objectCount,
      error,
    };
  } finally {
    // Teardown — order: forks, snapshot, seeded objects.
    if (forkFromSnapCreated) {
      await safeCleanup(`fork delete ${forkFromSnapName}`, () => storage.forks.delete(forkFromSnapName));
    }
    if (forkFromLiveCreated) {
      await safeCleanup(`fork delete ${forkFromLiveName}`, () => storage.forks.delete(forkFromLiveName));
    }
    if (snapshotId) {
      await safeCleanup(`snapshot delete ${snapshotId}`, () => storage.snapshots.delete(snapshotId!));
    }
    await safeCleanup(`object delete ${prefix}*`, () => Promise.all(keys.map(k => storage.delete(k))));
  }
}

export async function runSnapshotForkBenchmark(
  config: StorageProviderConfig,
  dataset: DatasetPreset,
): Promise<SnapshotForkBenchmarkResult> {
  const { name, iterations = 10, timeout = 60000, requiredEnvVars, createStorage, bucket } = config;
  const spec = DATASET_PRESETS[dataset];
  const datasetBytes = spec.objectCount * spec.objectSizeBytes;

  const emptySummary = {
    snapshotCreateMs: { median: 0, p95: 0, p99: 0 },
    forkFromSnapshotMs: { median: 0, p95: 0, p99: 0 },
    forkFromLiveMs: { median: 0, p95: 0, p99: 0 },
    forkFirstReadMs: { median: 0, p95: 0, p99: 0 },
  };

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'snapshot-fork',
      bucket,
      dataset,
      datasetBytes,
      objectCount: spec.objectCount,
      iterations: [],
      summary: emptySummary,
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const storage = createStorage();
  const payload = crypto.randomBytes(spec.objectSizeBytes);
  const results: SnapshotForkTimingResult[] = [];

  const datasetLabel = `${dataset} (${spec.objectCount}×${(spec.objectSizeBytes / 1024 / 1024).toFixed(0)}MB = ${(datasetBytes / 1024 / 1024).toFixed(0)}MB)`;
  console.log(`\n--- Snapshot/Fork Benchmarking: ${name} (${datasetLabel}, ${iterations} iterations) ---`);

  // Sequential: each iteration creates real buckets/snapshots; running them
  // concurrently would distort copy-time measurements and multiply leak risk.
  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    const result = await runIteration(storage, spec, payload, timeout);
    results.push(result);

    if (result.error) {
      console.log(`    FAILED: ${result.error}`);
    } else {
      console.log(
        `    Snapshot: ${(result.snapshotCreateMs / 1000).toFixed(2)}s, ` +
        `Fork(snap): ${(result.forkFromSnapshotMs / 1000).toFixed(2)}s, ` +
        `Fork(live): ${(result.forkFromLiveMs / 1000).toFixed(2)}s, ` +
        `Read: ${(result.forkFirstReadMs / 1000).toFixed(2)}s` +
        (result.verified ? '' : ' [UNVERIFIED]'),
      );
    }
  }

  const successful = results.filter(r => !r.error);

  return {
    provider: name,
    mode: 'snapshot-fork',
    bucket,
    dataset,
    datasetBytes,
    objectCount: spec.objectCount,
    iterations: results,
    summary: {
      snapshotCreateMs: computeStats(successful.map(r => r.snapshotCreateMs)),
      forkFromSnapshotMs: computeStats(successful.map(r => r.forkFromSnapshotMs)),
      forkFromLiveMs: computeStats(successful.map(r => r.forkFromLiveMs)),
      forkFirstReadMs: computeStats(successful.map(r => r.forkFirstReadMs)),
    },
  };
}

/**
 * Compute the success rate for a snapshot/fork result (0 to 1).
 * An iteration only counts as successful if it completed AND verified.
 */
export function computeSnapshotForkSuccessRate(result: SnapshotForkBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const ok = result.iterations.filter(i => !i.error && i.verified).length;
  return ok / result.iterations.length;
}

/** Absolute ceiling for snapshot/fork latency in ms. At or above this scores 0. */
const LATENCY_CEILING_MS = 60000;

function scoreLatency(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

/**
 * Compute composite scores in place. Snapshot create and fork create dominate;
 * fork read is a small tiebreaker. compositeScore = latencyScore × successRate.
 */
export function computeSnapshotForkCompositeScores(results: SnapshotForkBenchmarkResult[]): void {
  for (const result of results) {
    const successRate = computeSnapshotForkSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const score =
      0.40 * scoreLatency(result.summary.snapshotCreateMs.median) +
      0.35 * scoreLatency(result.summary.forkFromSnapshotMs.median) +
      0.15 * scoreLatency(result.summary.forkFromLiveMs.median) +
      0.10 * scoreLatency(result.summary.forkFirstReadMs.median);

    result.compositeScore = Math.round(score * successRate * 100) / 100;
  }
}

export async function writeSnapshotForkResultsJson(
  results: SnapshotForkBenchmarkResult[],
  outPath: string,
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    bucket: r.bucket,
    dataset: r.dataset,
    datasetBytes: r.datasetBytes,
    objectCount: r.objectCount,
    iterations: r.iterations.map(i => ({
      seedMs: round(i.seedMs),
      snapshotCreateMs: round(i.snapshotCreateMs),
      forkFromSnapshotMs: round(i.forkFromSnapshotMs),
      forkFromLiveMs: round(i.forkFromLiveMs),
      forkFirstReadMs: round(i.forkFirstReadMs),
      verified: i.verified,
      datasetBytes: i.datasetBytes,
      objectCount: i.objectCount,
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      snapshotCreateMs: roundStats(r.summary.snapshotCreateMs),
      forkFromSnapshotMs: roundStats(r.summary.forkFromSnapshotMs),
      forkFromLiveMs: roundStats(r.summary.forkFromLiveMs),
      forkFirstReadMs: roundStats(r.summary.forkFirstReadMs),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 60000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
