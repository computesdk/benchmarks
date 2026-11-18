import assert from 'node:assert/strict';
import { burstLegacyScore, completedRate, medianOfCompleted, soakLegacyScore } from './scoring-capabilities.js';

const burst = (tti: number) => ({
  status: 'success',
  data: { alivePct: 100, ttiMaxMs: tti, ttiMedianMs: tti, destroyMs: 100 },
});

// Runner/platform retain hundredths; legacy tenths collapsed these two
// different measurements into the same score.
assert.equal(burstLegacyScore([burst(100)]), 99.74);
assert.equal(burstLegacyScore([burst(105)]), 99.73);
assert.equal(burstLegacyScore([burst(100), { status: 'error', data: { alivePct: 100 } }]), 49.87);
assert.equal(completedRate([]), 0);

// A completed zero-ms sample is valid and earns full speed credit; absent
// samples earn none. A failure's partial measurement is not a scored sample.
assert.equal(burstLegacyScore([{ status: 'success', data: { alivePct: 100, ttiMaxMs: 0, ttiMedianMs: 0, destroyMs: 0 } }]), 100);
assert.equal(burstLegacyScore([{ status: 'success', data: { alivePct: 100 } }]), 85);
assert.equal(medianOfCompleted([burst(100), { status: 'error', data: { ttiMaxMs: 0 } }], 'ttiMaxMs'), 100);
assert.equal(burstLegacyScore([{ status: 'error', data: { alivePct: 100, ttiMaxMs: 0 } }]), 0);

const good = { status: 'success', data: { measured: true, uptimePct: 100, integrityPct: 100 } };
assert.equal(soakLegacyScore([good]), 100);
assert.equal(soakLegacyScore([good, { status: 'error', data: { measured: false, uptimePct: 0 } }]), 50);
assert.equal(soakLegacyScore([{ status: 'success', data: { measured: true, uptimePct: 80, integrityPct: 100 } }]), 86);
assert.equal(soakLegacyScore([{ status: 'success', data: { measured: false, uptimePct: 100, integrityPct: 100 } }]), 0);
assert.equal(soakLegacyScore([]), 0);

console.log('capability legacy scoring fixtures passed');
