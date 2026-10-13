import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BenchmarkRunOutcome } from '@benchsdk/runner';
import { scoreStorageConcurrencyProvider } from './storage-concurrency-scoring.js';

export const STORAGE_CONCURRENCY_RESULTS_DIR = path.resolve('results/storage-concurrency');
export const STORAGE_CONCURRENCY_RESULTS_PATH = path.join(
  STORAGE_CONCURRENCY_RESULTS_DIR,
  'latest.json',
);

export interface StorageConcurrencyCellResult {
  phase: string;
  operations: number;
  measuredOperations: number;
  concurrency: number;
  keyDistribution: 'SINGLE_PREFIX' | 'SPREAD_64';
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
  maxActiveRequests: number;
}

export interface StorageConcurrencyProviderResult {
  provider: string;
  cells: StorageConcurrencyCellResult[];
  compositeScore: number;
  successRate: number;
  validCellRate: number;
}

export interface StorageConcurrencyResults {
  version: '1.0';
  timestamp: string;
  runId: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
  };
  results: StorageConcurrencyProviderResult[];
}

function isCellResult(value: unknown): value is StorageConcurrencyCellResult {
  return typeof value === 'object' && value !== null
    && typeof (value as { phase?: unknown }).phase === 'string'
    && typeof (value as { concurrency?: unknown }).concurrency === 'number'
    && typeof (value as { throughputOpsPerSecond?: unknown }).throughputOpsPerSecond === 'number';
}

export function writeStorageConcurrencyResults(
  outcome: BenchmarkRunOutcome,
): void {
  const results: StorageConcurrencyProviderResult[] = outcome.participants.map((participant) => {
    const result = {
      provider: participant.participant,
      cells: participant.records.flatMap((record) => {
        const data = record.data;
        return isCellResult(data) ? [data] : [];
      }),
    };
    return { ...result, ...scoreStorageConcurrencyProvider(result) };
  });

  const output: StorageConcurrencyResults = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    runId: outcome.runId,
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    results,
  };

  fs.mkdirSync(STORAGE_CONCURRENCY_RESULTS_DIR, { recursive: true });
  fs.writeFileSync(STORAGE_CONCURRENCY_RESULTS_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Storage concurrency results written to ${STORAGE_CONCURRENCY_RESULTS_PATH}`);
}
