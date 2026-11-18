/** Offline candidate contracts.
 * Failure cases: clipping, premature rounding, inverse percentile tails, missing
 * or invalid data scored as instant, unsupported transfers scoring speed,
 * lost verification, binary-majority plateaus, lost concurrency peaks, and
 * missing sweep levels being renormalized. Fixtures are synthetic, not rankings.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptySummary } from './concurrent-benchmark.js';
import type { ConcurrentBenchmarkResult } from './concurrent-types.js';
import {
  browserLatencyPoints,
  browserThroughputPoints,
  scoreBrowserConcurrencyCandidate,
  scoreFileTransferCandidate,
  scoreIdleResumeCandidate,
  scoreProtectedSitesCandidate,
  scoreSessionPersistenceCandidate,
  type BrowserObservation,
} from './browsers-scoring-v2.js';

const ok = (data: Record<string, unknown>): BrowserObservation => ({ status: 'success', data });
const failed = (data: Record<string, unknown> = {}): BrowserObservation => ({ status: 'error', data });
const close = (actual: number | null, expected: number) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
};

test('reference scales give 50 points and preserve differences beyond old caps', () => {
  close(browserLatencyPoints(2_000, 2_000), 50);
  close(browserThroughputPoints(10, 10), 50);
  assert.ok(browserLatencyPoints(3_000, 2_000)! > browserLatencyPoints(4_000, 2_000)!);
  assert.ok(browserThroughputPoints(11, 10)! < browserThroughputPoints(12, 10)!);
  close(browserLatencyPoints(0, 2_000), 100);
  close(browserThroughputPoints(0, 10), 0);
  for (const value of [undefined, null, NaN, Infinity, -1, '0']) {
    assert.equal(browserLatencyPoints(value, 2_000), null);
    assert.equal(browserThroughputPoints(value, 10), null);
  }
  assert.throws(() => browserLatencyPoints(1, 0));
});

test('missing observations remain missing; completed unsupported and failed work score zero', () => {
  assert.equal(scoreFileTransferCandidate([]).compositeScore, null);
  assert.equal(scoreIdleResumeCandidate([]).compositeScore, null);
  assert.equal(scoreSessionPersistenceCandidate([]).compositeScore, null);
  assert.equal(scoreProtectedSitesCandidate([]).compositeScore, null);
  assert.equal(scoreFileTransferCandidate([ok({ benchCompleted: 1 })]).compositeScore, null);
  close(scoreFileTransferCandidate([ok({ benchCompleted: 1, downloadSupported: 0, uploadSupported: 0 })]).compositeScore, 0);
  close(scoreFileTransferCandidate([failed({ benchCompleted: 1, compositeScore: 100 })]).compositeScore, 0);
  close(scoreSessionPersistenceCandidate([ok({ resumeSupported: 0 })]).compositeScore, 0);
  close(scoreProtectedSitesCandidate([ok({ passed: 0, timeToPassMs: 0 })]).compositeScore, 0);
});

const transfer = (downloadMs: number, uploadMs = downloadMs) => ({
  benchCompleted: 1, downloadSupported: 1, downloadMatch: 1, downloadMs,
  uploadSupported: 1, uploadMatch: 1, uploadMs,
});

test('transfer correctness gates each fixed direction budget without early rounding', () => {
  close(scoreFileTransferCandidate([ok(transfer(30_000))]).compositeScore, 85);
  close(scoreFileTransferCandidate([ok({ ...transfer(0), downloadMatch: 0 })]).compositeScore, 50);
  close(scoreFileTransferCandidate([ok({ ...transfer(0), downloadSupported: 0 })]).compositeScore, 50);
  close(scoreFileTransferCandidate([ok({ ...transfer(0), downloadMatch: 0, uploadMatch: 0 })]).compositeScore, 0);
  close(scoreFileTransferCandidate([ok(transfer(30_000)), failed()]).compositeScore, 42.5);
  const faster = scoreFileTransferCandidate([ok(transfer(1_000))]).compositeScore!;
  const slower = scoreFileTransferCandidate([ok(transfer(1_001))]).compositeScore!;
  assert.ok(faster > slower);
  assert.equal(Math.round(faster), Math.round(slower));
  // Capability points remain diagnostic; missing timing is not a comparable score.
  const incomplete = scoreFileTransferCandidate([ok({ ...transfer(0), downloadMs: undefined, uploadMs: undefined })]);
  assert.equal(incomplete.compositeScore, null);
  close(incomplete.observedPoints, 70);
});

test('complete observed idle failures score zero without achieved reconnect latency', () => {
  const observations = [10, 30, 60, 300].map(gap => ok({ phase: `idle-${gap}s`, [`resume${gap}s`]: 0, resumeSupported: 0 }));
  close(scoreIdleResumeCandidate(observations).compositeScore, 0);
  assert.deepEqual(scoreIdleResumeCandidate(observations).missingMeasurements, []);
  assert.equal(scoreIdleResumeCandidate(observations.slice(1)).compositeScore, null);
  assert.equal(scoreIdleResumeCandidate(observations.map(record => ({ ...record, status: undefined })) as unknown as BrowserObservation[]).compositeScore, null);
  assert.equal(scoreIdleResumeCandidate(observations.map(record => ({ ...record, data: { ...record.data, resumeSupported: undefined } }))).compositeScore, null);
});

test('idle pass fractions retain partial survival, including half-success cases', () => {
  close(scoreIdleResumeCandidate([ok({ resume300s: 1 }), ok({ resume300s: 0 })]).observedPoints, 15);
  const partial = (passes: number) => Array.from({ length: 10 }, (_, i) => ok({ resume300s: i < passes ? 1 : 0 }));
  assert.ok(scoreIdleResumeCandidate(partial(8)).observedPoints! > scoreIdleResumeCandidate(partial(6)).observedPoints!);
  close(scoreIdleResumeCandidate([ok({ resume10s: 1 }), failed({ resume10s: 1 })]).observedPoints, 5);
  close(scoreIdleResumeCandidate([ok({ resumeSupported: 0, reconnectMs: 0 })]).observedPoints, 0);
  const missing = scoreIdleResumeCandidate([
    ok({ phase: 'idle-300s', resume300s: 1 }), ok({ phase: 'idle-300s' }),
  ]);
  assert.equal(missing.compositeScore, null);
  close(missing.observedPoints, 15);
  assert.ok(missing.missingMeasurements.includes('resume300s'));
});

const persisted = (reconnectMs: number, totalMs = 5_000) => ({
  resumeSupported: 1, reconnectMs, totalMs,
  cookiesPreserved: 1, storagePreserved: 1, tabsPreserved: 1,
});

test('persistence keeps the resume gate, zero data, raw latency tails, and preservation fractions', () => {
  close(scoreSessionPersistenceCandidate([ok(persisted(2_000))]).compositeScore, 65);
  const fast = scoreSessionPersistenceCandidate([ok(persisted(3_000))]).compositeScore!;
  const slow = scoreSessionPersistenceCandidate([ok(persisted(4_000))]).compositeScore!;
  assert.ok(fast > slow);
  close(scoreSessionPersistenceCandidate([ok(persisted(0, 0))]).compositeScore, 100);
  close(scoreSessionPersistenceCandidate([ok(persisted(2_000)), failed(persisted(0, 0))]).compositeScore, 32.5);
  const stable = Array.from({ length: 10 }, () => ok(persisted(100)));
  const tail = [...stable.slice(0, 9), ok(persisted(10_000))];
  assert.ok(scoreSessionPersistenceCandidate(stable).compositeScore! > scoreSessionPersistenceCandidate(tail).compositeScore!);
  const state = (passes: number) => Array.from({ length: 10 }, (_, i) => ok({ ...persisted(100), cookiesPreserved: i < passes ? 1 : 0 }));
  assert.ok(scoreSessionPersistenceCandidate(state(8)).compositeScore! > scoreSessionPersistenceCandidate(state(6)).compositeScore!);
});

test('protected sites retains real pass-rate ties and gates speed on verified passes', () => {
  close(scoreProtectedSitesCandidate([ok({ passed: 1, timeToPassMs: 120_000 })]).compositeScore, 85);
  const mixed = scoreProtectedSitesCandidate([
    ok({ passed: 1, timeToPassMs: 120_000 }), ok({ passed: 0, timeToPassMs: 0 }),
  ]);
  close(mixed.compositeScore, 42.5);
  close(scoreProtectedSitesCandidate([failed({ passed: 1, timeToPassMs: 0 })]).compositeScore, 0);
  assert.equal(scoreProtectedSitesCandidate([ok({ passed: 0, outcome: 'blocked' })]).compositeScore,
    scoreProtectedSitesCandidate([ok({ passed: 0, outcome: 'challenge' })]).compositeScore);
  const input = [ok({ passed: 1, timeToPassMs: 5_000 })];
  assert.deepEqual(scoreProtectedSitesCandidate(input), scoreProtectedSitesCandidate([...input]));
  assert.ok(scoreProtectedSitesCandidate([ok({})]).missingMeasurements.includes('passed'));
});

function concurrency(level: number): ConcurrentBenchmarkResult {
  const summary = emptySummary();
  const stats = { median: 1_000, p95: 2_000, p99: 3_000, samples: 20 };
  summary.createMs = { ...stats };
  summary.loopMs = { ...stats };
  summary.perActionType.screenshot = { ...stats };
  summary.perSessionActionsPerSecond = { median: 10, p95: 15, p99: 20, samples: 20 };
  return {
    provider: 'fixture', mode: 'browser-concurrent', concurrencyLevel: level, summary,
    rounds: [{
      concurrencyLevel: level, roundIndex: 0, sessionsAttempted: level, sessionsAlive: level,
      createMs: 1_000, connectMs: 1_000, taskMs: 1_000, releaseMs: 1_000, totalMs: 4_000,
      maxLiveSessions: level, maxConcurrentActions: level, aggregateActionsPerSecond: level * 10,
      sessions: Array.from({ length: level }, () => ({
        sessionId: 'fixture', createMs: 1_000, connectMs: 1_000, taskMs: 1_000,
        actionsCompleted: 1, actionsPerSecond: 10,
        actions: [{ index: 1, type: 'screenshot', durationMs: 1_000, success: true }],
      })),
    }],
  };
}

test('concurrency preserves measured peaks, whole-session correctness and missing level weights', () => {
  assert.equal(scoreBrowserConcurrencyCandidate([]).compositeScore, null);
  const result = concurrency(1);
  const onlyC1 = scoreBrowserConcurrencyCandidate([{ status: 'success', result }]);
  assert.equal(onlyC1.compositeScore, null);
  assert.ok(onlyC1.observedPoints! > 0 && onlyC1.observedPoints! < 5);
  assert.equal(onlyC1.missingMeasurements.length, 4);
  close(scoreBrowserConcurrencyCandidate([{ status: 'error', result }]).observedPoints, 0);
  const noPeak = concurrency(1);
  noPeak.rounds[0].maxConcurrentActions = 0;
  close(scoreBrowserConcurrencyCandidate([{ status: 'success', result: noPeak }]).observedPoints, 0);
  const unknownPeak = concurrency(1);
  delete unknownPeak.rounds[0].maxConcurrentActions;
  assert.equal(scoreBrowserConcurrencyCandidate([{ status: 'success', result: unknownPeak }]).compositeScore, null);
  const broken = concurrency(1);
  broken.rounds[0].sessions[0].actionsCompleted = 0;
  close(scoreBrowserConcurrencyCandidate([{ status: 'success', result: broken }]).observedPoints, 0);
  const missingScreenshot = concurrency(1);
  missingScreenshot.summary.perActionType.screenshot.samples = 0;
  assert.equal(scoreBrowserConcurrencyCandidate([{ status: 'success', result: missingScreenshot }]).compositeScore, null);
  assert.ok(scoreBrowserConcurrencyCandidate([{ status: 'success', result: missingScreenshot }]).observedPoints! < onlyC1.observedPoints!);
  const before = JSON.stringify(result);
  scoreBrowserConcurrencyCandidate([{ status: 'success', result }]);
  assert.equal(JSON.stringify(result), before);
  assert.throws(() => scoreBrowserConcurrencyCandidate([{ status: 'success', result }, { status: 'success', result }]));
});
