/** Pure fixture contract; execution deferred to stage five after PR creation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskResultRecord } from '@benchsdk/client';
import { browserRecordEvidence } from './browsers-record-evidence.js';

test('retain task status and identity so a partial failure cannot become a successful legacy iteration', () => {
  const records = [
    { taskIndex: 0, status: 'success', data: { reconnectMs: 0, resumeSupported: 1 }, latencyMs: 0 },
    { taskIndex: 1, status: 'error', data: { resumeSupported: 1 }, errorCode: 'VERIFY_FAILED' },
  ] as TaskResultRecord[];
  const evidence = browserRecordEvidence(records);
  assert.deepEqual(evidence, records);
  assert.notEqual(evidence[0], records[0]);
  assert.equal(evidence[0].data?.reconnectMs, 0);
  assert.equal(evidence[1].status, 'error');
  assert.equal(evidence[1].errorCode, 'VERIFY_FAILED');
  assert.deepEqual(browserRecordEvidence([]), []);
});
