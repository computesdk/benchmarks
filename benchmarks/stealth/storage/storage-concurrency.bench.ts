/**
 * Single-run storage concurrency benchmark.
 *
 * The runner creates one task per phase and one participant per provider. Each
 * task owns its request concurrency, so the platform run contains a comparable
 * cell for every provider without opening separate runs.
 *
 *   pnpm bench
 *   pnpm bench -- --provider aws-s3 --concurrency 32
 *
 * The optional runner --concurrency flag is intentionally not used for the
 * workload. The internal pool below is the source of truth for request
 * concurrency.
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { scoreCell } from './storage-concurrency-scoring.js';
import type { Storage } from '@storagesdk/core';
import { withTimeout } from '../src/util/timeout.js';
import { errorClass, formatError } from '../src/util/error.js';
import { isStorageProviderAvailable, storageProviders } from './providers.js';
import type { StorageProviderConfig } from './types.js';
import { requestKey } from './storage-concurrency-corpus.js';
import type { KeyDistribution } from './storage-concurrency-corpus.js';
import { writeStorageConcurrencyResults } from './storage-concurrency-results.js';

// 1,052 operations leaves exactly 1,000 measured samples after the 5% warmup.
const OPERATIONS = 1_052;
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
  cellComposite: number;
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
  /** First observed raw error message per error class (truncated). */
  errorSamples: Record<string, string>;
}

async function runCell(
  storage: Storage,
  cell: Cell,
  operations: number,
): Promise<CellResult> {
  const results: RequestResult[] = [];
  const errorSamples: Record<string, string> = {};
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
        const klass = errorClass(error);
        if (!(klass in errorSamples)) {
          errorSamples[klass] = formatError(error).slice(0, 200);
        }
        results.push({
          latencyMs: endMs - startMs,
          bytes: 0,
          errorClass: klass,
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

  const result: Omit<CellResult, 'cellComposite'> = {
    operations,
    measuredOperations: measured.length,
    concurrency: cell.concurrency,
    keyDistribution: cell.keyDistribution,
    throughputOpsPerSecond: Number((measured.length / durationSeconds).toFixed(3)),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    // Report p99 only when the measured window is essentially full — enough
    // samples that the 99th percentile isn't a handful of outliers.
    p99Ms: measured.length >= Math.floor(operations * 0.9) ? percentile(latencies, 0.99) : null,
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
    errorSamples,
  };

  return { ...result, cellComposite: scoreCell(result) };
}

export const config = defineBenchmarkConfig<StorageProviderConfig>({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'storage-concurrency',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Storage Concurrency',
  phases: storageConcurrencyCells.map((cell) => ({ name: cell.name, iterations: 1 })),
  // The internal pool establishes storage-request concurrency. Keeping the
  // runner at one task in flight prevents cells from overlapping.
  concurrency: 1,
  groupBy: 'participant',
  participants: storageProviders.filter(isStorageProviderAvailable),
  customCliFlags: ['--storage-operations'],
  display: {
    metrics: [
      { key: 'cellComposite', label: 'Cell composite', unit: 'score', direction: 'higher-better', decimals: 2, order: 0 },
      { key: 'throughputOpsPerSecond', label: 'Throughput', unit: 'ops/s', direction: 'higher-better', decimals: 2, order: 1 },
      { key: 'p50Ms', label: 'p50 latency', unit: 'ms', direction: 'lower-better', decimals: 2, order: 2 },
      { key: 'p95Ms', label: 'p95 latency', unit: 'ms', direction: 'lower-better', decimals: 2, order: 3 },
      { key: 'p99Ms', label: 'p99 latency', unit: 'ms', direction: 'lower-better', decimals: 2, order: 4 },
    ],
    steps: storageConcurrencyCells.map((cell, index) => ({
      key: `measure-${cell.name}`,
      label: `Concurrency ${cell.concurrency}, Folders ${cell.keyDistribution === 'SINGLE_PREFIX' ? 1 : 64}`,
      order: index,
    })),
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  scoring: {
    success: { requireData: { valid: true } },
    metrics: [
      { key: 'cellComposite', unit: 'score', higherIsBetter: true, ceiling: 100, weights: { median: 1, p95: 0, p99: 0 } },
      { key: 'throughputOpsPerSecond', unit: 'ops/s', higherIsBetter: true, ceiling: 2_000, weights: { median: 0, p95: 0, p99: 0 } },
      { key: 'p50Ms', unit: 'ms', higherIsBetter: false, ceiling: 500, weights: { median: 0, p95: 0, p99: 0 } },
      { key: 'p95Ms', unit: 'ms', higherIsBetter: false, ceiling: 1_000, weights: { median: 0, p95: 0, p99: 0 } },
      { key: 'p99Ms', unit: 'ms', higherIsBetter: false, ceiling: 2_000, weights: { median: 0, p95: 0, p99: 0 } },
    ],
  },
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

  const result = await ctx.step(`measure-${cell.name}`, async () => {
    const cellResult = await runCell(storage!, cell, getOperations());
    if (!cellResult.valid) {
      // The runner prints only errorCode for failed tasks, so log the real
      // failure (dominant class + a sample message) for CI visibility.
      const errorRates = [
        ['THROTTLE', cellResult.throttleRate],
        ['TIMEOUT', cellResult.timeoutRate],
        ['CONN_ERROR', cellResult.connectionErrorRate],
        ['NOT_FOUND', cellResult.notFoundRate],
        ['SERVER', cellResult.serverErrorRate],
        ['CLIENT', cellResult.clientErrorRate],
      ] as const;
      const [dominantClass, dominantRate] = errorRates.reduce((top, entry) => (entry[1] > top[1] ? entry : top));
      const sample = cellResult.errorSamples[dominantClass];
      const detail = `successRate=${cellResult.successRate} ${dominantClass}=${dominantRate}${sample ? ` — ${sample}` : ''}`;
      console.log(`  [${ctx.participant.name}] ${cell.name} invalid: ${detail}`);
      const message = `${cell.name} failed for ${ctx.participant.name}: ${detail}`;
      throw new TaskError(message, {
        code: 'cell_invalid',
        data: { ...cellResult, errorMessage: message } as unknown as NonNullable<InstanceType<typeof TaskError>['data']>,
      });
    }
    return cellResult;
  });

  return { data: { ...result } };
});
