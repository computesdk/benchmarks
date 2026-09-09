import assert from 'node:assert/strict';
import { requestKey } from './storage-concurrency-corpus.js';

function prefix(key: string): string {
  return key.split('/')[2]!;
}

const workerZeroKeys = Array.from(
  { length: 32 },
  (_, opSeq) => requestKey(0, opSeq, 'SINGLE_PREFIX'),
);
const workerOneKeys = Array.from(
  { length: 32 },
  (_, opSeq) => requestKey(1, opSeq, 'SINGLE_PREFIX'),
);

assert.ok(workerZeroKeys.every((key) => prefix(key) === 'p00'));
assert.ok(workerOneKeys.every((key) => prefix(key) === 'p00'));
assert.notDeepEqual(workerZeroKeys, workerOneKeys);

const singlePrefixKeys = new Set(
  Array.from({ length: 128 }, (_, workerId) =>
    requestKey(workerId, 0, 'SINGLE_PREFIX'),
  ),
);
assert.equal(singlePrefixKeys.size, 128);

console.log('Storage concurrency corpus key distribution checks passed');
