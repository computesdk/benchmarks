/**
 * Concurrent benchmark result summarization + legacy JSON writer.
 * Mirrors throughput-benchmark.ts but works with rounds (barrier protocol
 * executions) instead of individual sessions.
 */
import {
  ACTION_TIMEOUT_MS,
  ACTION_TYPES,
  ACTIONS_PER_LOOP,
  actionsPerSession,
  type ConcurrencyLevel,
  type ActionType,
  type ConcurrentBenchmarkResult,
  type ConcurrentStats,
  type ConcurrentStatsTriple,
  type RoundResult,
  type SessionResult,
  type ActionResult,
} from './concurrent-types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

/**
 * Counts how many things are in flight and remembers the peak.
 *
 * Concurrency was previously inferred from how many sessions survived, but
 * surviving and running at the same time are different properties: sessions
 * taking turns would report the same sessionsAlive as sessions running
 * together. Counting directly turns the level's claim into a measurement.
 */
export class ConcurrencyTracker {
  private active = 0;
  private watchers = new Set<{ max: number }>();

  enter(): () => void {
    this.active++;
    for (const watcher of this.watchers) {
      if (this.active > watcher.max) watcher.max = this.active;
    }
    let released = false;
    return () => {
      // Idempotent: a create that resolves after its timeout can release twice.
      if (released) return;
      released = true;
      this.active--;
    };
  }

  /**
   * Start recording the peak from now until stop(). Seeded with whatever is
   * already in flight, so a round that inherits sessions from a level that has
   * not finished cleaning up reports them instead of starting from zero.
   */
  watch(): { stop: () => number } {
    const watcher = { max: this.active };
    this.watchers.add(watcher);
    return {
      stop: () => {
        this.watchers.delete(watcher);
        return watcher.max;
      },
    };
  }
}

/**
 * Whether a session should begin another loop. The check sits on the loop
 * boundary so every session in a level stops at the same point and the level
 * holds its concurrency for as long as it runs; cutting sessions off mid-loop
 * would leave partial loops in the samples and shrink concurrency unevenly.
 * The first loop always runs, so a level always produces measurements.
 */
export function shouldStartLoop(loopIndex: number, now: number, deadline: number): boolean {
  return loopIndex === 0 || now < deadline;
}

/**
 * Per-loop times for one session: its actions split into ACTIONS_PER_LOOP
 * chunks, each summed. One loop on one session is the unit that compares across
 * levels, since a level's action phase covers as many loops as that level runs.
 */
export function sessionLoopTimes(session: SessionResult): number[] {
  const times: number[] = [];
  for (let i = 0; i + ACTIONS_PER_LOOP <= session.actions.length; i += ACTIONS_PER_LOOP) {
    let sum = 0;
    for (let j = i; j < i + ACTIONS_PER_LOOP; j++) sum += session.actions[j].durationMs;
    times.push(sum);
  }
  return times;
}

function computeStats(values: number[]): ConcurrentStatsTriple {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0, samples: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  // The count is carried so consumers can withhold a percentile the sample size
  // cannot support: with one observation the p95 is just the median again.
  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
    samples: values.length,
  };
}

/**
 * True when a session lost an action to the timeout. Such an action was cut off
 * at the limit rather than measured, so anything derived from its duration
 * reports the timeout constant instead of the provider's latency.
 */
export function sessionHitActionTimeout(session: SessionResult): boolean {
  return session.actions.some(
    (a) =>
      !a.success &&
      (a.durationMs >= ACTION_TIMEOUT_MS * 0.95 || /time(d)?\s?out/i.test(a.error ?? '')),
  );
}

/**
 * The round's action wall clock, with timed-out sessions taken out.
 *
 * A round ends when its slowest session ends, so one session stalled on an
 * unusable page sets the whole round's duration: in run 31626532250 two of the
 * fifty shared articles pushed otherwise 3-7s rounds to 31s and 63s, for every
 * provider alike. Rebuilding the wall clock from the slowest *unaffected*
 * session keeps the barrier's meaning while dropping the censored part.
 *
 * Rounds are not discarded wholesale, because each level runs one round and its
 * sessions each draw a different page: at c50 a single bad article would
 * otherwise erase the level's only latency observation.
 */
export function effectiveTaskMs(round: RoundResult): number {
  const withActions = round.sessions.filter((s) => s.actions.length > 0);
  if (withActions.length === 0) return round.taskMs;

  const clean = withActions.filter((s) => !sessionHitActionTimeout(s));
  if (clean.length === withActions.length) return round.taskMs;
  // Every session was censored: the round says nothing about latency.
  if (clean.length === 0) return 0;

  return Math.max(...clean.map((s) => s.taskMs));
}

/**
 * Summarize rounds into aggregate stats. Per-action-type stats are computed
 * across all sessions in all rounds — this is the degradation signal.
 */
export function summarizeRounds(rounds: RoundResult[]): ConcurrentStats {
  // A create phase that hit the timeout is censored at the timeout value, not
  // measured, so folding it into the latency distribution would report the
  // timeout constant as if it were a provisioning time. The lost sessions are
  // already penalized through the success rate.
  const createValues = rounds
    .filter(r => !r.createTimedOut)
    .map(r => r.createMs)
    .filter(v => v > 0);
  const connectValues = rounds.map(r => r.connectMs).filter(v => v > 0);
  const taskValues = rounds.map(effectiveTaskMs).filter(v => v > 0);

  // Pooled over every session and loop, so a level's sample count is
  // level x loops rather than one per round. Sessions whose actions were cut
  // off at the timeout are left out for the same reason their round's wall
  // clock is rebuilt: the timeout is a censored value, not a measurement.
  const loopValues: number[] = [];
  for (const round of rounds) {
    for (const session of round.sessions) {
      if (sessionHitActionTimeout(session)) continue;
      for (const loopMs of sessionLoopTimes(session)) {
        if (loopMs > 0) loopValues.push(loopMs);
      }
    }
  }
  const sessionsAliveValues = rounds.map(r => r.sessionsAlive).filter(v => v > 0);
  const aggregateApsValues = rounds.map(r => r.aggregateActionsPerSecond).filter(v => v > 0);

  // Per-session APS across all rounds
  const perSessionApsValues: number[] = [];
  for (const round of rounds) {
    for (const session of round.sessions) {
      if (session.actionsPerSecond > 0) perSessionApsValues.push(session.actionsPerSecond);
    }
  }

  // Per-action-type stats across all sessions in all rounds
  const perActionType = {} as Record<ActionType, ConcurrentStatsTriple>;
  for (const type of ACTION_TYPES) {
    const values: number[] = [];
    for (const round of rounds) {
      for (const session of round.sessions) {
        for (const a of session.actions) {
          if (a.type === type && a.success) values.push(a.durationMs);
        }
      }
    }
    perActionType[type] = computeStats(values);
  }

  return {
    sessionsAlive: computeStats(sessionsAliveValues),
    createMs: computeStats(createValues),
    connectMs: computeStats(connectValues),
    taskMs: computeStats(taskValues),
    loopMs: computeStats(loopValues),
    actionsPerSecond: computeStats(aggregateApsValues),
    perSessionActionsPerSecond: computeStats(perSessionApsValues),
    perActionType,
  };
}

export function emptySummary(): ConcurrentStats {
  const empty: ConcurrentStatsTriple = { median: 0, p95: 0, p99: 0, samples: 0 };
  const perActionType = {} as Record<ActionType, ConcurrentStatsTriple>;
  for (const t of ACTION_TYPES) perActionType[t] = { ...empty };
  return {
    sessionsAlive: { ...empty },
    createMs: { ...empty },
    connectMs: { ...empty },
    taskMs: { ...empty },
    loopMs: { ...empty },
    actionsPerSecond: { ...empty },
    perSessionActionsPerSecond: { ...empty },
    perActionType,
  };
}

function roundStats(s: ConcurrentStatsTriple | undefined): ConcurrentStatsTriple {
  // An artifact written before a stat existed deserializes without it, and the
  // merge step reads whatever the providers uploaded, so a mix of old and new
  // results has to serialize rather than crash on the missing field. Zero
  // samples, so the percentile gates withhold it downstream.
  if (!s) return { median: 0, p95: 0, p99: 0, samples: 0 };
  return {
    median: round(s.median),
    p95: round(s.p95),
    p99: round(s.p99),
    ...(s.samples !== undefined ? { samples: s.samples } : {}),
  };
}

export async function writeConcurrentResultsJson(
  results: ConcurrentBenchmarkResult[],
  outPath: string,
  options: { concurrencyLevel?: number; timeoutMs?: number } = {},
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    concurrencyLevel: r.concurrencyLevel,
    rounds: r.rounds.map(round => ({
      sessionsAttempted: round.sessionsAttempted,
      sessionsAlive: round.sessionsAlive,
      createMs: roundNum(round.createMs),
      connectMs: roundNum(round.connectMs),
      taskMs: roundNum(round.taskMs),
      releaseMs: roundNum(round.releaseMs),
      totalMs: roundNum(round.totalMs),
      aggregateActionsPerSecond: roundNum(round.aggregateActionsPerSecond),
      sessions: round.sessions.map(s => ({
        sessionId: s.sessionId,
        createMs: roundNum(s.createMs),
        connectMs: roundNum(s.connectMs),
        taskMs: roundNum(s.taskMs),
        actionsCompleted: s.actionsCompleted,
        actionsPerSecond: roundNum(s.actionsPerSecond),
        actions: s.actions.map(a => ({
          index: a.index,
          type: a.type,
          durationMs: roundNum(a.durationMs),
          success: a.success,
          ...(a.error ? { error: a.error } : {}),
        })),
        ...(s.error ? { error: s.error } : {}),
      })),
      ...(round.maxLiveSessions !== undefined ? { maxLiveSessions: round.maxLiveSessions } : {}),
      ...(round.maxConcurrentActions !== undefined ? { maxConcurrentActions: round.maxConcurrentActions } : {}),
      ...(round.loopsPerSession !== undefined ? { loopsPerSession: round.loopsPerSession } : {}),
      ...(round.actionTimedOut ? { actionTimedOut: true } : {}),
      ...(round.createTimedOut ? { createTimedOut: true } : {}),
      ...(round.roundFailed ? { roundFailed: true } : {}),
      ...(round.error ? { error: round.error } : {}),
    })),
    summary: {
      sessionsAlive: roundStats(r.summary.sessionsAlive),
      createMs: roundStats(r.summary.createMs),
      connectMs: roundStats(r.summary.connectMs),
      taskMs: roundStats(r.summary.taskMs),
      loopMs: roundStats(r.summary.loopMs),
      actionsPerSecond: roundStats(r.summary.actionsPerSecond),
      perSessionActionsPerSecond: roundStats(r.summary.perSessionActionsPerSecond),
      perActionType: Object.fromEntries(
        ACTION_TYPES.map(t => [t, roundStats(r.summary.perActionType[t])]),
      ),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.sessionCeiling !== undefined ? { sessionCeiling: r.sessionCeiling } : {}),
    ...(r.concurrencyAchieved !== undefined ? { concurrencyAchieved: r.concurrencyAchieved } : {}),
    ...(r.latencyRepresentative !== undefined
      ? { latencyRepresentative: r.latencyRepresentative }
      : {}),
    ...(r.quotaLimited ? { quotaLimited: true } : {}),
    ...(r.quotaEvidence ? { quotaEvidence: r.quotaEvidence } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const rounds = results.reduce((max, r) => Math.max(max, r.rounds.length), 0);
  const level = options.concurrencyLevel ?? results[0]?.concurrencyLevel ?? 0;

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      concurrencyLevel: level,
      rounds,
      actionsPerSession: level > 0 ? actionsPerSession(level as ConcurrencyLevel) : 0,
      loopsPerSession: results[0]?.rounds?.[0]?.loopsPerSession ?? 0,
      timeoutMs: options.timeoutMs ?? 120_000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}

function roundNum(n: number): number {
  return Math.round(n * 100) / 100;
}
