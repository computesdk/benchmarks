import assert from 'node:assert/strict';
import {
  PROBE_KEY,
  PROBE_SHA256,
  PROBE_SIZE_BYTES,
  RESULT_MARKER,
  childOrder,
  median,
  p95,
  parseWorkerOutput,
  probeBody,
  processSpawnMs,
  putKeys,
  runPrefix,
  sha256,
} from './storage-cold-start.js';

// Probe content is deterministic and 1 KiB; PUT bodies differ from it.
assert.equal(probeBody().byteLength, PROBE_SIZE_BYTES);
assert.equal(sha256(probeBody()), sha256(probeBody(0)));
assert.equal(sha256(probeBody(0)), PROBE_SHA256);
assert.notEqual(sha256(probeBody(1)), PROBE_SHA256);
assert.equal(PROBE_KEY, 'bench/storage-cold-start/corpus/v1/probe.bin');

// Per-run keys live under a unique run prefix, never under the corpus.
const prefix = runPrefix('123-1', 'abc123');
assert.equal(prefix, 'bench/storage-cold-start/run-123-1-abc123/');
assert.equal(runPrefix('a/b c', 'x'), 'bench/storage-cold-start/run-a_b_c-x/');
const keys = putKeys(prefix, 4);
assert.equal(keys.cold, `${prefix}iter-4-cold.bin`);
assert.notEqual(keys.cold, keys.warm);
assert.ok(!keys.cold.includes('/corpus/'));

// Child order alternates so neither child always runs second.
assert.deepEqual(childOrder(0), ['get', 'put']);
assert.deepEqual(childOrder(1), ['put', 'get']);

// Worker output: last marker line wins, noise before it is ignored.
const line = { ok: true, op: 'get', provider: 'aws-s3', timeOrigin: 1000, readyAtMs: 250, coldMs: 90, warmMs: 20 };
const parsed = parseWorkerOutput(`warning: noise\n${RESULT_MARKER}${JSON.stringify(line)}\n`);
assert.equal(parsed.coldMs, 90);
assert.throws(() => parseWorkerOutput('no marker here'), /no result line/);
assert.throws(() => parseWorkerOutput(`${RESULT_MARKER}${JSON.stringify({ ...line, op: 'x' })}`), /invalid op/);

// Spawn time = child main-body start (epoch) - parent spawn (epoch).
assert.equal(processSpawnMs(1000, { timeOrigin: 1100, readyAtMs: 400.5 }), 500.5);

// Stats helpers.
assert.equal(median([]), null);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 2, 3]), 2.5);
assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19);

console.log('storage-cold-start helper tests passed');
