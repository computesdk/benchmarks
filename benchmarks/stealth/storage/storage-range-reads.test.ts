import assert from 'node:assert/strict';
import {
  FIXTURE_SIZE_BYTES,
  KIB,
  MIB,
  RANGE_CELLS,
  defaultOffsetSeed,
  fixtureBytes,
  fixtureStream,
  rangeOffsets,
  sha256,
  summarizeCell,
  type ReadSample,
} from './storage-range-reads.js';

// Deterministic content: same slice every time, and any sub-slice equals the
// matching window of a bigger slice (offset-keyed, not stream-keyed).
const big = fixtureBytes(1_000, 4 * KIB).slice();
assert.equal(sha256(fixtureBytes(1_000, 4 * KIB)), sha256(big));
for (const [offset, length] of [[1_000, 1], [1_001, 3], [1_003, 517], [2_222, 1_777]] as const) {
  assert.deepEqual(fixtureBytes(offset, length), big.subarray(offset - 1_000, offset - 1_000 + length));
}
assert.notEqual(sha256(fixtureBytes(0, 64 * KIB)), sha256(fixtureBytes(64 * KIB, 64 * KIB)));
assert.equal(fixtureBytes(FIXTURE_SIZE_BYTES - 5, 5).byteLength, 5);

// The upload stream produces exactly the same bytes as fixtureBytes.
const streamSize = 3 * MIB + 7;
const chunks: Uint8Array[] = [];
const reader = fixtureStream(streamSize, MIB).getReader();
for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
const streamed = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
let at = 0;
for (const chunk of chunks) { streamed.set(chunk, at); at += chunk.byteLength; }
assert.equal(streamed.byteLength, streamSize);
assert.equal(sha256(streamed), sha256(fixtureBytes(0, streamSize)));

// Offsets: seeded, in bounds, distinct per cell.
const a = rangeOffsets(20261104, '1mib-c16', 200, MIB);
assert.deepEqual(a, rangeOffsets(20261104, '1mib-c16', 200, MIB));
assert.notDeepEqual(a, rangeOffsets(20261104, '1mib-c1', 200, MIB));
assert.ok(a.every((o) => o >= 0 && o + MIB <= FIXTURE_SIZE_BYTES && Number.isInteger(o)));
assert.equal(defaultOffsetSeed(new Date('2026-11-04T09:00:00Z')), 20261104);

assert.deepEqual(RANGE_CELLS.map((c) => c.name), ['64kib-c1', '64kib-c16', '1mib-c1', '1mib-c16']);

// Verdicts.
const cell = RANGE_CELLS[2];
const sample = (over: Partial<ReadSample> = {}): ReadSample => ({
  latencyMs: 10, startMs: 0, endMs: 10, bytesReturned: MIB, outcome: 'ok', ...over,
});
const good = summarizeCell({ cell, offsetSeed: 1, samples: Array.from({ length: 10 }, () => sample()), inspected: 'native', wireRxBytes: 11 * MIB });
assert.equal(good.valid, true);
assert.equal(good.rangeMode, 'native');
assert.equal(good.bytesRequestedTotal, 10 * MIB);
assert.equal(good.wireAmplification, 1.1);

const ignored = summarizeCell({ cell, offsetSeed: 1, samples: [sample(), sample({ bytesReturned: FIXTURE_SIZE_BYTES, outcome: 'wrong-size' })], inspected: 'native', wireRxBytes: null });
assert.equal(ignored.valid, false);
assert.equal(ignored.rangeMode, 'unsupported');
assert.equal(ignored.rangeIgnored, true);
assert.equal(ignored.wrongSizeReads, 1);
assert.match(ignored.failureReason ?? '', /range ignored/);

const sliced = summarizeCell({ cell, offsetSeed: 1, samples: [sample()], inspected: 'native', wireRxBytes: 1024 * MIB });
assert.equal(sliced.rangeMode, 'client-sliced');
assert.equal(sliced.valid, false);

const corrupt = summarizeCell({ cell, offsetSeed: 1, samples: [sample(), sample({ outcome: 'hash-mismatch' })], inspected: 'native', wireRxBytes: null });
assert.equal(corrupt.valid, false);
assert.equal(corrupt.hashMismatches, 1);
assert.equal(corrupt.rangeMode, 'native');

const short = summarizeCell({ cell, offsetSeed: 1, samples: [sample({ bytesReturned: MIB - 1, outcome: 'wrong-size' })], inspected: 'native', wireRxBytes: null });
assert.equal(short.valid, false);
assert.equal(short.rangeMode, 'native');

console.log('storage-range-reads helper checks passed');
