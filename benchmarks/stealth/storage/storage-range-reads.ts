/**
 * Pure helpers for storage-range-reads.bench.ts: the deterministic 1 GiB
 * fixture, seeded range offsets, cell definitions, and the per-cell verdict.
 * Nothing here talks to a provider, so it is unit-tested directly.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

export const FIXTURE_KEY = 'bench/storage-range-reads/corpus/v1/blob-1g.bin';
export const FIXTURE_SIZE_BYTES = 1024 * 1024 * 1024;
/** Fixed content seed. Changing it changes every byte, so bump the corpus `v1` too. */
export const FIXTURE_CONTENT_SEED = 0x5eed_0001;

export const DEFAULT_RANGE_READS = 200;
export const KIB = 1024;
export const MIB = 1024 * 1024;

/**
 * If the bytes that crossed the network are more than this many times the
 * bytes we asked for, the adapter is downloading more than the range (e.g.
 * the whole object) and slicing it locally.
 */
export const CLIENT_SLICED_AMPLIFICATION = 8;

export interface RangeCell {
  /** Phase name and step suffix, e.g. `1mib-c16`. */
  name: string;
  rangeBytes: number;
  rangeLabel: string;
  concurrency: number;
}

export const RANGE_CELLS: RangeCell[] = [
  { bytes: 64 * KIB, label: '64 KiB', slug: '64kib' },
  { bytes: 1 * MIB, label: '1 MiB', slug: '1mib' },
].flatMap((size) => [1, 16].map((concurrency) => ({
  name: `${size.slug}-c${concurrency}`,
  rangeBytes: size.bytes,
  rangeLabel: size.label,
  concurrency,
})));

export const HEADLINE_CELL = '1mib-c16';

export type RangeMode = 'native' | 'client-sliced' | 'unsupported';

/**
 * What each StorageSDK adapter's `download({ range })` does, from reading
 * @storagesdk/adapters 0.11.0 source. Every one forwards the range to the
 * backend; none fetches the full body and slices it. The bench still checks
 * this at run time (wrong sizes + bytes on the wire) in `observedRangeMode`.
 */
export const INSPECTED_RANGE_MODE: Record<string, { mode: RangeMode; how: string }> = {
  'aws-s3': { mode: 'native', how: 'GetObject with Range: bytes=N-M' },
  'cloudflare-r2': { mode: 'native', how: 's3 adapter (GetObject Range)' },
  tigris: { mode: 'native', how: '@tigrisdata/storage get({ range }) -> Range header' },
  'vercel-blob': { mode: 'native', how: '@vercel/blob get with a Range header' },
  gcs: { mode: 'native', how: 'file.createReadStream({ start, end })' },
  'azure-blob': { mode: 'native', how: 'blob.download(offset, count)' },
  tensorlake: { mode: 'native', how: 'readFileWithMetadata({ range }), served by Artifact Storage' },
  archil: { mode: 'native', how: 's3 adapter (GetObject Range)' },
  neon: { mode: 'native', how: 's3 adapter (GetObject Range)' },
};

if (os.endianness() !== 'LE') {
  throw new Error('storage-range-reads fixture generation assumes a little-endian host');
}

/** 32-bit integer hash (lowbias32). Same input, same output, on any machine. */
function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * The fixture's bytes at [offset, offset + length). Byte i of the object is
 * byte (i % 4) of mix32(floor(i / 4) ^ seed), so any slice can be rebuilt
 * locally without keeping 1 GiB around.
 */
export function fixtureBytes(offset: number, length: number, seed = FIXTURE_CONTENT_SEED): Uint8Array {
  const firstWord = Math.floor(offset / 4);
  const endWord = Math.ceil((offset + length) / 4);
  const words = new Uint32Array(endWord - firstWord);
  for (let i = 0; i < words.length; i++) words[i] = mix32((firstWord + i) ^ seed);
  const bytes = new Uint8Array(words.buffer);
  const start = offset - firstWord * 4;
  return bytes.subarray(start, start + length);
}

/** Streams the whole fixture in `chunkBytes` pieces (for the one-time multipart seed). */
export function fixtureStream(size = FIXTURE_SIZE_BYTES, chunkBytes = 8 * MIB): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= size) {
        controller.close();
        return;
      }
      const length = Math.min(chunkBytes, size - offset);
      controller.enqueue(fixtureBytes(offset, length).slice());
      offset += length;
    },
  });
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string, used to give every cell its own offset stream. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * `count` random byte offsets so that every range [offset, offset + length)
 * sits fully inside the object. Unaligned on purpose.
 */
export function rangeOffsets(seed: number, cellName: string, count: number, length: number, objectSize = FIXTURE_SIZE_BYTES): number[] {
  const random = seededRandom(seed ^ hashString(cellName));
  const span = objectSize - length + 1;
  return Array.from({ length: count }, () => Math.floor(random() * span));
}

/** Default offset seed: the UTC date (YYYYMMDD), so offsets change daily but are reproducible. */
export function defaultOffsetSeed(now = new Date()): number {
  return Number(now.toISOString().slice(0, 10).replaceAll('-', ''));
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Number(sorted[index].toFixed(3));
}

/** Total received bytes on non-loopback interfaces (Linux only, else null). */
export function readNetworkRxBytes(): number | null {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf-8').split('\n').slice(2);
    let total = 0;
    for (const line of lines) {
      const [iface, rest] = line.split(':');
      if (!rest || iface.trim() === 'lo') continue;
      total += Number(rest.trim().split(/\s+/)[0]);
    }
    return total;
  } catch {
    return null;
  }
}

export interface ReadSample {
  latencyMs: number;
  startMs: number;
  endMs: number;
  bytesReturned: number;
  /** `ok`, `wrong-size`, `hash-mismatch`, or `error`. */
  outcome: 'ok' | 'wrong-size' | 'hash-mismatch' | 'error';
  error?: string;
}

export interface RangeCellResult {
  cell: string;
  rangeBytes: number;
  concurrency: number;
  reads: number;
  offsetSeed: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  throughputMBps: number;
  readsPerSec: number;
  bytesRequestedTotal: number;
  bytesReturnedTotal: number;
  hashMismatches: number;
  wrongSizeReads: number;
  readErrors: number;
  /** Bytes received on the host's network interfaces during the cell (null if unmeasurable). */
  wireRxBytes: number | null;
  /** wireRxBytes / bytesRequestedTotal. ~1 means only the range crossed the wire. */
  wireAmplification: number | null;
  rangeModeInspected: RangeMode;
  rangeMode: RangeMode;
  rangeIgnored: boolean;
  valid: boolean;
  failureReason: string | null;
  errorSample: string | null;
}

/** Final range mode: code inspection, overridden by what the run actually saw. */
export function observedRangeMode(
  inspected: RangeMode,
  samples: ReadSample[],
  rangeBytes: number,
  wireAmplification: number | null,
): RangeMode {
  if (samples.some((s) => s.outcome === 'wrong-size' && s.bytesReturned > rangeBytes)) return 'unsupported';
  if (wireAmplification !== null && wireAmplification > CLIENT_SLICED_AMPLIFICATION) return 'client-sliced';
  return inspected;
}

export function summarizeCell(input: {
  cell: RangeCell;
  offsetSeed: number;
  samples: ReadSample[];
  inspected: RangeMode;
  wireRxBytes: number | null;
}): RangeCellResult {
  const { cell, samples } = input;
  const ok = samples.filter((s) => s.outcome === 'ok');
  const wrongSize = samples.filter((s) => s.outcome === 'wrong-size');
  const mismatches = samples.filter((s) => s.outcome === 'hash-mismatch');
  const errors = samples.filter((s) => s.outcome === 'error');
  const bytesRequestedTotal = samples.length * cell.rangeBytes;
  const bytesReturnedTotal = samples.reduce((sum, s) => sum + s.bytesReturned, 0);
  const start = Math.min(...samples.map((s) => s.startMs));
  const end = Math.max(...samples.map((s) => s.endMs));
  const seconds = Math.max((end - start) / 1000, Number.EPSILON);
  const wireAmplification = input.wireRxBytes === null || bytesRequestedTotal === 0
    ? null
    : Number((input.wireRxBytes / bytesRequestedTotal).toFixed(3));
  const rangeMode = observedRangeMode(input.inspected, samples, cell.rangeBytes, wireAmplification);
  const rangeIgnored = rangeMode !== 'native';
  const latencies = ok.map((s) => s.latencyMs);

  const reasons: string[] = [];
  if (rangeMode === 'unsupported') reasons.push('range ignored: provider returned more bytes than requested');
  if (rangeMode === 'client-sliced') reasons.push(`client-sliced: ${wireAmplification}x the requested bytes crossed the network`);
  if (wrongSize.length > 0) reasons.push(`${wrongSize.length} wrong-size read(s) (e.g. ${wrongSize[0].bytesReturned} bytes for a ${cell.rangeBytes}-byte range)`);
  if (mismatches.length > 0) reasons.push(`${mismatches.length} read(s) returned corrupted bytes (sha256 mismatch)`);
  if (errors.length > 0) reasons.push(`${errors.length} read(s) failed: ${errors[0].error ?? 'unknown error'}`);

  return {
    cell: cell.name,
    rangeBytes: cell.rangeBytes,
    concurrency: cell.concurrency,
    reads: samples.length,
    offsetSeed: input.offsetSeed,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    throughputMBps: Number((ok.reduce((sum, s) => sum + s.bytesReturned, 0) / MIB / seconds).toFixed(3)),
    readsPerSec: Number((ok.length / seconds).toFixed(3)),
    bytesRequestedTotal,
    bytesReturnedTotal,
    hashMismatches: mismatches.length,
    wrongSizeReads: wrongSize.length,
    readErrors: errors.length,
    wireRxBytes: input.wireRxBytes,
    wireAmplification,
    rangeModeInspected: input.inspected,
    rangeMode,
    rangeIgnored,
    valid: reasons.length === 0 && ok.length === samples.length && samples.length > 0,
    failureReason: reasons.length > 0 ? reasons.join('; ') : null,
    errorSample: errors[0]?.error ?? null,
  };
}
