/**
 * Shared workload task for AI-gateway throughput benchmarks.
 *
 * Reuses the SSE probe logic from `phase-probe.ts` but runs a sustained
 * concurrency ramp: one https.Agent with keep-alive, a fixed number of
 * in-flight requests, and a bounded duration. Per-request ttfb/ttft/totalMs,
 * input/output tokens, and errors are collected and then summarized into
 * aggregate p50/p95/p99 metrics.
 */
import https from 'node:https';
import pLimit from 'p-limit';
import { TaskError } from '@benchsdk/runner';
import type { TaskContext, TaskResult } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/api';
import { sendAndMeasure, buildRequestBody } from './phase-probe.js';
import type { RawProbeOutcome } from './phase-probe.js';
import { computeStats } from '../src/util/stats.js';
import { formatError } from '../src/util/error.js';
import { PROMPT } from './shared-task.js';
import type { AIGatewayProviderConfig } from './types.js';

export interface WorkloadOptions {
  /** Max output tokens for each request. */
  maxTokens: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** How long to keep the concurrency level saturated, in milliseconds. */
  durationMs: number;
  /** Hard cap on total requests for this level (defaults to `concurrency * 10`). */
  maxRequests?: number;
}

export interface WorkloadRequest {
  ttfbMs: number;
  ttftMs: number;
  totalMs: number;
  outputTokens?: number;
  inputTokens?: number;
  outputTokensPerSec?: number;
  error?: string;
  timeout?: boolean;
}

export interface WorkloadSummary extends JsonObject {
  concurrency: number;
  durationMs: number;
  elapsedMs: number;
  totalRequests: number;
  successfulRequests: number;
  errorCount: number;
  timeoutCount: number;
  errorRate: number;
  timeoutRate: number;
  requestsPerSec: number;
  tokensPerSec: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  p50TotalMs: number;
  p95TotalMs: number;
  p99TotalMs: number;
  p50TtfbMs: number;
  p95TtfbMs: number;
  p99TtfbMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
  // arrays used for scoring
  totalMs: number[];
  ttfbMs: number[];
  ttftMs: number[];
  outputTokensPerSec: number[];
}

function now(): number {
  return performance.now();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Rough token count estimate for the fixed prompt, used as a fallback. */
function estimatePromptTokens(): number {
  return Math.max(1, Math.ceil(PROMPT.length / 4));
}

function isTimeoutError(message: string): boolean {
  return message.toLowerCase().includes('timed out') || message.toLowerCase().includes('timeout');
}

function perRequestTokensPerSec(outcome: RawProbeOutcome): number | undefined {
  if (!outcome.outputTokens || outcome.outputTokens <= 0) return undefined;
  return outcome.outputTokens / (Math.max(outcome.totalMs, 1) / 1000);
}

async function runSustainedWorkload(
  config: AIGatewayProviderConfig,
  concurrency: number,
  options: WorkloadOptions,
): Promise<WorkloadSummary> {
  const { maxTokens, timeoutMs, durationMs } = options;
  const maxRequests = options.maxRequests ?? concurrency * 10;
  const body = buildRequestBody(config, PROMPT, maxTokens);
  const agent = new https.Agent({ keepAlive: true, maxSockets: concurrency });

  const limit = pLimit(concurrency);
  const stopAt = now() + durationMs;

  const totalMs: number[] = [];
  const ttfbMs: number[] = [];
  const ttftMs: number[] = [];
  const outputTokensPerSec: number[] = [];

  let spawned = 0;
  let successfulRequests = 0;
  let errorCount = 0;
  let timeoutCount = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;

  const promises: Promise<void>[] = [];
  let done = false;

  async function runOneRequest(): Promise<void> {
    try {
      const outcome = await sendAndMeasure(config, body, agent, timeoutMs);
      successfulRequests++;
      totalOutputTokens += outcome.outputTokens ?? 0;
      totalInputTokens += outcome.inputTokens ?? estimatePromptTokens();
      totalMs.push(outcome.totalMs);
      ttfbMs.push(outcome.ttfbMs);
      ttftMs.push(outcome.ttftMs);
      const tps = perRequestTokensPerSec(outcome);
      if (tps !== undefined) outputTokensPerSec.push(tps);
    } catch (err) {
      const message = formatError(err);
      if (isTimeoutError(message)) timeoutCount++;
      else errorCount++;
    }
  }

  // Keep `concurrency` requests in flight for `durationMs` (or until maxRequests).
  while (!done) {
    if (spawned >= maxRequests || now() >= stopAt) {
      done = true;
      break;
    }
    if (limit.activeCount + limit.pendingCount < concurrency * 2) {
      spawned++;
      promises.push(limit(runOneRequest));
    } else {
      // Wait for at least one slot to free up before producing more tasks.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  await Promise.all(promises);
  agent.destroy();

  const elapsedMs = now() - (stopAt - durationMs);
  const totalRequests = successfulRequests + errorCount + timeoutCount;
  const errorRate = totalRequests > 0 ? round2((errorCount + timeoutCount) / totalRequests) : 0;
  const timeoutRate = totalRequests > 0 ? round2(timeoutCount / totalRequests) : 0;
  const requestsPerSec = elapsedMs > 0 ? round2(successfulRequests / (elapsedMs / 1000)) : 0;
  const tokensPerSec = elapsedMs > 0 ? round2(totalOutputTokens / (elapsedMs / 1000)) : 0;

  const totalMsStats = computeStats(totalMs);
  const ttfbStats = computeStats(ttfbMs);
  const ttftStats = computeStats(ttftMs);

  if (totalRequests === 0) {
    throw new TaskError('No workload requests completed', { code: 'workload_empty' });
  }

  return {
    concurrency,
    durationMs,
    elapsedMs: round2(elapsedMs),
    totalRequests,
    successfulRequests,
    errorCount,
    timeoutCount,
    errorRate,
    timeoutRate,
    requestsPerSec,
    tokensPerSec,
    totalInputTokens,
    totalOutputTokens,
    p50TotalMs: round2(totalMsStats.median),
    p95TotalMs: round2(totalMsStats.p95),
    p99TotalMs: round2(totalMsStats.p99),
    p50TtfbMs: round2(ttfbStats.median),
    p95TtfbMs: round2(ttfbStats.p95),
    p99TtfbMs: round2(ttfbStats.p99),
    p50TtftMs: round2(ttftStats.median),
    p95TtftMs: round2(ttftStats.p95),
    p99TtftMs: round2(ttftStats.p99),
    totalMs,
    ttfbMs,
    ttftMs,
    outputTokensPerSec,
  };
}

/**
 * Returns a task closed over the workload parameters. `ctx.phase` is expected
 * to be a numeric concurrency level (e.g. "1", "8", "16", "32").
 */
export function makeAIGatewayWorkloadTask(options: WorkloadOptions) {
  return async function aiGatewayWorkloadTask(
    ctx: TaskContext<AIGatewayProviderConfig>,
  ): Promise<TaskResult> {
    const concurrency = Number(ctx.phase);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TaskError(`Invalid workload concurrency phase: ${ctx.phase}`, { code: 'invalid_phase' });
    }

    const summary = await ctx.step('workload', () =>
      runSustainedWorkload(ctx.participant, concurrency, options),
    );

    ctx.log(
      `${ctx.participant.name} workload c=${concurrency}: ` +
        `rps=${summary.requestsPerSec} tok/s=${summary.tokensPerSec} ` +
        `error=${summary.errorRate} p95total=${summary.p95TotalMs}ms`,
      summary as unknown as JsonObject,
    );

    return { data: summary as unknown as JsonObject, latencyMs: summary.elapsedMs };
  };
}
