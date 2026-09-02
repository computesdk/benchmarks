/**
 * Shared task plumbing for every AI-gateway family benchmark (Anthropic,
 * OpenAI, Gemini, Kimi). Deliberately holds only what's identical across
 * every family — the probe task itself, phase/step shaping, and CLI
 * iteration-flag parsing — not the family's own identity (`benchmarkSlug`,
 * `providers`, `scoring`, `onComplete`), which each `*.bench.ts` file
 * declares directly via `defineBenchmarkConfig`, mirroring
 * `ai-gateway.bench.ts` (the Anthropic family, the original of the four).
 * Config/scoring intentionally isn't abstracted here even though it's
 * near-identical across families: `defineBenchmarkConfig` is the shape every
 * other benchmark in this repo declares inline, in one file, so each family
 * staying a self-contained `bench run <file>` entrypoint keeps this
 * benchmark legible the same way and avoids drifting from that convention
 * every time the shared runner's config surface changes.
 *
 * See `ai-gateway.bench.ts` for the full fairness rationale (groupBy:
 * 'round', cold/warm phases, etc.) — it applies to every family built on
 * this module, not just the original Anthropic one.
 */
import { TaskError } from '@benchsdk/runner';
import type { TaskContext, TaskResult } from '@benchsdk/runner';
import type { JsonObject, TaskStepRecord } from '@benchsdk/api';
import { runColdProbe, runWarmProbe } from './phase-probe.js';
import type { AIGatewayProviderConfig, PhaseProbeResult } from './types.js';

export const PROMPT = 'Write a two-sentence description of how distributed systems handle partial failures.';

/** Parses `--flag N` or `--flag=N` from argv; mirrors run.ts's own flag parsing. */
export function parseIntFlag(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) {
    const n = Number(eq.slice(flag.length + 1));
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return undefined;
}

/**
 * Resolves this run's cold/warm phase list from `--iterations` (sets both)
 * or the per-phase `--ai-gateway-iterations-cold/-warm` overrides — mirrors
 * `ai-gateway.bench.ts`'s original flag handling. The CLI asserts every
 * phase has iterations >= 1, but run.ts historically allowed a phase to be
 * dialed to 0 (e.g. to skip the warm phase entirely), so any zeroed phase is
 * dropped before it reaches the runner; if that empties the list, the caller
 * has nothing to run.
 */
export function resolveAIGatewayPhases(argv: string[]): Array<{ name: string; iterations: number }> {
  const iterationsOverride = parseIntFlag(argv, '--iterations');
  const iterationsCold = parseIntFlag(argv, '--ai-gateway-iterations-cold') ?? iterationsOverride ?? 50;
  const iterationsWarm = parseIntFlag(argv, '--ai-gateway-iterations-warm') ?? iterationsOverride ?? 50;
  return [
    { name: 'cold', iterations: iterationsCold },
    { name: 'warm', iterations: iterationsWarm },
  ].filter((p) => p.iterations > 0);
}

/** Builds DNS/TCP/TLS (cold only) + TTFB/TTFT as pre-measured platform steps. */
function phaseSteps(result: PhaseProbeResult): TaskStepRecord[] {
  const stepStatus: TaskStepRecord['status'] = result.error ? 'error' : 'success';
  const steps: TaskStepRecord[] = [];
  if (result.mode === 'cold') {
    if (result.dnsMs !== undefined) steps.push({ name: 'dns', status: 'success', latencyMs: result.dnsMs });
    if (result.tcpMs !== undefined) steps.push({ name: 'tcp', status: 'success', latencyMs: result.tcpMs });
    if (result.tlsMs !== undefined) steps.push({ name: 'tls', status: 'success', latencyMs: result.tlsMs });
  }
  steps.push({ name: 'ttfb', status: stepStatus, latencyMs: result.ttfbMs });
  // Token throughput/count are non-latency metrics (a rate the step's latency
  // can't express), so attach them to the ttft step's data → step_data_json.
  const ttftData: JsonObject = {
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
  };
  steps.push({
    name: 'ttft',
    status: stepStatus,
    latencyMs: result.ttftMs,
    ...(Object.keys(ttftData).length > 0 ? { data: ttftData } : {}),
  });
  return steps;
}

function probeData(result: PhaseProbeResult): JsonObject {
  // The scored latency is reported under a phase-specific key (`coldE2eMs` /
  // `warmTtftMs`) so cold and warm are separate metrics without a scoring-time
  // phase filter.
  const scoredLatencyMs = result.mode === 'cold' ? result.coldE2eMs ?? result.ttftMs : result.ttftMs;
  return {
    mode: result.mode,
    ...(typeof scoredLatencyMs === 'number' && Number.isFinite(scoredLatencyMs)
      ? { [result.mode === 'cold' ? 'coldE2eMs' : 'warmTtftMs']: scoredLatencyMs }
      : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
    ...(result.resolvedProvider !== undefined ? { resolvedProvider: result.resolvedProvider } : {}),
    ...(result.receipts && Object.keys(result.receipts).length > 0 ? { receipts: result.receipts } : {}),
    ...(result.error ? { errorMessage: result.error } : {}),
  };
}

/**
 * Returns a task closed over `maxTokens`/`timeoutMs` so each family can size
 * them independently (Kimi's reasoning-locked model needs a bigger token
 * budget and a longer timeout than the rest — see `ai-gateway-kimi.bench.ts`)
 * without a shared constant forcing every family to the same values.
 */
export function makeAIGatewayTask(maxTokens: number, timeoutMs: number) {
  return async function aiGatewayTask(ctx: TaskContext<AIGatewayProviderConfig>): Promise<TaskResult> {
    const isCold = ctx.phase === 'cold';
    const result = isCold
      ? await runColdProbe(ctx.participant, PROMPT, maxTokens, timeoutMs)
      : await runWarmProbe(ctx.participant, PROMPT, maxTokens, timeoutMs);

    const steps = phaseSteps(result);

    if (result.error) {
      ctx.log(`${ctx.participant.name} ${result.mode} probe failed: ${result.error}`, {
        level: 'error',
        meta: probeData(result),
      });
      throw new TaskError(result.error, { code: 'probe_failed', data: probeData(result), steps });
    }
    ctx.log(
      `${ctx.participant.name} ${result.mode} probe: ttfb=${result.ttfbMs}ms ttft=${result.ttftMs}ms`,
      { level: 'info', meta: probeData(result) },
    );
    return {
      data: probeData(result),
      steps,
      latencyMs: isCold ? result.coldE2eMs ?? result.ttftMs : result.ttftMs,
    };
  };
}
