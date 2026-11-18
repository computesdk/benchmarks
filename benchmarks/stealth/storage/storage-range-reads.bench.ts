/**
 * Storage Range Reads: random-access reads of one 1 GiB object, the way
 * model weights, Parquet and video are read in practice.
 *
 *   pnpm bench benchmarks/stealth/storage/storage-range-reads.bench.ts --provider aws-s3 --iterations 1 --no-ingest
 *
 * One phase per cell (range size x concurrency). Each cell runs N random
 * `download({ range })` calls and checks every response's size and sha256
 * against the locally rebuilt fixture slice. A provider or adapter that
 * ignores the range fails the cell instead of looking slow.
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { isStorageProviderAvailable, storageProviders } from './providers.js';
import type { StorageProviderConfig } from './types.js';
import {
  DEFAULT_RANGE_READS,
  FIXTURE_KEY,
  FIXTURE_SIZE_BYTES,
  INSPECTED_RANGE_MODE,
  MIB,
  RANGE_CELLS,
  defaultOffsetSeed,
  fixtureBytes,
  fixtureStream,
  rangeOffsets,
  readNetworkRxBytes,
  sha256,
  summarizeCell,
  type RangeCell,
  type ReadSample,
} from './storage-range-reads.js';
import { writeStorageRangeReadsResults } from './storage-range-reads-legacy-results.js';

const READ_TIMEOUT_MS = 30_000;
const HEAD_TIMEOUT_MS = 30_000;
const SEED_TIMEOUT_MS = 30 * 60_000;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function intArg(flag: string, envName: string, fallback: number, min: number): number {
  const raw = argValue(flag) ?? process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${flag} must be an integer >= ${min}`);
  return value;
}

const rangeReads = intArg('--range-reads', 'STORAGE_RANGE_READS', DEFAULT_RANGE_READS, 10);
const offsetSeed = intArg('--range-seed', 'STORAGE_RANGE_SEED', defaultOffsetSeed(), 0);

const storageCache = new Map<string, Storage>();
const fixtureReady = new Map<string, Promise<{ seeded: boolean; sizeBytes: number }>>();

function storageFor(participant: StorageProviderConfig): Storage {
  let storage = storageCache.get(participant.name);
  if (!storage) {
    storage = participant.createStorage();
    storageCache.set(participant.name, storage);
  }
  return storage;
}

/** HEAD the fixture; upload it (multipart, streamed) only when missing or the wrong size. */
async function ensureFixture(storage: Storage): Promise<{ seeded: boolean; sizeBytes: number }> {
  try {
    const meta = await withTimeout(storage.head(FIXTURE_KEY), HEAD_TIMEOUT_MS, 'fixture HEAD timed out');
    if (meta.size === FIXTURE_SIZE_BYTES) return { seeded: false, sizeBytes: meta.size };
    console.log(`  fixture has size ${meta.size}, expected ${FIXTURE_SIZE_BYTES}; re-seeding`);
  } catch {
    // Missing: seed below.
  }
  console.log(`  seeding ${FIXTURE_KEY} (1 GiB, multipart)`);
  await withTimeout(
    storage.upload(FIXTURE_KEY, fixtureStream(), {
      contentType: 'application/octet-stream',
      multipart: true,
      partSize: 16 * MIB,
      concurrency: 4,
    }),
    SEED_TIMEOUT_MS,
    'fixture upload timed out',
  );
  const meta = await withTimeout(storage.head(FIXTURE_KEY), HEAD_TIMEOUT_MS, 'fixture HEAD timed out');
  if (meta.size !== FIXTURE_SIZE_BYTES) {
    throw new Error(`fixture upload finished but HEAD reports ${meta.size} bytes, expected ${FIXTURE_SIZE_BYTES}`);
  }
  return { seeded: true, sizeBytes: meta.size };
}

async function runCell(storage: Storage, cell: RangeCell, offsets: number[]): Promise<ReadSample[]> {
  const samples: ReadSample[] = new Array(offsets.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= offsets.length) return;
      const offset = offsets[index];
      const startMs = performance.now();
      try {
        const bytes = await withTimeout(
          storage.download(FIXTURE_KEY, { as: 'bytes', range: { offset, length: cell.rangeBytes } }),
          READ_TIMEOUT_MS,
          'range GET timed out',
        );
        const endMs = performance.now();
        // Verify outside the timed window.
        let outcome: ReadSample['outcome'] = 'ok';
        if (bytes.byteLength !== cell.rangeBytes) outcome = 'wrong-size';
        else if (sha256(bytes) !== sha256(fixtureBytes(offset, cell.rangeBytes))) outcome = 'hash-mismatch';
        samples[index] = { latencyMs: endMs - startMs, startMs, endMs, bytesReturned: bytes.byteLength, outcome };
      } catch (error) {
        const endMs = performance.now();
        samples[index] = {
          latencyMs: endMs - startMs,
          startMs,
          endMs,
          bytesReturned: 0,
          outcome: 'error',
          error: formatError(error).slice(0, 200),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: cell.concurrency }, () => worker()));
  return samples;
}

export const config = defineBenchmarkConfig<StorageProviderConfig>({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'storage-range-reads',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Storage Range Reads',
  phases: RANGE_CELLS.map((cell) => ({ name: cell.name, iterations: 1 })),
  // The internal worker pool sets request concurrency; cells must not overlap.
  concurrency: 1,
  groupBy: 'participant',
  participants: storageProviders.filter(isStorageProviderAvailable),
  customCliFlags: ['--range-reads', '--range-seed'],
  display: {
    metrics: [
      { key: 'p50Ms', label: 'p50 latency', unit: 'ms', direction: 'lower-better', decimals: 1, order: 0 },
      { key: 'p95Ms', label: 'p95 latency', unit: 'ms', direction: 'lower-better', decimals: 1, order: 1 },
      { key: 'p99Ms', label: 'p99 latency', unit: 'ms', direction: 'lower-better', decimals: 1, order: 2 },
      { key: 'throughputMBps', label: 'Throughput', unit: 'MB/s', direction: 'higher-better', decimals: 2, order: 3 },
      { key: 'readsPerSec', label: 'Reads per second', unit: 'reads/s', direction: 'higher-better', decimals: 1, order: 4 },
      { key: 'hashMismatches', label: 'Corrupted reads', unit: 'reads', direction: 'lower-better', decimals: 0, order: 5 },
      { key: 'wrongSizeReads', label: 'Wrong-size reads', unit: 'reads', direction: 'lower-better', decimals: 0, order: 6 },
      { key: 'bytesReturnedTotal', label: 'Bytes returned', unit: 'bytes', direction: 'lower-better', decimals: 0, order: 7 },
      { key: 'bytesRequestedTotal', label: 'Bytes requested', unit: 'bytes', direction: 'lower-better', decimals: 0, order: 8 },
    ],
    steps: [
      { key: 'ensure-fixture', label: 'Ensure 1 GiB fixture', order: 0 },
      ...RANGE_CELLS.map((cell, index) => ({
        key: `read-${cell.name}`,
        label: `${cell.rangeLabel} ranges, concurrency ${cell.concurrency}`,
        order: index + 1,
      })),
    ],
    overview: { defaultMetric: 'p50Ms', defaultLayout: 'ranking' },
  },
  scoring: {
    // One summary row per cell (phase): 64kib-c1, 64kib-c16, 1mib-c1, 1mib-c16.
    groupBy: 'phase',
    success: { requireData: { valid: true } },
    metrics: [
      { key: 'p50Ms', unit: 'ms', higherIsBetter: false, ceiling: 1_000, weights: { median: 0.5, p95: 0, p99: 0 } },
      { key: 'p95Ms', unit: 'ms', higherIsBetter: false, ceiling: 2_000, weights: { median: 0.25, p95: 0, p99: 0 } },
      { key: 'throughputMBps', unit: 'MB/s', higherIsBetter: true, ceiling: 500, weights: { median: 0.25, p95: 0, p99: 0 } },
      { key: 'p99Ms', unit: 'ms', higherIsBetter: false, ceiling: 4_000, weights: { median: 0, p95: 0, p99: 0 } },
      { key: 'readsPerSec', unit: 'reads/s', higherIsBetter: true, ceiling: 2_000, weights: { median: 0, p95: 0, p99: 0 } },
    ],
  },
  onComplete: writeStorageRangeReadsResults,
});

export const task = defineTask<StorageProviderConfig>(async (ctx) => {
  const cell = RANGE_CELLS.find((candidate) => candidate.name === ctx.phase);
  if (!cell) throw new Error(`Unknown storage range-reads cell: ${ctx.phase ?? '(missing phase)'}`);
  const participant = ctx.participant;
  const storage = storageFor(participant);

  const fixture = await ctx.step('ensure-fixture', async () => {
    let ready = fixtureReady.get(participant.name);
    if (!ready) {
      ready = ensureFixture(storage);
      fixtureReady.set(participant.name, ready);
    }
    return ready;
  }, { reportConcurrency: false });

  const inspected = INSPECTED_RANGE_MODE[participant.name]?.mode ?? 'native';
  const result = await ctx.step(`read-${cell.name}`, async () => {
    const offsets = rangeOffsets(offsetSeed, cell.name, rangeReads, cell.rangeBytes);
    const rxBefore = readNetworkRxBytes();
    const samples = await runCell(storage, cell, offsets);
    const rxAfter = readNetworkRxBytes();
    const wireRxBytes = rxBefore === null || rxAfter === null ? null : rxAfter - rxBefore;
    const summary = { ...summarizeCell({ cell, offsetSeed, samples, inspected, wireRxBytes }), fixtureSeeded: fixture.seeded };
    console.log(
      `  [${participant.name}] ${cell.name}: p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms `
      + `${summary.throughputMBps} MB/s rangeMode=${summary.rangeMode} wireAmp=${summary.wireAmplification}`
      + (summary.valid ? '' : ` FAILED: ${summary.failureReason}`),
    );
    if (!summary.valid) {
      throw new TaskError(`${cell.name} failed for ${participant.name}: ${summary.failureReason}`, {
        code: summary.rangeIgnored ? 'range_ignored' : summary.hashMismatches > 0 ? 'corrupt_range' : 'cell_invalid',
        data: summary as unknown as NonNullable<InstanceType<typeof TaskError>['data']>,
      });
    }
    return summary;
  });

  return { data: { ...result } };
});
