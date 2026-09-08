/**
 * Storage upload/download benchmark: `iterations` upload→download→delete cycles
 * per provider (concurrency 1 = sequential). Declarative — exports `config` +
 * `task`; `bench run` owns the entrypoint. The custom `--file-size` flag is
 * scanned from argv here (the runner ignores flags it doesn't know).
 *
 *   bench run benchmarks/storage/storage.bench.ts
 *   bench run benchmarks/storage/storage.bench.ts --file-size 10MB --iterations 5 --provider aws-s3
 *   bench run benchmarks/storage/storage.bench.ts --file-size 1MB,10MB --provider aws-s3
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { defineBenchmarkConfig, defineTask, TaskError, type BenchmarkRunOutcome } from '@benchsdk/runner';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { storageProviders } from './providers.js';
import { writeStorageLegacyResults } from './legacy-results.js';
import { FILE_SIZE_BYTES } from './types.js';
import type { StorageFileSize, StorageProviderConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --file-size is unknown to @benchsdk/runner and passes through untouched, so we
// parse it ourselves from process.argv. Accept a comma-separated list to run
// multiple file sizes in a single benchmark run; each size becomes a phase and
// the scoring spec groups summary rows by `file_size`.
const args = process.argv.slice(2);
function getArgValues(argv: string[], flag: string): string[] | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  const values = argv[idx + 1].split(',').map((s) => s.trim()).filter(Boolean);
  // A flag that was passed but names no size is an invalid size, not an absent
  // flag: keep the raw value so validation below rejects it by name.
  return values.length > 0 ? values : [argv[idx + 1]];
}
const fileSizeArgs = getArgValues(args, '--file-size') ?? ['10MB'];
for (const size of fileSizeArgs) {
  if (!(size in FILE_SIZE_BYTES)) {
    const validSizes = Object.keys(FILE_SIZE_BYTES);
    console.error(`Invalid --file-size "${size}". Valid sizes: ${validSizes.join(', ')}`);
    process.exit(1);
  }
}
const fileSizes = fileSizeArgs as StorageFileSize[];
const defaultFileSize = fileSizes[0];
const isMultiSize = fileSizes.length > 1;

const baseConfig = {
  benchmarkSlug: `storage-lifecycle${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Storage Lifecycle${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  concurrency: 1,
  participants: storageProviders,
  customCliFlags: ['--file-size'],
  display: {
    description: 'Storage upload/download lifecycle latency and throughput.',
    metrics: [
      { key: 'uploadMs', label: 'Upload', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'downloadMs', label: 'Download', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'throughputMbps', label: 'Throughput', unit: 'Mbps', direction: 'higher-better' as const, decimals: 1 },
      { key: 'fileSizeBytes', label: 'File size', unit: 'bytes', direction: 'lower-better' as const, decimals: 0 },
    ],
    steps: [
      { key: 'upload', label: 'Upload' },
      { key: 'download', label: 'Download' },
      { key: 'delete', label: 'Delete' },
    ],
    overview: { defaultMetric: 'downloadMs', defaultLayout: 'ranking' as const },
  },
  scoring: {
    groupBy: 'file_size',
    metrics: [
      { key: 'uploadMs', ceiling: 30000, weights: { median: 0.25, p95: 0.10, p99: 0.05 } },
      { key: 'downloadMs', ceiling: 30000, weights: { median: 0.35, p95: 0.15, p99: 0.05 } },
      { key: 'throughputMbps', floor: 1, ceiling: 1000, higherIsBetter: true, weights: { median: 0.05, p95: 0, p99: 0 } },
    ],
  },
};

const singleSizeConfig = {
  ...baseConfig,
  iterations: 2,
  dimensions: { file_size: defaultFileSize },
  // A single-size run needs the `file_size` tag but not a separate group row,
  // otherwise the run-wide aggregate and the group row have identical dimensions
  // and identical metrics and get reported twice.
  scoring: { metrics: baseConfig.scoring.metrics },
  onComplete: (outcome: BenchmarkRunOutcome) =>
    writeStorageLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/storage/${defaultFileSize.toLowerCase()}`),
      fileSizeBytes: FILE_SIZE_BYTES[defaultFileSize],
      providers: storageProviders,
    }),
};

const multiSizeConfig = {
  ...baseConfig,
  phases: fileSizes.map((size) => ({ name: size, iterations: 2 })),
  // The legacy results tree is one directory per size, so a multi-size run
  // splits its records back out by `file_size` and writes each size's
  // directory as a single-size run would.
  onComplete: async (outcome: BenchmarkRunOutcome) => {
    for (const size of fileSizes) {
      const participants = outcome.participants.map((p) => ({
        ...p,
        records: p.records.filter((r) => (r.data as { file_size?: string } | undefined)?.file_size === size),
      }));
      await writeStorageLegacyResults(participants, {
        resultsDir: path.resolve(__dirname, `../../results/storage/${size.toLowerCase()}`),
        fileSizeBytes: FILE_SIZE_BYTES[size],
        providers: storageProviders,
      });
    }
  },
};

export const config = defineBenchmarkConfig(isMultiSize ? multiSizeConfig : singleSizeConfig);

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * One `Storage` instance per participant, so the adapter (and its credentials
 * lookup) isn't recreated on every iteration.
 */
const storageCache = new Map<string, Storage>();

export const task = defineTask<StorageProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;
  const timeout = participant.timeout ?? 30_000;

  // When running multiple file sizes per run, each phase is named after the size.
  const fileSizeLabel = (ctx.phase as StorageFileSize | undefined) ?? defaultFileSize;
  const fileSizeBytes = FILE_SIZE_BYTES[fileSizeLabel];

  let storage = storageCache.get(participant.name);
  if (!storage) {
    storage = participant.createStorage();
    storageCache.set(participant.name, storage);
  }

  // Measured up front rather than only returned: on failure the thrown data is
  // not what lands on the record in participant mode, and the scoring spec
  // groups by `file_size` — an untagged failure would form its own group and
  // leave the real group looking fully successful.
  measure({ file_size: fileSizeLabel, fileSizeBytes });

  const key = `benchmark-${Date.now()}-${randomId()}`;
  const testData = crypto.randomBytes(fileSizeBytes);

  let uploadMs = 0;
  let downloadMs = 0;
  let throughputMbps = 0;

  try {
    // Upload timing
    const uploadStart = performance.now();
    await step('upload', () =>
      withTimeout(storage!.upload(key, testData), timeout, 'Upload timed out'),
    );
    uploadMs = performance.now() - uploadStart;

    // Download timing — request raw bytes so we measure a full object fetch.
    // Throughput (Mbps) is a rate, not a duration, so it can't be inferred
    // from the step's latency; measure it inside the `download` step so it
    // lands on that step's data (platform step_data_json).
    await step('download', async () => {
      const downloadStart = performance.now();
      await withTimeout(storage!.download(key, { as: 'bytes' }), timeout, 'Download timed out');
      downloadMs = performance.now() - downloadStart;
      throughputMbps = (fileSizeBytes * 8) / (downloadMs / 1000) / 1_000_000;
      measure({ throughputMbps });
    });

    // Cleanup: best-effort delete; failures are warned but don't fail the task.
    await step(
      'delete',
      () => withTimeout(storage!.delete(key), 10_000, 'Delete timed out'),
      { reportConcurrency: false },
    ).catch((err: unknown) => log('delete cleanup failed', { level: 'warn', meta: { key, error: formatError(err) } }));

    log('Storage lifecycle completed', {
      level: 'info',
      meta: { fileSize: fileSizeLabel, fileSizeBytes, uploadMs, downloadMs, throughputMbps, key },
    });
    return { data: { file_size: fileSizeLabel, uploadMs, downloadMs, throughputMbps, fileSizeBytes } };
  } catch (err) {
    // Attempt cleanup even on failure.
    try {
      await withTimeout(storage!.delete(key), 10_000, 'Delete timed out');
    } catch (cleanupErr: unknown) {
      log('cleanup delete failed', { level: 'warn', meta: { key, error: formatError(cleanupErr) } });
    }
    const message = formatError(err);
    log('Storage lifecycle failed', {
      level: 'error',
      meta: { fileSize: fileSizeLabel, fileSizeBytes, uploadMs, downloadMs, throughputMbps, key, error: message },
    });
    throw new TaskError(message, {
      code: 'STORAGE_ERROR',
      data: { file_size: fileSizeLabel, uploadMs: 0, downloadMs: 0, throughputMbps: 0, fileSizeBytes },
    });
  }
});
