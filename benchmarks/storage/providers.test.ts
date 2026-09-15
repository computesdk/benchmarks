import assert from 'node:assert/strict';
import { normalizeGcsPrivateKey } from './providers.js';

const pemBody = 'abc\\ndef';
assert.equal(normalizeGcsPrivateKey(pemBody), 'abc\ndef');
assert.equal(normalizeGcsPrivateKey(JSON.stringify(pemBody)), 'abc\ndef');
assert.equal(normalizeGcsPrivateKey('abc\r\ndef'), 'abc\ndef');

console.log('Storage provider credential normalization checks passed');
