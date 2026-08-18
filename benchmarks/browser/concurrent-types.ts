/**
 * Types for the browser concurrent sessions benchmark.
 *
 * Each "round" creates N browser sessions in parallel, waits for all to be
 * alive + connected (barrier), runs a fixed 10-action loop on every session
 * simultaneously, then releases all. N is the concurrency level, and each level
 * is one phase of the run: the level's task runs every round at that level, so
 * ROUNDS_PER_LEVEL fixes the round count and `--levels` picks which levels run.
 *
 * Results are organized by concurrency level, mirroring the storage
 * benchmark's per-file-size directories:
 *
 *   results/browser-concurrent/c1/latest.json   (baseline, 1 session at a time)
 *   results/browser-concurrent/c5/latest.json   (5 sessions concurrently)
 *   results/browser-concurrent/c10/latest.json  (10 sessions concurrently)
 *   results/browser-concurrent/c25/latest.json  (25 sessions concurrently)
 *   results/browser-concurrent/c50/latest.json  (50 sessions concurrently)
 */

/** Number of discrete actions in one loop (matches throughput benchmark). */
export const ACTIONS_PER_LOOP = 10;

/**
 * Loops each session repeats, per level.
 *
 * The comparable unit across levels is one loop: ten actions on one session
 * while `level` sessions run concurrently. Sample count is therefore
 * `level x loops`, and with one loop everywhere the cheap levels were left with
 * far too few: c1 produced a single session and ten actions, so its success
 * rate could only be 0% or 100% and its latency had no distribution at all.
 *
 * Repeating loops inside the session buys samples without asking the provider
 * for more browsers, which is the expensive part. These counts even the sample
 * budget out at roughly 20-50 loops per level.
 */
export const LOOPS_PER_LEVEL: Record<ConcurrencyLevel, number> = {
  1: 20,
  5: 4,
  10: 2,
  25: 1,
  50: 1,
};

/** Actions one session runs at a level, when it completes every loop. */
export function actionsPerSession(level: ConcurrencyLevel): number {
  return LOOPS_PER_LEVEL[level] * ACTIONS_PER_LOOP;
}

/**
 * Wall-clock ceiling on a level's action phase. A session checks it between
 * loops, so every session stops at the same loop boundary and the level keeps
 * its concurrency while it runs. Without it a slow provider would spend hours
 * on c1: notte averaged 3.6s per action, which is 12 minutes for 20 loops.
 * Levels cut short report fewer samples, which the percentile gates then
 * account for.
 */
export const LEVEL_ACTION_BUDGET_MS = (() => {
  const raw = process.env.CONCURRENT_LEVEL_ACTION_BUDGET_MS;
  if (raw === undefined) return 240_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`CONCURRENT_LEVEL_ACTION_BUDGET_MS must be a positive number (got ${raw})`);
  }
  return value;
})();

/**
 * How much each level contributes to the sweep score.
 *
 * Weighted toward the levels that actually stress a provider: c25 and c50 carry
 * 70% between them, while the cheap levels still count for something, since a
 * provider that is slow at c1 is slow everywhere. Equal weighting ranked a
 * provider capped at 10 sessions fifth of seven on the strength of cells that
 * barely test anything, and put a provider that degrades at c50 ahead of one
 * that holds.
 */
export const SWEEP_WEIGHTS: Record<ConcurrencyLevel, number> = {
  1: 0.05,
  5: 0.10,
  10: 0.15,
  25: 0.30,
  50: 0.40,
};

/**
 * Samples a percentile needs before it means anything. Below the p95 gate the
 * value is indistinguishable from the median, so reporting it claims knowledge
 * the run does not have.
 */
export const MIN_SAMPLES_FOR_P95 = 20;
export const MIN_SAMPLES_FOR_P99 = 100;

/**
 * Per-action timeout. Shared so the summarizer can recognise an action that was
 * cut off at the limit rather than measured, and leave it out of latency stats.
 */
export const ACTION_TIMEOUT_MS = 30_000;

export type ActionType = 'navigate' | 'waitForSelector' | 'screenshot' | 'textContent' | 'click' | 'goBack';

export const ACTION_TYPES: ActionType[] = [
  'navigate',
  'waitForSelector',
  'screenshot',
  'textContent',
  'click',
  'goBack',
];

/** Concurrency levels sweeped for the degradation curve. */
export const CONCURRENCY_LEVELS = [1, 5, 10, 25, 50] as const;
export type ConcurrencyLevel = (typeof CONCURRENCY_LEVELS)[number];

/**
 * Barrier rounds run at each level. One task per level means the level's task
 * runs all of its rounds, so these counts live here rather than in the
 * workflow.
 *
 * One round each: a level's sessions are the sample. c50 pools 50 sessions and
 * 500 actions from a single round, which is what the per-session and
 * per-action stats are built from. The round-level wall clocks (create, connect,
 * task, release) get one observation per level as a consequence, so their median
 * and p95 are the same number — see CONCURRENT_ROUNDS_PER_LEVEL to raise this
 * locally, and keep any override at 25 or below, since each round reports four
 * steps against a 100-step limit per task record.
 */
export const ROUNDS_PER_LEVEL: Record<ConcurrencyLevel, number> = {
  1: 1,
  5: 1,
  10: 1,
  25: 1,
  50: 1,
};

/** Phase name for a level. Each level is one phase, so records carry `c25`. */
export function phaseNameForLevel(level: number): string {
  return `c${level}`;
}

/**
 * Level a phase name refers to.
 *
 * The level is read back from the phase rather than from the task index,
 * because the index is positional: running a subset would otherwise map task 0
 * to c1 no matter which level was actually asked for.
 */
export function levelFromPhaseName(phase: string | undefined): ConcurrencyLevel | undefined {
  return CONCURRENCY_LEVELS.find((level) => phaseNameForLevel(level) === phase);
}

/** Parses a `--levels 1,5` value into levels, or reports what was wrong. */
export function parseLevels(raw: string | undefined): {
  levels: ConcurrencyLevel[];
  error?: string;
} {
  if (!raw) return { levels: [...CONCURRENCY_LEVELS] };
  const requested = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const unknown = requested.filter(
    (part) => !CONCURRENCY_LEVELS.some((level) => String(level) === part),
  );
  if (requested.length === 0 || unknown.length > 0) {
    return {
      levels: [],
      error:
        `Invalid --levels "${raw}"` +
        (unknown.length > 0 ? `: unknown level(s) ${unknown.join(', ')}` : '') +
        `. Choose from ${CONCURRENCY_LEVELS.join(', ')}.`,
    };
  }
  // Ascending regardless of the order given, so the sweep always climbs and the
  // cooldown between levels is never asked to shed a bigger level into a
  // smaller one.
  return {
    levels: CONCURRENCY_LEVELS.filter((level) => requested.includes(String(level))),
  };
}

export interface ActionResult {
  /** 1-based index of the action within the session (1-10) */
  index: number;
  type: ActionType;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Per-session timing data collected during one barrier round. */
export interface SessionResult {
  /** Provider session ID */
  sessionId: string;
  /** Time to create this session in ms (parallel with N-1 others) */
  createMs: number;
  /** Time to CDP-connect this session in ms */
  connectMs: number;
  /** Sum of action durations for this session */
  taskMs: number;
  /** How many of 10 actions succeeded */
  actionsCompleted: number;
  /** actionsCompleted / (taskMs / 1000) */
  actionsPerSecond: number;
  /** Per-action results, in order */
  actions: ActionResult[];
  /** Error message if this session failed before actions */
  error?: string;
}

/** Per-round (one barrier protocol execution) timing data. */
export interface RoundResult {
  /** Sessions held open simultaneously during this round. */
  concurrencyLevel: number;
  /** Position of this round within its level, from 0. */
  roundIndex: number;
  /** How many sessions were attempted (= concurrency level) */
  sessionsAttempted: number;
  /** How many sessions survived create + connect */
  sessionsAlive: number;
  /** Wall clock to create all N sessions in parallel */
  createMs: number;
  /** Wall clock to CDP-connect all N sessions in parallel */
  connectMs: number;
  /** Wall clock for all N action loops to complete in parallel */
  taskMs: number;
  /** Wall clock to release all N sessions in parallel */
  releaseMs: number;
  /** Total round wall clock */
  totalMs: number;
  /** Aggregate actions/sec across all N sessions */
  aggregateActionsPerSecond: number;
  /** Per-session results */
  sessions: SessionResult[];
  /** Error message if the entire round failed */
  error?: string;
  /** True when no session survived create + connect, so the round produced no timings. */
  roundFailed?: boolean;
  /**
   * Highest number of sessions this round held on the provider at once, counted
   * from create to destroy. It is measured rather than assumed: a level that
   * overlapped its neighbour would report more than sessionsAttempted here,
   * which is how a c1 level once ran against 91 live sessions unnoticed.
   */
  maxLiveSessions?: number;
  /**
   * Highest number of sessions running actions simultaneously. This is the
   * number the level claims to test, so a c50 round that never reaches 50 did
   * not exercise the concurrency it reports.
   */
  maxConcurrentActions?: number;
  /** Loops each session was asked to run, before any budget cutoff. */
  loopsPerSession?: number;
  /**
   * True when at least one action hit the per-action timeout. Those actions were
   * cut off at the limit rather than measured, so the round's action wall clock
   * is censored and the summarizer rebuilds it from the unaffected sessions.
   */
  actionTimedOut?: boolean;
  /**
   * True when at least one create hit the timeout. The parallel create wall
   * clock is then censored by the timeout rather than measured, so it is
   * excluded from latency stats and counted only as a failure.
   */
  createTimedOut?: boolean;
}

export interface ConcurrentStatsTriple {
  median: number;
  p95: number;
  p99: number;
  /**
   * Observations behind the numbers above. Consumers compare it against
   * MIN_SAMPLES_FOR_P95 / MIN_SAMPLES_FOR_P99 and withhold what it cannot
   * support, rather than printing the median three times over.
   */
  samples?: number;
}

export interface ConcurrentStats {
  /** Sessions alive per round */
  sessionsAlive: ConcurrentStatsTriple;
  /** Parallel create wall clock */
  createMs: ConcurrentStatsTriple;
  /** Parallel connect wall clock */
  connectMs: ConcurrentStatsTriple;
  /** Parallel action loop wall clock, for the whole action phase of a round */
  taskMs: ConcurrentStatsTriple;
  /**
   * One session's time for one ten-action loop, pooled over every session and
   * loop in the level. This is the latency metric that compares across levels:
   * taskMs covers a whole action phase, so a level running 20 loops is not
   * comparable to one running 1.
   */
  loopMs: ConcurrentStatsTriple;
  /** Aggregate actions/sec across all sessions */
  actionsPerSecond: ConcurrentStatsTriple;
  /** Per-session actions/sec (the degradation signal) */
  perSessionActionsPerSecond: ConcurrentStatsTriple;
  /** Per-action-type stats, aggregated across all sessions in all rounds */
  perActionType: Record<ActionType, ConcurrentStatsTriple>;
}

export interface ConcurrentBenchmarkResult {
  provider: string;
  mode: 'browser-concurrent';
  /** Concurrency level (N sessions per round) */
  concurrencyLevel: number;
  /** Barrier rounds executed */
  rounds: RoundResult[];
  summary: ConcurrentStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  /** Most sessions run at once in any round. Computed post-benchmark. */
  sessionCeiling?: number;
  /** Concurrency the latency samples actually experienced. Computed post-benchmark. */
  concurrencyAchieved?: number;
  /**
   * False when the provider never sustained the requested concurrency, so its
   * latency describes a smaller experiment and must not be charted alongside
   * providers that ran the full load.
   */
  latencyRepresentative?: boolean;
  /** True when an account limit, not capacity, kept the level out of reach. */
  quotaLimited?: boolean;
  /** The provider's own limit message, for attribution. */
  quotaEvidence?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface ConcurrentProviderConfig {
  name: string;
  iterations?: number;
  timeout?: number;
  requiredEnvVars: string[];
  createBrowserProvider: () => any;
  sessionCreateOptions?: Record<string, unknown>;
}
