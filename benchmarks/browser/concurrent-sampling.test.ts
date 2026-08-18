/**
 * Checks on the parts of the concurrency benchmark that no artifact can
 * exercise: how concurrency is counted, when a level stops looping, and when a
 * percentile has enough samples to report.
 *
 *   pnpm test:browser-concurrent:sampling
 */
import assert from 'node:assert/strict';
import {
  ConcurrencyTracker,
  sessionLoopTimes,
  shouldStartLoop,
  summarizeRounds,
} from './concurrent-benchmark.js';
import {
  computeConcurrentCompositeScores,
  computeConcurrentSuccessRate,
  computeSweepScore,
  supportedP95,
} from './concurrent-scoring.js';
import {
  ACTIONS_PER_LOOP,
  CONCURRENCY_LEVELS,
  LOOPS_PER_LEVEL,
  SWEEP_WEIGHTS,
  MIN_SAMPLES_FOR_P95,
  actionsPerSession,
  type ActionResult,
  type ActionType,
  type ConcurrencyLevel,
  type ConcurrentBenchmarkResult,
  type RoundResult,
  type SessionResult,
} from './concurrent-types.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function action(durationMs: number, success = true): ActionResult {
  return { index: 1, type: 'navigate', durationMs, success, ...(success ? {} : { error: 'boom' }) };
}

function session(actions: ActionResult[]): SessionResult {
  const completed = actions.filter((a) => a.success).length;
  const taskMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
  return {
    sessionId: 's',
    createMs: 1,
    connectMs: 1,
    taskMs,
    actionsCompleted: completed,
    actionsPerSecond: 1,
    actions,
  };
}

function loopOf(durationMs: number): ActionResult[] {
  return Array.from({ length: ACTIONS_PER_LOOP }, () => action(durationMs / ACTIONS_PER_LOOP));
}

function round(sessions: SessionResult[], level: number): RoundResult {
  return {
    concurrencyLevel: level,
    roundIndex: 0,
    sessionsAttempted: level,
    sessionsAlive: sessions.length,
    createMs: 100,
    connectMs: 100,
    taskMs: Math.max(...sessions.map((s) => s.taskMs), 0),
    releaseMs: 10,
    totalMs: 500,
    aggregateActionsPerSecond: 1,
    sessions,
  };
}

console.log('ConcurrencyTracker');

check('reports the peak, not the total or the final count', () => {
  const t = new ConcurrencyTracker();
  const w = t.watch();
  const a = t.enter();
  const b = t.enter();
  a();
  b();
  const c = t.enter();
  c();
  assert.equal(w.stop(), 2, 'three entries that never exceeded two at once should peak at two');
});

check('distinguishes simultaneous from sequential', () => {
  const together = new ConcurrencyTracker();
  const w1 = together.watch();
  const holds = [together.enter(), together.enter(), together.enter()];
  holds.forEach((release) => release());

  const taking = new ConcurrencyTracker();
  const w2 = taking.watch();
  for (let i = 0; i < 3; i++) taking.enter()();

  assert.equal(w1.stop(), 3);
  assert.equal(w2.stop(), 1, 'sessions taking turns must not look like concurrency');
});

check('release is idempotent, so a late create cannot double count', () => {
  const t = new ConcurrencyTracker();
  const w = t.watch();
  const release = t.enter();
  release();
  release();
  const second = t.enter();
  assert.equal(w.stop(), 1);
  second();
});

check('a watch inherits what is already in flight', () => {
  const t = new ConcurrencyTracker();
  const leaked = t.enter();
  const w = t.watch();
  assert.equal(w.stop(), 1, "a round starting with someone else's sessions live must report them");
  leaked();
});

check('each watch sees only its own window', () => {
  const t = new ConcurrencyTracker();
  const first = t.watch();
  const a = t.enter();
  const b = t.enter();
  a();
  b();
  assert.equal(first.stop(), 2);
  const second = t.watch();
  const c = t.enter();
  assert.equal(second.stop(), 1, 'the later window must not inherit the earlier peak');
  c();
});

console.log('\nAction budget');

check('the first loop always runs, even past the deadline', () => {
  assert.equal(shouldStartLoop(0, 10_000, 5_000), true);
});

check('later loops stop once the budget is spent', () => {
  assert.equal(shouldStartLoop(1, 4_999, 5_000), true);
  assert.equal(shouldStartLoop(1, 5_000, 5_000), false);
  assert.equal(shouldStartLoop(9, 6_000, 5_000), false);
});

console.log('\nPer-loop samples');

check('a session splits into one sample per loop', () => {
  const s = session([...loopOf(1_000), ...loopOf(2_000), ...loopOf(3_000)]);
  assert.deepEqual(sessionLoopTimes(s), [1_000, 2_000, 3_000]);
});

check('a trailing partial loop is not counted as a loop', () => {
  const s = session([...loopOf(1_000), action(50)]);
  assert.deepEqual(sessionLoopTimes(s), [1_000]);
});

check('the sample count is level x loops', () => {
  for (const level of [1, 5, 10, 25, 50] as ConcurrencyLevel[]) {
    const loops = LOOPS_PER_LEVEL[level];
    const sessions = Array.from({ length: level }, () =>
      session(Array.from({ length: loops }, () => loopOf(1_000)).flat()),
    );
    const summary = summarizeRounds([round(sessions, level)]);
    assert.equal(
      summary.loopMs.samples,
      level * loops,
      `c${level} should pool ${level * loops} loop samples`,
    );
    assert.equal(actionsPerSession(level), loops * ACTIONS_PER_LOOP);
  }
});

check('sessions cut off at the action timeout stay out of the samples', () => {
  const healthy = session(loopOf(1_000));
  const stalled = session([...loopOf(1_000).slice(0, 9), action(30_000, false)]);
  const summary = summarizeRounds([round([healthy, stalled], 2)]);
  assert.equal(summary.loopMs.samples, 1, 'only the healthy session should contribute');
});

console.log('\nPercentile gates');

check('a p95 below the sample gate is withheld rather than repeated', () => {
  const sessions = Array.from({ length: MIN_SAMPLES_FOR_P95 - 1 }, () => session(loopOf(1_000)));
  const summary = summarizeRounds([round(sessions, sessions.length)]);
  assert.equal(summary.loopMs.samples, MIN_SAMPLES_FOR_P95 - 1);
  assert.equal(supportedP95(summary.loopMs), null);
});

check('a p95 at the gate is reported', () => {
  const sessions = Array.from({ length: MIN_SAMPLES_FOR_P95 }, (_, i) => session(loopOf(1_000 + i * 10)));
  const summary = summarizeRounds([round(sessions, sessions.length)]);
  assert.equal(summary.loopMs.samples, MIN_SAMPLES_FOR_P95);
  assert.notEqual(supportedP95(summary.loopMs), null);
});

console.log('\nNo partial credit');

check('a session whose browser dies mid-run is a failure, not a partial success', () => {
  // notte at c1 in run 2026-08-14: 132 of 200 actions succeeded, then every
  // action failed with "Target page, context or browser has been closed".
  const actions = Array.from({ length: 200 }, (_, i) => ({
    index: i + 1,
    type: 'navigate' as ActionType,
    durationMs: 500,
    success: i < 132,
    ...(i < 132 ? {} : { error: 'Target page, context or browser has been closed' }),
  }));
  const died: SessionResult = { ...session(actions), actionsCompleted: 132 };
  const result = {
    provider: 'test',
    concurrencyLevel: 1 as ConcurrencyLevel,
    rounds: [round([died], 1)],
    summary: summarizeRounds([round([died], 1)]),
  } as ConcurrentBenchmarkResult;
  assert.equal(computeConcurrentSuccessRate(result), 0);
  computeConcurrentCompositeScores([result]);
  // The success rate multiplies the composite, so no credit survives for the
  // 132 actions that did work.
  assert.equal(result.compositeScore, 0);
});

check('a session stopped by our own action budget still counts as a success', () => {
  // Same shape, except every action it attempted succeeded: the harness ended
  // the work, so this is not the provider failing.
  const stopped = session(Array.from({ length: 130 }, () => loopOf(500)).flat());
  const result = {
    provider: 'test',
    concurrencyLevel: 1 as ConcurrencyLevel,
    rounds: [round([stopped], 1)],
    summary: summarizeRounds([round([stopped], 1)]),
  } as ConcurrentBenchmarkResult;
  assert.equal(computeConcurrentSuccessRate(result), 1);
});

console.log('\nSweep score');

check('the weights cover every level and sum to 1', () => {
  const total = CONCURRENCY_LEVELS.reduce((sum, level) => sum + SWEEP_WEIGHTS[level], 0);
  assert.equal(CONCURRENCY_LEVELS.every((level) => SWEEP_WEIGHTS[level] > 0), true);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

check('c25 and c50 carry most of the score', () => {
  assert.ok(SWEEP_WEIGHTS[25] + SWEEP_WEIGHTS[50] >= 0.7);
  // Monotonic, so a harder level is never worth less than an easier one.
  for (let i = 1; i < CONCURRENCY_LEVELS.length; i++) {
    assert.ok(SWEEP_WEIGHTS[CONCURRENCY_LEVELS[i]!] > SWEEP_WEIGHTS[CONCURRENCY_LEVELS[i - 1]!]);
  }
});

check('a perfect score at every level is 100', () => {
  const all = new Map(CONCURRENCY_LEVELS.map((level) => [level, 100]));
  assert.equal(computeSweepScore(all), 100);
});

check('a missing level costs its weight instead of being renormalised away', () => {
  const noFifty = new Map<number, number | undefined>(
    CONCURRENCY_LEVELS.filter((level) => level !== 50).map((level) => [level, 100]),
  );
  // Renormalising over the four levels that ran would score this 100.
  assert.equal(computeSweepScore(noFifty), 60);
});

check('an explicit zero and an absent level cost the same', () => {
  const zeroed = new Map<number, number | undefined>(
    CONCURRENCY_LEVELS.map((level) => [level, level === 50 ? 0 : 100]),
  );
  const absent = new Map<number, number | undefined>(
    CONCURRENCY_LEVELS.filter((level) => level !== 50).map((level) => [level, 100]),
  );
  assert.equal(computeSweepScore(zeroed), computeSweepScore(absent));
});

check('holding up beats being quick then collapsing', () => {
  const collapses = new Map<number, number | undefined>([[1, 95], [5, 95], [10, 90], [25, 30], [50, 10]]);
  const holds = new Map<number, number | undefined>([[1, 70], [5, 70], [10, 70], [25, 70], [50, 70]]);
  assert.ok(computeSweepScore(holds) > computeSweepScore(collapses));
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
