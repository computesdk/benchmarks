/**
 * Single-run storage concurrency benchmark.
 *
 * The runner creates one task per phase and one participant per provider. Each
 * task owns its request concurrency, so the platform run contains a comparable
 * cell for every provider without opening separate runs.
 *
 *   pnpm bench:storage-concurrency
 *   pnpm bench:storage-concurrency -- --provider aws-s3 --concurrency 32
 *
 * The optional runner --concurrency flag is intentionally not used for the
 * workload. The internal pool below is the source of truth for request
 * concurrency.
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { isStorageProviderAvailable, storageProviders } from './providers.js';
import type { StorageProviderConfig } from './types.js';
import { requestKey } from './storage-concurrency-corpus.js';
import type { KeyDistribution } from './storage-concurrency-corpus.js';
import { writeStorageConcurrencyResults } from './storage-concurrency-results.js';

const OPERATIONS = 1_200;
const WARMUP_FRACTION = 0.05;
const REQUEST_TIMEOUT_MS = 30_000;

interface Cell {
  name: string;
  concurrency: number;
  keyDistribution: KeyDistribution;
}

export const storageConcurrencyCells: Cell[] = [
  ...[1, 8, 32, 128].map((concurrency) => ({
    name: `c${concurrency}-single-prefix`,
    concurrency,
    keyDistribution: 'SINGLE_PREFIX' as const,
  })),
  ...[1, 8, 32, 128].map((concurrency) => ({
    name: `c${concurrency}-spread-64`,
    concurrency,
    keyDistribution: 'SPREAD_64' as const,
  })),
];

const storageCache = new Map<string, Storage>();

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getOperations(): number {
  const value = getArgValue('--storage-operations') ?? process.env.STORAGE_CONCURRENCY_OPERATIONS;
  if (value === undefined) return OPERATIONS;
  const operations = Number(value);
  if (!Number.isInteger(operations) || operations < 100) {
    throw new Error('--storage-operations must be an integer >= 100');
  }
  return operations;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return Number(sorted[index].toFixed(3));
}

function errorClass(error: unknown): string {
  const text = formatError(error).toLowerCase();
  if (/timeout|timed out|abort/.test(text)) return 'TIMEOUT';
  if (/429|503|slowdown|throttl|rate.?limit|requestlimit/.test(text)) return 'THROTTLE';
  if (/reset|eof|socket|tls|connection/.test(text)) return 'CONN_ERROR';
  if (/notfound|not found/.test(text)) return 'NOT_FOUND';
  if (/unauthor|forbidden|accessdenied|invalidargument/.test(text)) return 'CLIENT';
  return 'SERVER';
}

interface RequestResult {
  latencyMs: number;
  bytes: number;
  errorClass: string | null;
  inWindow: boolean;
  startMs: number;
  endMs: number;
}

interface CellResult {
  operations: number;
  measuredOperations: number;
  concurrency: number;
  keyDistribution: KeyDistribution;
  throughputOpsPerSecond: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  successRate: number;
  throttleRate: number;
  timeoutRate: number;
  connectionErrorRate: number;
  notFoundRate: number;
  serverErrorRate: number;
  clientErrorRate: number;
  valid: boolean;
  status: 'COMPLETE';
  maxActiveRequests: number;
}

async function runCell(
  storage: Storage,
  cell: Cell,
  operations: number,
): Promise<CellResult> {
  const results: RequestResult[] = [];
  let nextOperation = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;

  async function worker(workerId: number): Promise<void> {
    let opSeq = 0;
    while (true) {
      const operation = nextOperation++;
      if (operation >= operations) return;

      const startMs = performance.now();
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        const bytes = await withTimeout(
          storage.download(requestKey(workerId, opSeq++, cell.keyDistribution), { as: 'bytes' }),
          REQUEST_TIMEOUT_MS,
          'Storage GET timed out',
        );
        const endMs = performance.now();
        results.push({
          latencyMs: endMs - startMs,
          bytes: bytes.byteLength,
          errorClass: null,
          inWindow: operation >= Math.floor(operations * WARMUP_FRACTION),
          startMs,
          endMs,
        });
      } catch (error) {
        const endMs = performance.now();
        results.push({
          latencyMs: endMs - startMs,
          bytes: 0,
          errorClass: errorClass(error),
          inWindow: operation >= Math.floor(operations * WARMUP_FRACTION),
          startMs,
          endMs,
        });
      } finally {
        activeRequests--;
      }
    }
  }

  await Promise.all(Array.from({ length: cell.concurrency }, (_, workerId) => worker(workerId)));

  const measured = results.filter((result) => result.inWindow);
  const latencies = measured.map((result) => result.latencyMs);
  const successCount = measured.filter((result) => result.errorClass === null).length;
  const throttleCount = measured.filter((result) => result.errorClass === 'THROTTLE').length;
  const timeoutCount = measured.filter((result) => result.errorClass === 'TIMEOUT').length;
  const connectionErrorCount = measured.filter((result) => result.errorClass === 'CONN_ERROR').length;
  const notFoundCount = measured.filter((result) => result.errorClass === 'NOT_FOUND').length;
  const serverErrorCount = measured.filter((result) => result.errorClass === 'SERVER').length;
  const clientErrorCount = measured.filter((result) => result.errorClass === 'CLIENT').length;
  const rate = (count: number): number => Number((count / measured.length).toFixed(5));
  const start = Math.min(...measured.map((result) => result.startMs));
  const end = Math.max(...measured.map((result) => result.endMs));
  const durationSeconds = Math.max((end - start) / 1000, Number.EPSILON);

  return {
    operations,
    measuredOperations: measured.length,
    concurrency: cell.concurrency,
    keyDistribution: cell.keyDistribution,
    throughputOpsPerSecond: Number((measured.length / durationSeconds).toFixed(3)),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    // 1,200 operations leaves 1,140 measured samples, meeting the p99 gate.
    p99Ms: measured.length >= 1_000 ? percentile(latencies, 0.99) : null,
    successRate: rate(successCount),
    throttleRate: rate(throttleCount),
    timeoutRate: rate(timeoutCount),
    connectionErrorRate: rate(connectionErrorCount),
    notFoundRate: rate(notFoundCount),
    serverErrorRate: rate(serverErrorCount),
    clientErrorRate: rate(clientErrorCount),
    valid: successCount === measured.length,
    status: 'COMPLETE',
    maxActiveRequests,
  };
}

export const config = defineBenchmarkConfig<StorageProviderConfig>({
  benchmarkSlug: 'storage-concurrency',
  benchmarkName: 'Storage Concurrency',
  phases: storageConcurrencyCells.map((cell) => ({ name: cell.name, iterations: 1 })),
  // The internal pool establishes storage-request concurrency. Keeping the
  // runner at one task in flight prevents cells from overlapping.
  concurrency: 1,
  groupBy: 'participant',
  participants: storageProviders.filter(isStorageProviderAvailable),
  onComplete: writeStorageConcurrencyResults,
});

export const task = defineTask<StorageProviderConfig>(async (ctx) => {
  const cell = storageConcurrencyCells.find((candidate) => candidate.name === ctx.phase);
  if (!cell) throw new Error(`Unknown storage concurrency cell: ${ctx.phase ?? '(missing phase)'}`);

  let storage = storageCache.get(ctx.participant.name);
  if (!storage) {
    storage = ctx.participant.createStorage();
    storageCache.set(ctx.participant.name, storage);
  }

  const result = await ctx.step(`measure-${cell.name}`, () =>
    runCell(storage!, cell, getOperations()),
  );
  return { data: { ...result } };
});
