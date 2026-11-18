/**
 * Child process for storage-cold-start. The parent spawns a fresh Node process
 * per measurement, so nothing is shared with earlier requests: no connection
 * pool, keep-alive agent, in-process DNS cache, or auth-token cache.
 *
 *   tsx benchmarks/stealth/storage/storage-cold-start-worker.ts --provider aws-s3 --op get --key <k>
 *   tsx benchmarks/stealth/storage/storage-cold-start-worker.ts --provider aws-s3 --op put --key <k> --warm-key <k2>
 *
 * Prints exactly one `STORAGE_COLD_START_RESULT {json}` line and exits 0;
 * failures are reported inside the JSON (`ok: false`, `stage`, `error`).
 */
import '../src/env.js';
import type { Storage } from '@storagesdk/core';
import { storageProviders } from './providers.js';
import { formatError } from '../src/util/error.js';
import { withTimeout } from '../src/util/timeout.js';
import {
  PROBE_SHA256,
  PROBE_SIZE_BYTES,
  RESULT_MARKER,
  probeBody,
  round,
  sha256,
  type WorkerOp,
  type WorkerResult,
} from './storage-cold-start.js';

const readyAtMs = performance.now();
const REQUEST_TIMEOUT_MS = 30_000;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const provider = arg('--provider') ?? '';
const op = arg('--op') as WorkerOp;
const key = arg('--key') ?? '';
const warmKey = arg('--warm-key') ?? key;

const result: WorkerResult = { ok: false, op, provider, timeOrigin: performance.timeOrigin, readyAtMs };

async function timed(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return round(performance.now() - start);
}

async function get(storage: Storage, path: string): Promise<void> {
  const bytes = await withTimeout(storage.download(path, { as: 'bytes' }), REQUEST_TIMEOUT_MS, `GET timed out for ${path}`);
  if (bytes.byteLength !== PROBE_SIZE_BYTES || sha256(bytes) !== PROBE_SHA256) {
    throw Object.assign(new Error(`probe content mismatch (${bytes.byteLength} bytes)`), { stage: 'verify' });
  }
}

async function put(storage: Storage, path: string, seed: number): Promise<void> {
  await withTimeout(
    storage.upload(path, probeBody(seed), { contentType: 'application/octet-stream', cacheControl: 'no-store' }),
    REQUEST_TIMEOUT_MS,
    `PUT timed out for ${path}`,
  );
}

let stage = 'args';
try {
  const config = storageProviders.find((p) => p.name === provider);
  if (!config) throw new Error(`unknown provider: ${provider}`);
  if (op !== 'get' && op !== 'put') throw new Error(`--op must be get or put, got ${String(op)}`);
  if (!key) throw new Error('--key is required');

  stage = 'client-init';
  let storage!: Storage;
  result.clientInitMs = await timed(async () => {
    storage = config.createStorage();
  });

  stage = 'cold';
  result.coldMs = await timed(() => (op === 'get' ? get(storage, key) : put(storage, key, 1)));
  stage = 'warm';
  result.warmMs = await timed(() => (op === 'get' ? get(storage, key) : put(storage, warmKey, 2)));
  result.ok = true;
  delete result.stage;
} catch (error) {
  result.stage = (error as { stage?: string }).stage ?? stage;
  result.error = formatError(error).slice(0, 500);
}

process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
// Adapters may hold keep-alive sockets open; this process is single-use.
process.exit(0);
