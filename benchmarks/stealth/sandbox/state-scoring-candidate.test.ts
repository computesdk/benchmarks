import assert from 'node:assert/strict';
import {
  STATE_SCORING_CANDIDATES,
  evaluateStateCandidate,
  stateCandidateUtility,
} from './state-scoring-candidate.js';
import {
  parseStateVolumeNs,
  stateVolumeDurationFields,
  stateVolumeMeasurements,
  stateVolumeRateFields,
} from './state-volume-metrics.js';

// Pure fixtures only. No provider imports, credentials, platform or filesystem writes.
// Execution is intentionally left to the reconciliation stage after PR creation.
const specs = Object.values(STATE_SCORING_CANDIDATES);
assert.equal(specs.length, 6);
for (const spec of specs) {
  const weight = spec.metrics.reduce((sum, m) => sum + m.weights.median + m.weights.p95 + m.weights.p99, 0);
  assert.ok(Math.abs(weight - 1) < 1e-12);
  assert.ok(spec.metrics.every((m) => m.reference > 0 && m.trim === 0.05));
}

const snapshot = STATE_SCORING_CANDIDATES['sandbox-snapshot-stealth'];
const volumes = STATE_SCORING_CANDIDATES['sandbox-volumes-stealth'];
function observation(spec = snapshot, multiplier = 1): { status: 'success'; data: Record<string, unknown> } {
  return {
    status: 'success',
    data: {
      ...spec.requireData,
      [spec.supportKey]: true,
      ...Object.fromEntries(spec.metrics.map((m) => [m.key, m.reference * multiplier])),
    },
  };
}
function close(actual: number | null, expected: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

// Values beyond old ceilings retain their order; exactly equal work stays tied.
close(stateCandidateUtility(2_000, 1_000, false), 100 / 3);
close(stateCandidateUtility(3_000, 1_000, false), 25);
close(stateCandidateUtility(2_000, 1_000, true), 200 / 3);
close(stateCandidateUtility(3_000, 1_000, true), 75);
assert.ok(evaluateStateCandidate(snapshot, [observation(snapshot, 2)]).compositeScore! >
  evaluateStateCandidate(snapshot, [observation(snapshot, 3)]).compositeScore!);
assert.deepEqual(evaluateStateCandidate(snapshot, [observation()]), evaluateStateCandidate(snapshot, [observation()]));

// No observations, unsupported, failed verification and incomplete evidence are distinct.
const absent = evaluateStateCandidate(snapshot, []);
assert.equal(absent.outcome, 'missing');
assert.equal(absent.compositeScore, null);
assert.equal(absent.successRate, null);
const unsupported = observation();
unsupported.data.snapshotSupported = false;
unsupported.data.verifyPassed = false;
assert.equal(evaluateStateCandidate(snapshot, [unsupported]).outcome, 'unsupported');
assert.equal(evaluateStateCandidate(snapshot, [unsupported]).compositeScore, 0);
const failed = observation();
failed.data.verifyPassed = false;
assert.equal(evaluateStateCandidate(snapshot, [failed]).outcome, 'failed');
assert.equal(evaluateStateCandidate(snapshot, [failed]).compositeScore, 0);
assert.equal(evaluateStateCandidate(snapshot, [{ ...observation(), status: 'error' }]).compositeScore, 0);
// Contradictory support metadata cannot pass even with a stale verification flag.
assert.equal(evaluateStateCandidate(snapshot, [{ ...unsupported, data: { ...unsupported.data, verifyPassed: true } }]).compositeScore, 0);

for (const invalid of [undefined, null, NaN, Infinity, -1, '0']) {
  const incomplete = observation();
  incomplete.data.createMs = invalid;
  const result = evaluateStateCandidate(snapshot, [incomplete]);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.compositeScore, null);
  assert.deepEqual(result.invalidMetrics, ['createMs']);
}
const zero = observation();
for (const key of Object.keys(zero.data)) if (typeof zero.data[key] === 'number') zero.data[key] = 0;
close(evaluateStateCandidate(snapshot, [zero]).compositeScore, 100);
close(stateCandidateUtility(0, 1_000, true), 0);
assert.equal(stateCandidateUtility(-1, 1_000, false), null);
assert.equal(stateCandidateUtility(undefined, 1_000, false), null);
assert.throws(() => stateCandidateUtility(1, 0, false), /reference/);
assert.throws(() => evaluateStateCandidate({ ...snapshot, metrics: [] }, []), /no metrics/);
assert.throws(() => evaluateStateCandidate({ ...snapshot, metrics: [snapshot.metrics[0], snapshot.metrics[0]] }, []), /duplicate metric/);
assert.throws(() => evaluateStateCandidate({ ...snapshot, metrics: snapshot.metrics.map((m) => ({ ...m, trim: 0.5 })) }, []), /invalid trim/);
assert.throws(() => evaluateStateCandidate({ ...snapshot, metrics: snapshot.metrics.map((m) => ({ ...m, weights: { median: 0, p95: 0, p99: 0 } })) }, []), /sum to one/);

// Reliability multiplies the score, and failed verification samples cannot skew speed.
const failureWithFastSamples = { ...zero, data: { ...zero.data, verifyPassed: false } };
close(evaluateStateCandidate(snapshot, [observation(), failureWithFastSamples]).compositeScore, 25);
close(evaluateStateCandidate(snapshot, [observation(), failureWithFastSamples]).successRate, 0.5);
// Percentiles come from raw samples BEFORE nonlinear utility (even-N median is material).
const even = evaluateStateCandidate(snapshot, [observation(snapshot, 1), observation(snapshot, 2)]);
close(even.compositeScore, 40);
const trimmed = evaluateStateCandidate(snapshot, Array.from({ length: 20 }, (_, i) => observation(snapshot, i)));
close(trimmed.metrics.createMs.median, snapshot.metrics[0].reference * 9.5);
close(trimmed.metrics.createMs.p95, snapshot.metrics[0].reference * 18);
// Existing latency p95 weights remain on the slow tail in the volume proposal.
const tail = evaluateStateCandidate(volumes, [observation(volumes, 1), observation(volumes, 3)]);
close(tail.metrics.reattachRawMs.median, 120_000);
close(tail.metrics.reattachRawMs.p95, 180_000);
const tailExpected = volumes.metrics.reduce((sum, m) => {
  const median = m.higherIsBetter ? 200 / 3 : 100 / 3;
  const p95 = m.higherIsBetter ? 75 : 25;
  return sum + m.weights.median * median + (m.weights.p95 + m.weights.p99) * p95;
}, 0);
close(tail.compositeScore, tailExpected);
// Fidelity's informational capabilities do not become ranking dimensions.
const fidelity = STATE_SCORING_CANDIDATES['sandbox-fidelity-stealth'];
const fidelityRecord = observation(fidelity);
const fidelityWithInfo = { ...fidelityRecord, data: { ...fidelityRecord.data, checks: { tmpfs: false, package: 'untested', processAlive: false } } };
assert.deepEqual(evaluateStateCandidate(fidelity, [fidelityRecord]), evaluateStateCandidate(fidelity, [fidelityWithInfo]));

// Future volume records retain full measurements alongside identical v1 rounded fields.
assert.deepEqual(stateVolumeDurationFields('volumeCreateMs', 0.125), { volumeCreateMs: 0, volumeCreateRawMs: 0.125 });
assert.deepEqual(stateVolumeRateFields('seqReadMBps', 256, 3_000_000_000), { seqReadMBps: 85.3, seqReadRawMBps: 256 / 3 });
assert.equal(parseStateVolumeNs('output\nNS=12345\n'), 12345);
for (const output of ['', 'NS=0', 'NS=-1', 'NS=Infinity', 'NS=9007199254740992']) {
  assert.throws(() => parseStateVolumeNs(output));
}
assert.throws(() => stateVolumeRateFields('seqReadMBps', 256, 0));
assert.throws(() => stateVolumeDurationFields('verifyMs', NaN));
assert.throws(() => stateVolumeMeasurements({}), /missing or invalid/);
const legacyVolumeFields = {
  volumeCreateMs: 0, mountedReadyMs: 0, reattachMs: 0, verifyMs: 0,
  seqWriteMBps: 1.1, seqReadMBps: 2.2, smallFileOpsPerSec: 3.3,
};
assert.deepEqual(stateVolumeMeasurements(legacyVolumeFields), { latencyMs: 0, ...legacyVolumeFields });
console.log('state candidate and volume precision fixtures passed');
