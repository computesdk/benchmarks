/**
 * Capacity analysis: what a provider actually delivered at a requested
 * concurrency level, and whether its latency numbers mean anything.
 *
 * Latency percentiles are computed over surviving sessions only, so a provider
 * that refuses most of the load measures itself on a nearly idle account. In
 * one observed run a provider capped at 10 sessions posted the best task
 * latency of any provider at c50 while delivering 14% of the sessions — its
 * samples never experienced concurrency at all. Reporting that number next to
 * a provider that ran all 50 compares two different experiments.
 */

import type { ConcurrentBenchmarkResult } from './concurrent-types.js';

/**
 * How close to the requested concurrency the sampled rounds must run before
 * their latency is treated as comparable. Below this the level's latency
 * describes a smaller experiment than the one requested.
 */
export const LATENCY_REPRESENTATIVE_RATIO = 0.9;

/**
 * Refusals naming an account limit rather than a capacity failure. These make
 * a level unreachable for reasons of billing, so the resulting score measures
 * the plan we bought rather than anything about the provider.
 */
const QUOTA_REFUSAL = /\b429\b|quota|rate limit|limit exceeded|limit reached/i;

/** Longest quota message carried into the result; the full text stays on the session. */
const MAX_EVIDENCE_LENGTH = 160;

export interface CapacityAnalysis {
  /** Most sessions the provider ran at once in any round. */
  sessionCeiling: number;
  /**
   * Mean sessions alive across rounds that produced any — the concurrency the
   * latency samples actually experienced. Rounds where every session was
   * refused contribute no samples, so they are excluded rather than averaged
   * in as zeros.
   */
  concurrencyAchieved: number;
  /** True when the latency samples ran at (near) the requested concurrency. */
  latencyRepresentative: boolean;
  /** True when the provider refused sessions citing an account limit and never reached the level. */
  quotaLimited: boolean;
  /** The provider's own most frequent limit message, for attribution. */
  quotaEvidence?: string;
}

/**
 * Attach capacity fields to results that lack them. Result files written
 * before these fields existed still carry a `compositeScore`, so a consumer
 * that gates on the score alone would treat those results as fully analyzed
 * and chart latency it should be withholding.
 */
export function ensureCapacityFields(results: ConcurrentBenchmarkResult[]): void {
  for (const result of results) {
    if (result.latencyRepresentative !== undefined) continue;
    const capacity = analyzeCapacity(result);
    result.sessionCeiling = capacity.sessionCeiling;
    result.concurrencyAchieved = capacity.concurrencyAchieved;
    result.latencyRepresentative = capacity.latencyRepresentative;
    result.quotaLimited = capacity.quotaLimited;
    if (capacity.quotaEvidence) result.quotaEvidence = capacity.quotaEvidence;
  }
}

export function analyzeCapacity(result: ConcurrentBenchmarkResult): CapacityAnalysis {
  const roundsWithSessions = result.rounds.filter(r => r.sessionsAlive > 0);
  const sessionCeiling = result.rounds.reduce((max, r) => Math.max(max, r.sessionsAlive), 0);
  const concurrencyAchieved =
    roundsWithSessions.length > 0
      ? roundsWithSessions.reduce((sum, r) => sum + r.sessionsAlive, 0) / roundsWithSessions.length
      : 0;

  const refusalCounts = new Map<string, number>();
  for (const round of result.rounds) {
    for (const session of round.sessions) {
      if (session.error && QUOTA_REFUSAL.test(session.error)) {
        const key = session.error.slice(0, MAX_EVIDENCE_LENGTH);
        refusalCounts.set(key, (refusalCounts.get(key) ?? 0) + 1);
      }
    }
  }

  let quotaEvidence: string | undefined;
  let mostSeen = 0;
  for (const [message, count] of refusalCounts) {
    if (count > mostSeen) {
      mostSeen = count;
      quotaEvidence = message;
    }
  }

  const latencyRepresentative =
    concurrencyAchieved >= result.concurrencyLevel * LATENCY_REPRESENTATIVE_RATIO;

  return {
    sessionCeiling,
    concurrencyAchieved: Math.round(concurrencyAchieved * 100) / 100,
    latencyRepresentative,
    // Gated on sustaining the level rather than on the ceiling: a provider
    // whose cap equals the level can still touch it for one round and spend
    // the rest throttled, which is a quota limit even though the ceiling
    // matches. Conversely a provider that hit a rate limit yet still ran the
    // full load throughout was not capped by it.
    quotaLimited: refusalCounts.size > 0 && !latencyRepresentative,
    ...(quotaEvidence ? { quotaEvidence } : {}),
  };
}
