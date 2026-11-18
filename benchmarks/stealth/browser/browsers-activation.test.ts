import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { score, scoringConfigToSpec, type BenchmarkRunOutcome, type BenchmarkScoringConfig } from '@benchsdk/runner';
import type { TaskResultRecord } from '@benchsdk/client';
import { config as idle } from './idle-resume.bench.js';
import { config as session } from './session-persistence.bench.js';
import { config as protectedSites } from './protected-sites.bench.js';
import { config as transfer } from './file-transfer.bench.js';
import { config as concurrency } from './browser-concurrency.bench.js';
import { fileTransferPoints, IDLE_SCORING, SESSION_SCORING, PROTECTED_SCORING, TRANSFER_SCORING } from './browsers-runtime-scoring.js';
import { runtimeRecordScore } from '../sandbox/performance-runtime-scoring.js';
import { assertPlatformParity } from '../sandbox/performance-platform-parity.js';
import { scoreIdleResumeRecords } from './idle-resume-legacy-results.js';
import { scoreSessionPersistenceRecords } from './session-persistence-legacy-results.js';
import { writeFileTransferResults } from './file-transfer-legacy-results.js';
import { computeConcurrentCompositeScores, computeSweepScore } from './concurrent-scoring.js';
import { summarizeRounds, writeConcurrentResultsJson } from './concurrent-benchmark.js';
import { ACTION_TYPES, ACTIONS_PER_LOOP, CONCURRENCY_LEVELS, type ConcurrentBenchmarkResult, type RoundResult } from './concurrent-types.js';

// Actual runtime manifests/exporters, sparse capability phases, cap ties,
// verification gates, pre-stat transforms, raw precision and status failures.
const record = (data: Record<string, unknown>, status = 'success') => ({ taskIndex: 0, status, data }) as TaskResultRecord;
const points = (config: BenchmarkScoringConfig, records: TaskResultRecord[]) => runtimeRecordScore(records, config)!.compositeScore;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const weighted = (config: BenchmarkScoringConfig) => config.metrics.filter(m => Object.values(m.weights).some(w => w > 0))
  .map(m => ({ key: m.key, ceiling: m.ceiling, higherIsBetter: m.higherIsBetter ?? false, weights: m.weights,
    transform: (m as typeof m & { transform?: unknown }).transform }));

test('actual browser manifests including sparse phases and levels agree exactly with platform', {
  skip: !process.env.BENCHSDK_PLATFORM_SCORING_ENTRYPOINT,
}, async () => {
  const idleRecords = ['10s', '30s', '60s', '300s'].map(gap => record({ phase: `idle-${gap}`, [`resume${gap}`]: 1, reconnectMs: 2000 }));
  for (const records of [idleRecords, [idleRecords[0], record({}, 'error')],
    [record({ phase: 'idle-300s', resume300s: 0, resumeSupported: 0 })]]) {
    await assertPlatformParity(idle.scoring!, records);
  }
  const sessionRecord = record({ resumeSupported: 1, cookiesPreserved: 1, storagePreserved: 1, tabsPreserved: 1, reconnectMs: 2000.123456, totalMs: 5000.123456 });
  for (const config of [session, protectedSites, transfer, concurrency]) {
    const raw = config === session ? sessionRecord : config === protectedSites
      ? record({ phase: 'fixture', passed: 1, timeToPassMs: 160000.123456 })
      : config === transfer ? record({ benchCompleted: 1, compositeScore: 81.123456 })
      : record({ c1Score: 81.123456 });
    for (const records of [[raw], [raw, record({}, 'error')], [record({}, 'error')]]) {
      await assertPlatformParity(config.scoring!, records);
    }
  }
});

test('all five actual configs select full precision; exporter specs match weighted runtime metrics', () => {
  for (const config of [idle, session, protectedSites, transfer, concurrency]) assert.equal((config.scoring as { precision?: string }).precision, 'full');
  for (const [config, canonical] of [[idle, IDLE_SCORING], [session, SESSION_SCORING],
    [protectedSites, PROTECTED_SCORING], [transfer, TRANSFER_SCORING]] as const) {
    assert.deepEqual(weighted(config.scoring!), weighted(canonical));
    assert.deepEqual(config.scoring!.success, canonical.success);
  }
});

test('idle raw phases preserve sparse capability flags and raw-stat timing with exporter parity', () => {
  const records = ['10s', '30s', '60s', '300s'].map(gap => record({ phase: `idle-${gap}`, [`resume${gap}`]: 1, reconnectMs: 2000 }));
  const results = score({ participants: [{ participant: 'fixture', records }] } as unknown as BenchmarkRunOutcome, scoringConfigToSpec(idle.scoring!));
  near(results[0].compositeScore, 90);
  const phases = results.filter(r => r.dimensions?.phase !== undefined);
  assert.deepEqual(phases.map(r => r.compositeScore), [20, 25, 35, 40]);
  near(scoreIdleResumeRecords(records), results[0].compositeScore);
  // Unsupported capability is a completed experiment with no timing sample.
  const unsupported = [record({ phase: 'idle-300s', resume300s: 0, resumeSupported: 0 })];
  assert.equal(scoreIdleResumeRecords(unsupported), 0);
  assert.equal(points(idle.scoring!, unsupported), 0);
  const partialFailure = [records[0], record({ phase: 'idle-30s', resume30s: 1, reconnectMs: 1 }, 'error')];
  near(scoreIdleResumeRecords(partialFailure), 10);
});

test('idle and session reconnect times stay distinct past the previous floor', () => {
  const idleScore = (ms: number) => scoreIdleResumeRecords([record({ resume10s: 1, reconnectMs: ms })]);
  assert.ok(idleScore(4000) > idleScore(8000));
  const data = { resumeSupported: 1, cookiesPreserved: 1, storagePreserved: 1, tabsPreserved: 1, totalMs: 10000 };
  const a = [record({ ...data, reconnectMs: 4000 })];
  const b = [record({ ...data, reconnectMs: 8000 })];
  assert.ok(scoreSessionPersistenceRecords(a) > scoreSessionPersistenceRecords(b));
  near(scoreSessionPersistenceRecords(a), points(session.scoring!, a));
  assert.equal(scoreSessionPersistenceRecords([record({ resumeSupported: 0 })]), 0);
  assert.equal(scoreSessionPersistenceRecords([record({ ...data, reconnectMs: 1 }, 'error')]), 0);
});

test('session capability flags retain actual runtime median semantics', () => {
  const records = [0, 1].map(flag => record({ resumeSupported: 1, reconnectMs: 2000, totalMs: 5000,
    cookiesPreserved: flag, storagePreserved: flag, tabsPreserved: flag }));
  near(scoreSessionPersistenceRecords(records), 50);
});

test('protected-site latency curves keep pass gate and separate old floor ties', () => {
  const records = (ms: number) => [record({ passed: 1, timeToPassMs: ms })];
  assert.ok(points(protectedSites.scoring!, records(240000)) > points(protectedSites.scoring!, records(480000)));
  assert.equal(points(protectedSites.scoring!, [record({ passed: 0 })]), 0);
});

test('transfer task unit score keeps per-direction 70/30 capability and verified reciprocal latency', async () => {
  const data = { benchCompleted: 1, downloadSupported: 1, downloadMatch: 1, downloadMs: 60000.12345,
    uploadSupported: 1, uploadMatch: 1, uploadMs: 60000.12345 };
  const unit = fileTransferPoints(data);
  assert.ok(unit > 70 && unit < 100);
  assert.ok(unit > fileTransferPoints({ ...data, downloadMs: 120000.12345, uploadMs: 120000.12345 }));
  assert.notEqual(unit, Math.round(unit));
  assert.ok(fileTransferPoints({ ...data, uploadSupported: 0 }) <= 50);
  assert.equal(fileTransferPoints({ downloadSupported: 0, uploadSupported: 0 }), 0);
  assert.equal(fileTransferPoints({ ...data, downloadMatch: 0, uploadMatch: 0 }), 0);
  assert.throws(() => fileTransferPoints({ ...data, downloadMs: Number.NaN }));
  assert.throws(() => fileTransferPoints({ ...data, downloadSupported: undefined }));
  const records = [record({ ...data, compositeScore: unit }), record({ ...data, compositeScore: 100 }, 'error')];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'browser-transfer-'));
  try {
    await writeFileTransferResults([{ participant: 'fixture', records }], { resultsDir: dir, runConfig: {} as never });
    const saved = JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8')).results[0];
    near(saved.compositeScore, points(transfer.scoring!, records));
    assert.equal(saved.records[1].status, 'error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function concurrentResult(ms: number, aps: number): ConcurrentBenchmarkResult {
  const actions = Array.from({ length: ACTIONS_PER_LOOP }, (_, index) => ({ index, type: ACTION_TYPES[index % ACTION_TYPES.length], durationMs: ms / ACTIONS_PER_LOOP, success: true }));
  const rounds: RoundResult[] = [{ concurrencyLevel: 1, roundIndex: 0, sessionsAttempted: 1, sessionsAlive: 1,
    createMs: ms, connectMs: 1, taskMs: ms, releaseMs: 1, totalMs: ms, aggregateActionsPerSecond: aps,
    maxLiveSessions: 1, maxConcurrentActions: 1, sessions: [{ sessionId: 'fixture', createMs: ms, connectMs: 1,
      taskMs: ms, actionsCompleted: ACTIONS_PER_LOOP, actionsPerSecond: aps, actions }] }];
  return { taskStatus: 'success', provider: 'fixture', mode: 'browser-concurrent', concurrencyLevel: 1, rounds, summary: summarizeRounds(rounds) };
}

function computeConcurrentScore(result: ConcurrentBenchmarkResult): number {
  computeConcurrentCompositeScores([result]);
  return result.compositeScore!;
}

test('concurrency custom metrics stay continuous above old ceilings and do not invent missing perfect latency', async () => {
  const fast = concurrentResult(60000.12345, 20.123456);
  const slow = concurrentResult(120000.12345, 20.123456);
  assert.ok(computeConcurrentScore(fast) > computeConcurrentScore(slow));
  assert.ok(computeConcurrentScore(concurrentResult(60000.12345, 40.123456)) > computeConcurrentScore(fast));
  const missing = concurrentResult(60000, 0);
  missing.summary.createMs = { median: 0, p95: 0, p99: 0, samples: 0 };
  missing.summary.loopMs = { median: 0, p95: 0, p99: 0, samples: 0 };
  missing.summary.perActionType.screenshot = { median: 0, p95: 0, p99: 0, samples: 0 };
  assert.equal(computeConcurrentScore(missing), 0);
  computeConcurrentCompositeScores([fast]);
  const failure = concurrentResult(1, 100);
  failure.taskStatus = 'error';
  computeConcurrentCompositeScores([failure]);
  assert.equal(failure.compositeScore, 0);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'browser-concurrency-'));
  try {
    const file = path.join(dir, 'fixture.json');
    await writeConcurrentResultsJson([fast], file);
    const saved = JSON.parse(await readFile(file, 'utf8')).results[0];
    assert.equal(saved.rounds[0].createMs, fast.rounds[0].createMs);
    assert.equal(saved.summary.createMs.median, fast.summary.createMs.median);
    assert.equal(saved.compositeScore, fast.compositeScore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrency serializable score reproduces actual sweep weights, subsets and partial/all failures', () => {
  const values = [81.123456, 72.234567, 63.345678, 54.456789, 45.567891];
  const records = CONCURRENCY_LEVELS.map((level, index) => record({ concurrencyLevel: level, [`c${level}Score`]: values[index] }));
  const expected = computeSweepScore(new Map(CONCURRENCY_LEVELS.map((level, index) => [level, values[index]])));
  near(points(concurrency.scoring!, records), expected);
  near(points(concurrency.scoring!, [records[0]]), 4.0561728);
  const partial = [...records.slice(0, 4), record({ c50Score: 99 }, 'error')];
  near(points(concurrency.scoring!, partial), computeSweepScore(new Map(CONCURRENCY_LEVELS.slice(0, 4).map((level, index) => [level, values[index]]))) * 4 / 5);
  assert.equal(points(concurrency.scoring!, [record({}, 'error')]), 0);
});
