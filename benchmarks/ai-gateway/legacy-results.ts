import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject, TaskResultRecord, TaskStepRecord } from '@benchsdk/api';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import { writeAIGatewayResultsJson } from './benchmark.js';
import { computeAIGatewayCompositeScores } from './scoring.js';
import type {
  AIGatewayProviderConfig,
  AIGatewayBenchmarkResult,
  AIGatewayStats,
  PhaseProbeResult,
} from './types.js';

function stepLatency(steps: TaskStepRecord[] | undefined, name: string): number | undefined {
  const s = steps?.find((step) => step.name === name);
  return s && typeof s.latencyMs === 'number' ? s.latencyMs : undefined;
}

function numbers(values: (number | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number');
}

/**
 * Reconstruct one `PhaseProbeResult` from a task record. The AI-gateway task
 * returns phase timings as pre-measured platform steps (dns/tcp/tls/ttfb/ttft)
 * and the end-to-end latency as `record.latencyMs`; the domain payload
 * (mode/tokens/receipts) lives in `record.data`.
 */
function recordToProbe(r: TaskResultRecord): PhaseProbeResult {
  const d = (r.data ?? {}) as JsonObject;
  const mode: 'cold' | 'warm' = d.phase === 'warm' || d.mode === 'warm' ? 'warm' : 'cold';

  const probe: PhaseProbeResult = {
    mode,
    ttfbMs: stepLatency(r.steps, 'ttfb') ?? 0,
    ttftMs: stepLatency(r.steps, 'ttft') ?? 0,
    receipts: (d.receipts as Record<string, string>) ?? {},
  };

  if (mode === 'cold') {
    probe.dnsMs = stepLatency(r.steps, 'dns');
    probe.tcpMs = stepLatency(r.steps, 'tcp');
    probe.tlsMs = stepLatency(r.steps, 'tls');
    probe.coldE2eMs = typeof r.latencyMs === 'number' ? r.latencyMs : undefined;
  }
  if (typeof d.outputTokens === 'number') probe.outputTokens = d.outputTokens;
  if (typeof d.outputTokensPerSec === 'number') probe.outputTokensPerSec = d.outputTokensPerSec;
  if (typeof d.resolvedProvider === 'string') probe.resolvedProvider = d.resolvedProvider;
  if (r.status === 'error') probe.error = (d.errorMessage as string) ?? r.errorCode ?? 'error';

  return probe;
}

function summarize(iterations: PhaseProbeResult[]): AIGatewayStats {
  const successful = iterations.filter((i) => !i.error);
  const cold = successful.filter((i) => i.mode === 'cold');
  const warm = successful.filter((i) => i.mode === 'warm');
  return {
    dnsMs: computeStats(numbers(cold.map((i) => i.dnsMs))),
    tcpMs: computeStats(numbers(cold.map((i) => i.tcpMs))),
    tlsMs: computeStats(numbers(cold.map((i) => i.tlsMs))),
    coldTtfbMs: computeStats(cold.map((i) => i.ttfbMs)),
    coldTtftMs: computeStats(cold.map((i) => i.ttftMs)),
    coldE2eMs: computeStats(numbers(cold.map((i) => i.coldE2eMs))),
    warmTtfbMs: computeStats(warm.map((i) => i.ttfbMs)),
    warmTtftMs: computeStats(warm.map((i) => i.ttftMs)),
    outputTokensPerSec: computeStats(numbers(successful.map((i) => i.outputTokensPerSec))),
  };
}

/** Map CLI participant records to legacy AI-gateway BenchmarkResult[]. */
export function recordsToAIGatewayResults(
  participants: ParticipantRecords[],
  opts: { providers: AIGatewayProviderConfig[] },
): AIGatewayBenchmarkResult[] {
  return participants.map((participant) => {
    const providerConfig = opts.providers.find((p) => p.name === participant.participant);
    const model = providerConfig?.model ?? '';
    const iterations = byTaskIndex(participant.records).map(recordToProbe);
    return {
      provider: providerConfig?.displayName ?? participant.participant,
      mode: 'ai-gateway' as const,
      model,
      iterations,
      summary: summarize(iterations),
    };
  });
}

/**
 * Map records -> AIGatewayBenchmarkResult[], compute composite scores, and write
 * both `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeAIGatewayLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; providers: AIGatewayProviderConfig[] },
): Promise<void> {
  const results = recordsToAIGatewayResults(participants, opts);
  computeAIGatewayCompositeScores(results);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeAIGatewayResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
