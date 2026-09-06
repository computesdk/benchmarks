/**
 * Storage snapshot/fork benchmark: per-iteration seed -> snapshot -> fork ->
 * verify, per provider (concurrency 1 = sequential; each iteration creates real
 * snapshots/forks). Declarative — exports `config` + `task`; `bench run` owns
 * the entrypoint and orchestration.
 *
 *   bench run benchmarks/storage/snapshot-fork.bench.ts
 *   bench run benchmarks/storage/snapshot-fork.bench.ts --dataset wide --iterations 5 --provider tigris
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { storageProviders } from './providers.js';
import { writeSnapshotForkLegacyResults } from './snapshot-fork-legacy-results.js';
import { DATASET_PRESETS } from './snapshot-fork-types.js';
import type { DatasetPreset } from './snapshot-fork-types.js';
import type { StorageProviderConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --dataset is unknown to @benchsdk/runner and passes through untouched, so we
// parse it ourselves from process.argv (default 'small', matching run.ts).
const args = process.argv.slice(2);
function getArgValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
const datasetArg = getArgValue(args, '--dataset') ?? 'small';
const validDatasets = Object.keys(DATASET_PRESETS) as DatasetPreset[];
if (!(datasetArg in DATASET_PRESETS)) {
  console.error(`Invalid --dataset "${datasetArg}". Valid datasets: ${validDatasets.join(', ')}`);
  process.exit(1);
}
const dataset = datasetArg as DatasetPreset;
const spec = DATASET_PRESETS[dataset];

// Some providers need a different bucket/credentials for snapshot-fork than for
// upload/download (e.g. Tigris's snapshot-enabled bucket); apply that override
// here, mirroring run.ts's runSnapshotFork.
const participants: StorageProviderConfig[] = storageProviders.map((p) => {
  const { snapshotFork, ...base } = p;
  return snapshotFork ? { ...base, ...snapshotFork } : base;
});

export const config = defineBenchmarkConfig({
  benchmarkSlug: `snapshot-fork${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Storage Snapshot/Fork${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  iterations: 2,
  concurrency: 1,
  participants,
  customCliFlags: ['--dataset'],
  dimensions: { dataset },
  display: {
    description: 'Storage snapshot/fork creation and read latency.',
    metrics: [
      { key: 'snapshotCreateMs', label: 'Snapshot create', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'forkFromSnapshotMs', label: 'Fork from snapshot', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'forkFromLiveMs', label: 'Fork from live', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'forkFirstReadMs', label: 'Fork first read', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'seedMs', label: 'Seed', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'seed', label: 'Seed' },
      { key: 'snapshot-create', label: 'Create snapshot' },
      { key: 'fork-from-snapshot', label: 'Fork from snapshot' },
      { key: 'fork-from-live', label: 'Fork from live' },
      { key: 'fork-first-read', label: 'First read' },
    ],
    overview: { defaultMetric: 'forkFirstReadMs', defaultLayout: 'ranking' },
  },
  scoring: {
    // A fork whose read-back didn't match is not a usable fork, so its timings
    // must not be scored as if it were.
    success: { requireData: { verified: true } },
    metrics: [
      { key: 'snapshotCreateMs', ceiling: 60000, weights: { median: 0.40, p95: 0, p99: 0 } },
      { key: 'forkFromSnapshotMs', ceiling: 60000, weights: { median: 0.35, p95: 0, p99: 0 } },
      { key: 'forkFromLiveMs', ceiling: 60000, weights: { median: 0.15, p95: 0, p99: 0 } },
      { key: 'forkFirstReadMs', ceiling: 60000, weights: { median: 0.10, p95: 0, p99: 0 } },
    ],
  },
  onComplete: (outcome) =>
    writeSnapshotForkLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/snapshot-fork/${dataset}`),
      dataset,
      spec,
      providers: participants,
    }),
});

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}



/** One `Storage` per participant, and a single random payload buffer for the run. */
const storageCache = new Map<string, Storage>();
const payload = crypto.randomBytes(spec.objectSizeBytes);
const datasetBytes = spec.objectCount * spec.objectSizeBytes;

/**
 * One iteration: seed dataset -> snapshot -> fork(from snapshot) -> fork(from
 * live) -> read-back-from-fork (verify) -> teardown. Every created resource is
 * torn down in the `finally` so a mid-iteration failure does not leak real
 * storage.
 */
export const task = defineTask<StorageProviderConfig>(async (ctx) => {
  const { participant, step, log } = ctx;
  const timeout = participant.timeout ?? 60_000;

  const safeCleanup = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await withTimeout(Promise.resolve(fn()), 30_000, `${label} timed out`);
    } catch (err) {
      log('cleanup failed', { level: 'warn', meta: { label, error: formatError(err) } });
    }
  };

  let storage = storageCache.get(participant.name);
  if (!storage) {
    storage = participant.createStorage();
    storageCache.set(participant.name, storage);
  }

  const runId = `${Date.now()}-${randomId()}`;
  const prefix = `snapfork/${runId}/`;
  const keys = Array.from({ length: spec.objectCount }, (_, i) => `${prefix}obj-${i}`);
  const snapshotName = `snap-${runId}`;
  const forkFromSnapName = `fork-snap-${runId}`;
  const forkFromLiveName = `fork-live-${runId}`;

  let snapshotId: string | undefined;
  let forkFromSnapCreated = false;
  let forkFromLiveCreated = false;

  try {
    const seedStart = performance.now();
    await step('seed', () =>
      withTimeout(Promise.all(keys.map((k) => storage!.upload(k, payload))), timeout, 'Seed upload timed out'),
    );
    const seedMs = performance.now() - seedStart;

    const snapStart = performance.now();
    const snapshot = await step<{ id: string }>('snapshot-create', () =>
      withTimeout(storage!.snapshots.create({ name: snapshotName }), timeout, 'Snapshot create timed out'),
    );
    const snapshotCreateMs = performance.now() - snapStart;
    snapshotId = snapshot.id;

    const forkSnapStart = performance.now();
    await step('fork-from-snapshot', () =>
      withTimeout(
        storage!.forks.create({ name: forkFromSnapName, fromSnapshot: snapshot.id }),
        timeout,
        'Fork-from-snapshot timed out',
      ),
    );
    const forkFromSnapshotMs = performance.now() - forkSnapStart;
    forkFromSnapCreated = true;

    const forkLiveStart = performance.now();
    await step('fork-from-live', () =>
      withTimeout(storage!.forks.create({ name: forkFromLiveName }), timeout, 'Fork-from-live timed out'),
    );
    const forkFromLiveMs = performance.now() - forkLiveStart;
    forkFromLiveCreated = true;

    const readStart = performance.now();
    const bytes = await step<{ length: number }>('fork-first-read', () =>
      withTimeout(
        storage!.forks.get(forkFromSnapName).download(keys[0], { as: 'bytes' }),
        timeout,
        'Fork read timed out',
      ),
    );
    const forkFirstReadMs = performance.now() - readStart;
    const verified = bytes.length === payload.length;

    const data = {
      seedMs,
      snapshotCreateMs,
      forkFromSnapshotMs,
      forkFromLiveMs,
      forkFirstReadMs,
      verified,
      datasetBytes,
      objectCount: spec.objectCount,
    };
    log('Snapshot/fork lifecycle completed', { level: 'info', meta: data });
    return { data };
  } catch (err) {
    const message = formatError(err);
    log('Snapshot/fork lifecycle failed', {
      level: 'error',
      meta: {
        seedMs: 0,
        snapshotCreateMs: 0,
        forkFromSnapshotMs: 0,
        forkFromLiveMs: 0,
        forkFirstReadMs: 0,
        verified: false,
        datasetBytes,
        objectCount: spec.objectCount,
        error: message,
      },
    });
    throw new TaskError(message, {
      code: 'SNAPSHOT_FORK_ERROR',
      data: {
        seedMs: 0,
        snapshotCreateMs: 0,
        forkFromSnapshotMs: 0,
        forkFromLiveMs: 0,
        forkFirstReadMs: 0,
        verified: false,
        datasetBytes,
        objectCount: spec.objectCount,
        errorMessage: message,
      },
    });
  } finally {
    if (forkFromSnapCreated) {
      await safeCleanup(`fork delete ${forkFromSnapName}`, () => storage!.forks.delete(forkFromSnapName));
    }
    if (forkFromLiveCreated) {
      await safeCleanup(`fork delete ${forkFromLiveName}`, () => storage!.forks.delete(forkFromLiveName));
    }
    if (snapshotId) {
      await safeCleanup(`snapshot delete ${snapshotId}`, () => storage!.snapshots.delete(snapshotId!));
    }
    await safeCleanup(`object delete ${prefix}*`, () => Promise.all(keys.map((k) => storage!.delete(k))));
  }
});
