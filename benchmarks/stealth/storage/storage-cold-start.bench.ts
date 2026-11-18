/**
 * Storage Cold First Request.
 *
 * What a short-lived sandbox or serverless invocation pays on its FIRST
 * storage request from a fresh process: DNS, TCP + TLS, client construction,
 * and any auth/token fetch (GCS OAuth exchange, Vercel Blob token, Tensorlake
 * API). storage-concurrency throws exactly this away as warmup.
 *
 * Each iteration spawns two fresh Node children (storage-cold-start-worker.ts):
 * one does GET, GET on the pre-seeded probe object; the other does PUT, PUT to
 * two new per-run keys. The first request in each child is the cold one, the
 * second the warm one. Children run in alternating order and are spaced apart
 * (default 5 s) so provider-side connection reuse is less likely.
 *
 *   pnpm bench benchmarks/stealth/storage/storage-cold-start.bench.ts --provider aws-s3 --iterations 1 --no-ingest
 */
import '../src/env.js';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { BenchmarkDisplayConfig, BenchmarkScoringConfig } from '@benchsdk/runner';
import type { Storage } from '@storagesdk/core';
import { isStorageProviderAvailable, storageProviders } from './providers.js';
import type { StorageProviderConfig } from './types.js';
import { formatError } from '../src/util/error.js';
import { withTimeout } from '../src/util/timeout.js';
import {
  PROBE_KEY,
  PROBE_SIZE_BYTES,
  childOrder,
  parseWorkerOutput,
  probeBody,
  processSpawnMs,
  putKeys,
  round,
  runPrefix,
  type WorkerOp,
  type WorkerResult,
} from './storage-cold-start.js';
import { writeStorageColdStartResults } from './storage-cold-start-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'storage-cold-start-worker.ts');
const TSX_LOADER = import.meta.resolve('tsx');
const WORKER_TIMEOUT_MS = 90_000;
const SEED_TIMEOUT_MS = 30_000;
const DEFAULT_SPACING_MS = 5_000;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function spacingMs(): number {
  const raw = argValue('--spacing-ms') ?? process.env.STORAGE_COLD_START_SPACING_MS;
  if (raw === undefined) return DEFAULT_SPACING_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error('--spacing-ms must be an integer >= 0');
  return value;
}

const RUN_PREFIX = runPrefix(argValue('--run-key') ?? String(Date.now()), randomBytes(3).toString('hex'));
const parentStorage = new Map<string, Storage>();
let spawnedOnce = false;

function storageFor(participant: StorageProviderConfig): Storage {
  let storage = parentStorage.get(participant.name);
  if (!storage) {
    storage = participant.createStorage();
    parentStorage.set(participant.name, storage);
  }
  return storage;
}

/** Idempotent: HEAD the probe and upload it only when missing or the wrong size. */
async function ensureProbe(storage: Storage): Promise<'present' | 'seeded'> {
  try {
    const meta = await withTimeout(storage.head(PROBE_KEY), SEED_TIMEOUT_MS, 'probe HEAD timed out');
    if (meta.size === PROBE_SIZE_BYTES) return 'present';
  } catch {
    // Missing probe: seed it below.
  }
  await withTimeout(
    storage.upload(PROBE_KEY, probeBody(0), { contentType: 'application/octet-stream', cacheControl: 'no-store' }),
    SEED_TIMEOUT_MS,
    'probe PUT timed out',
  );
  return 'seeded';
}

interface ChildRun {
  result: WorkerResult;
  processSpawnMs: number;
  childWallMs: number;
}

async function runChild(provider: string, op: WorkerOp, key: string, warmKey?: string): Promise<ChildRun> {
  const gap = spacingMs();
  if (spawnedOnce && gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
  spawnedOnce = true;

  const args = ['--import', TSX_LOADER, WORKER_PATH, '--provider', provider, '--op', op, '--key', key];
  if (warmKey) args.push('--warm-key', warmKey);
  const spawnEpochMs = performance.timeOrigin + performance.now();
  const startedAt = performance.now();
  const child = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${op} worker timed out after ${WORKER_TIMEOUT_MS} ms`));
    }, WORKER_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  const childWallMs = round(performance.now() - startedAt);
  let result: WorkerResult;
  try {
    result = parseWorkerOutput(stdout);
  } catch (error) {
    throw new Error(`${op} worker exited ${exitCode}: ${formatError(error)}; stderr: ${stderr.slice(-300).trim()}`);
  }
  return { result, processSpawnMs: processSpawnMs(spawnEpochMs, result), childWallMs };
}

const msMetric = (key: string, label: string, order: number) =>
  ({ key, label, unit: 'ms', direction: 'lower-better' as const, decimals: 1, order });

const display: BenchmarkDisplayConfig = {
  metrics: [
    msMetric('coldGetMs', 'Cold GET (first request)', 0),
    msMetric('warmGetMs', 'Warm GET (same process)', 1),
    msMetric('coldPenaltyMs', 'Cold penalty (cold GET - warm GET)', 2),
    msMetric('coldPutMs', 'Cold PUT (first request)', 3),
    msMetric('warmPutMs', 'Warm PUT (same process)', 4),
    msMetric('putColdPenaltyMs', 'PUT cold penalty (cold PUT - warm PUT)', 5),
    msMetric('clientInitMs', 'Client construction', 6),
    msMetric('processSpawnMs', 'Process spawn (excluded from score)', 7),
  ],
  steps: [
    { key: 'seed-probe', label: 'Ensure probe object', order: 0 },
    { key: 'cold-get', label: 'Fresh process: GET, GET', order: 1 },
    { key: 'cold-put', label: 'Fresh process: PUT, PUT', order: 2 },
    { key: 'cleanup', label: 'Delete per-run objects', order: 3 },
  ],
  overview: { defaultMetric: 'coldGetMs', defaultLayout: 'ranking' },
  byStep: { hiddenSteps: ['seed-probe', 'cleanup'] },
};

const scoring: BenchmarkScoringConfig = {
  metrics: [
    { key: 'coldGetMs', unit: 'ms', higherIsBetter: false, ceiling: 2_000, weights: { median: 0.45, p95: 0.15, p99: 0 } },
    { key: 'coldPutMs', unit: 'ms', higherIsBetter: false, ceiling: 2_000, weights: { median: 0.2, p95: 0.05, p99: 0 } },
    { key: 'coldPenaltyMs', unit: 'ms', higherIsBetter: false, ceiling: 1_500, weights: { median: 0.1, p95: 0, p99: 0 } },
    { key: 'clientInitMs', unit: 'ms', higherIsBetter: false, ceiling: 250, weights: { median: 0.05, p95: 0, p99: 0 } },
    { key: 'warmGetMs', unit: 'ms', higherIsBetter: false, ceiling: 1_000, weights: { median: 0, p95: 0, p99: 0 } },
    { key: 'warmPutMs', unit: 'ms', higherIsBetter: false, ceiling: 1_000, weights: { median: 0, p95: 0, p99: 0 } },
    { key: 'putColdPenaltyMs', unit: 'ms', higherIsBetter: false, ceiling: 1_500, weights: { median: 0, p95: 0, p99: 0 } },
    { key: 'processSpawnMs', unit: 'ms', higherIsBetter: false, ceiling: 5_000, weights: { median: 0, p95: 0, p99: 0 } },
  ],
};

export const config = defineBenchmarkConfig<StorageProviderConfig>({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'storage-cold-start',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Storage Cold First Request',
  iterations: 20,
  concurrency: 1,
  groupBy: 'participant',
  participants: storageProviders.filter(isStorageProviderAvailable),
  customCliFlags: ['--spacing-ms'],
  display,
  scoring,
  onComplete: (outcome) => writeStorageColdStartResults(outcome, { scoring, display }),
});

type Data = Record<string, number | string>;

export const task = defineTask<StorageProviderConfig>(async (ctx) => {
  const provider = ctx.participant.name;
  const keys = putKeys(RUN_PREFIX, ctx.taskIndex);
  const order = childOrder(ctx.taskIndex);
  const data: Data = { order: `${order[0]}-first` };
  const errors: string[] = [];

  const attempt = async (name: string, fn: () => Promise<Data>): Promise<void> => {
    try {
      Object.assign(data, await ctx.step(name, fn));
    } catch (error) {
      const detail = (error as { data?: Data }).data;
      if (detail) Object.assign(data, detail);
      errors.push(`${name}: ${formatError(error)}`);
    }
  };

  const childStep = (op: WorkerOp) => async (): Promise<Data> => {
    const run = await runChild(provider, op, op === 'get' ? PROBE_KEY : keys.cold, op === 'put' ? keys.warm : undefined);
    const { result } = run;
    const prefix = op === 'get' ? '' : 'put';
    const cap = (s: string) => (prefix ? `${prefix}${s[0].toUpperCase()}${s.slice(1)}` : s);
    const measured: Data = {
      [cap('processSpawnMs')]: run.processSpawnMs,
      [cap('childWallMs')]: run.childWallMs,
      ...(result.clientInitMs !== undefined ? { [cap('clientInitMs')]: result.clientInitMs } : {}),
    };
    if (result.ok && result.coldMs !== undefined && result.warmMs !== undefined) {
      const cold = op === 'get' ? 'coldGetMs' : 'coldPutMs';
      const warm = op === 'get' ? 'warmGetMs' : 'warmPutMs';
      const penalty = op === 'get' ? 'coldPenaltyMs' : 'putColdPenaltyMs';
      measured[cold] = result.coldMs;
      measured[warm] = result.warmMs;
      measured[penalty] = round(result.coldMs - result.warmMs);
    }
    ctx.measure(measured);
    if (!result.ok) {
      throw new TaskError(`${op} worker failed at ${result.stage}: ${result.error}`, {
        code: `${op}_${result.stage ?? 'failed'}`.replace(/-/g, '_'),
        data: measured,
      });
    }
    return measured;
  };

  try {
    await attempt('seed-probe', async () => ({ probe: await ensureProbe(storageFor(ctx.participant)) }));
    for (const op of order) {
      await attempt(op === 'get' ? 'cold-get' : 'cold-put', childStep(op));
    }
  } finally {
    await ctx
      .step(
        'cleanup',
        async () => {
          const storage = storageFor(ctx.participant);
          await Promise.all([keys.cold, keys.warm].map((key) =>
            withTimeout(storage.delete(key), SEED_TIMEOUT_MS, `delete timed out for ${key}`).catch((error) => {
              // A failed cold PUT never created its key; anything else is worth a warning.
              ctx.log(`cleanup ${key}: ${formatError(error)}`, { level: 'warn' });
            }),
          ));
        },
        { reportConcurrency: false },
      )
      .catch((error) => ctx.log(`cleanup failed: ${formatError(error)}`, { level: 'warn' }));
  }

  if (errors.length > 0) {
    const message = errors.join(' | ');
    console.log(`  [${provider}] iteration ${ctx.taskIndex} failed: ${message}`);
    throw new TaskError(message, { code: 'cold_start_failed', data: { ...data, errorMessage: message } });
  }
  return { data };
});
