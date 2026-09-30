/**
 * Seed or verify the deterministic corpus used by storage-concurrency.bench.ts.
 *
 * Full seed (idempotent, checks every key):
 *   pnpm bench:storage-concurrency:seed -- --provider aws-s3
 *
 * Cheap verification (checks 100 evenly distributed keys):
 *   pnpm bench:storage-concurrency:seed -- --verify --provider aws-s3
 */
import '../src/env.js';
import type { Storage } from '@storagesdk/core';
import { isStorageProviderAvailable, storageProviders } from './providers.js';
import type { StorageProviderConfig } from './types.js';
import { corpusBody, corpusKey, OBJECT_COUNT, OBJECT_SIZE_BYTES } from './storage-concurrency-corpus.js';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';

const DEFAULT_CONCURRENCY = 16;
const REQUEST_TIMEOUT_MS = 30_000;
const VERIFY_SAMPLE_SIZE = 100;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function positiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be an integer >= 1`);
  }
  return parsed;
}

function selectedProviders(): StorageProviderConfig[] {
  const requested = argValue('--provider')
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const candidates = requested
    ? storageProviders.filter((provider) => requested.includes(provider.name))
    : storageProviders;
  const unavailable = candidates.filter((provider) =>
    provider.requiredEnvVars.some((name) => !process.env[name]),
  );
  const available = candidates.filter(
    (provider) => !unavailable.includes(provider) && isStorageProviderAvailable(provider),
  );
  for (const provider of unavailable) {
    console.log(`Skipping ${provider.name}: missing required credentials`);
  }
  if (available.length === 0) {
    throw new Error('No selected storage providers have complete credentials');
  }
  return available;
}

function verifyIndexes(): number[] {
  return Array.from(
    { length: VERIFY_SAMPLE_SIZE },
    (_, sample) => Math.floor((sample * OBJECT_COUNT) / VERIFY_SAMPLE_SIZE),
  );
}

async function runProvider(
  provider: StorageProviderConfig,
  verifyOnly: boolean,
  concurrency: number,
): Promise<void> {
  const storage = provider.createStorage();
  const body = corpusBody();
  const indexes = verifyOnly ? verifyIndexes() : Array.from({ length: OBJECT_COUNT }, (_, i) => i);
  let present = 0;
  let seeded = 0;
  let invalid = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const position = cursor++;
      if (position >= indexes.length) return;
      const index = indexes[position];
      const key = corpusKey(index);
      try {
        const metadata = await withTimeout(
          storage.head(key),
          REQUEST_TIMEOUT_MS,
          `HEAD timed out for ${key}`,
        );
        if (metadata.size === OBJECT_SIZE_BYTES) {
          present++;
          continue;
        }
        invalid++;
      } catch {
        // A missing object is expected during a full seed.
      }

      if (verifyOnly) continue;
      await withTimeout(
        storage.upload(key, body, {
          contentType: 'application/octet-stream',
          cacheControl: 'no-store',
        }),
        REQUEST_TIMEOUT_MS,
        `PUT timed out for ${key}`,
      );
      seeded++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const expected = indexes.length;
  const mode = verifyOnly ? 'verified' : 'checked';
  console.log(
    `[${provider.name}] ${mode} ${expected} objects: present=${present}, seeded=${seeded}, invalid=${invalid}`,
  );
  if (verifyOnly && (present !== expected || invalid > 0)) {
    throw new Error(`[${provider.name}] corpus verification failed`);
  }
}

const verifyOnly = hasFlag('--verify');
const concurrency = positiveInt(argValue('--concurrency'), DEFAULT_CONCURRENCY, '--concurrency');

const failures: string[] = [];
for (const provider of selectedProviders()) {
  try {
    await runProvider(provider, verifyOnly, concurrency);
  } catch (error) {
    const message = `${provider.name}: ${formatError(error)}`;
    failures.push(message);
    console.error(`Skipping provider after seed failure: ${message}`);
  }
}

if (failures.length > 0) {
  console.error(`Corpus seeding completed with ${failures.length} provider failure(s)`);
}
