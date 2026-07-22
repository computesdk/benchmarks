import { computeStats } from '../util/stats.js';
import { runColdProbe, runWarmProbe } from './phase-probe.js';
import type { AIGatewayProviderConfig, AIGatewayBenchmarkResult, AIGatewayStats, PhaseProbeResult } from './types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

const EMPTY_STATS = { median: 0, p95: 0, p99: 0 };

function emptyGatewayStats(): AIGatewayStats {
  return {
    dnsMs: EMPTY_STATS,
    tcpMs: EMPTY_STATS,
    tlsMs: EMPTY_STATS,
    coldTtfbMs: EMPTY_STATS,
    coldTtftMs: EMPTY_STATS,
    coldE2eMs: EMPTY_STATS,
    warmTtfbMs: EMPTY_STATS,
    warmTtftMs: EMPTY_STATS,
    outputTokensPerSec: EMPTY_STATS,
  };
}

function numbers(values: (number | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number');
}

function summarizeProvider(config: AIGatewayProviderConfig, iterations: PhaseProbeResult[]): AIGatewayBenchmarkResult {
  const successful = iterations.filter(i => !i.error);
  const cold = successful.filter(i => i.mode === 'cold');
  const warm = successful.filter(i => i.mode === 'warm');

  return {
    provider: config.name,
    mode: 'ai-gateway',
    model: config.model,
    iterations,
    summary: {
      dnsMs: computeStats(numbers(cold.map(i => i.dnsMs))),
      tcpMs: computeStats(numbers(cold.map(i => i.tcpMs))),
      tlsMs: computeStats(numbers(cold.map(i => i.tlsMs))),
      coldTtfbMs: computeStats(cold.map(i => i.ttfbMs)),
      coldTtftMs: computeStats(cold.map(i => i.ttftMs)),
      coldE2eMs: computeStats(numbers(cold.map(i => i.coldE2eMs))),
      warmTtfbMs: computeStats(warm.map(i => i.ttfbMs)),
      warmTtftMs: computeStats(warm.map(i => i.ttftMs)),
      outputTokensPerSec: computeStats(numbers(successful.map(i => i.outputTokensPerSec))),
    },
  };
}

export interface AIGatewayRunOptions {
  /** Number of cold-connection iterations to run per gateway. */
  iterationsCold: number;
  /** Number of warm-connection iterations to run per gateway. */
  iterationsWarm: number;
  prompt: string;
  maxTokens: number;
  timeout: number;
}

/**
 * Runs `iterationsCold` cold probes and `iterationsWarm` warm probes per
 * gateway, ROUND-ROBIN across every active gateway: round 1 sends one probe
 * to every active gateway, round 2 sends the next probe to every active
 * gateway, and so on — rather than finishing one gateway's iterations before
 * starting the next gateway's. This is what cancels out time-of-day/model-
 * load drift between gateways.
 *
 * Note: with only one active gateway (e.g. a `--provider`-filtered run),
 * there's nothing to interleave with, so this degenerates to plain
 * sequential iteration — round-robin only has an observable effect when
 * more than one gateway is active at once.
 */
export async function runAIGatewayBenchmarks(
  providers: AIGatewayProviderConfig[],
  options: AIGatewayRunOptions,
): Promise<AIGatewayBenchmarkResult[]> {
  const { iterationsCold, iterationsWarm, prompt, maxTokens, timeout } = options;
  const results: AIGatewayBenchmarkResult[] = [];
  const active: { config: AIGatewayProviderConfig; iterations: PhaseProbeResult[] }[] = [];

  for (const config of providers) {
    const missingVars = config.requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      console.log(`\nSkipping ${config.name}: missing ${missingVars.join(', ')}`);
      results.push({
        provider: config.name,
        mode: 'ai-gateway',
        model: config.model,
        iterations: [],
        summary: emptyGatewayStats(),
        skipped: true,
        skipReason: `Missing: ${missingVars.join(', ')}`,
      });
      continue;
    }
    active.push({ config, iterations: [] });
  }

  if (active.length === 0) {
    return results;
  }

  const totalRounds = iterationsCold + iterationsWarm;
  console.log(`\n--- AI Gateway Benchmark: ${active.length} gateway(s), ${iterationsCold} cold + ${iterationsWarm} warm iteration(s) each, round-robin across gateways ---`);

  for (let round_ = 0; round_ < totalRounds; round_++) {
    const isCold = round_ < iterationsCold;
    const label = isCold ? 'cold' : 'warm';
    const roundIndex = isCold ? round_ + 1 : round_ - iterationsCold + 1;
    const roundTotal = isCold ? iterationsCold : iterationsWarm;

    for (const entry of active) {
      const probe = isCold ? runColdProbe : runWarmProbe;
      const result = await probe(entry.config, prompt, maxTokens, timeout);
      entry.iterations.push(result);

      if (result.error) {
        console.log(`  [${label} ${roundIndex}/${roundTotal}] ${entry.config.name}: FAILED — ${result.error}`);
      } else {
        const e2e = result.coldE2eMs !== undefined ? ` e2e ${result.coldE2eMs.toFixed(0)}ms` : '';
        console.log(`  [${label} ${roundIndex}/${roundTotal}] ${entry.config.name}: ttfb ${result.ttfbMs.toFixed(0)}ms ttft ${result.ttftMs.toFixed(0)}ms${e2e}`);
      }
    }
  }

  for (const entry of active) {
    results.push(summarizeProvider(entry.config, entry.iterations));
  }

  // Preserve the input provider order in the output.
  const byProvider = new Map(results.map(r => [r.provider, r]));
  return providers.map(p => byProvider.get(p.name)!);
}

export async function writeAIGatewayResultsJson(results: AIGatewayBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    model: r.model,
    iterations: r.iterations.map(i => ({
      mode: i.mode,
      ...(i.dnsMs !== undefined ? { dnsMs: round(i.dnsMs) } : {}),
      ...(i.tcpMs !== undefined ? { tcpMs: round(i.tcpMs) } : {}),
      ...(i.tlsMs !== undefined ? { tlsMs: round(i.tlsMs) } : {}),
      ttfbMs: round(i.ttfbMs),
      ttftMs: round(i.ttftMs),
      ...(i.coldE2eMs !== undefined ? { coldE2eMs: round(i.coldE2eMs) } : {}),
      ...(i.outputTokens !== undefined ? { outputTokens: i.outputTokens } : {}),
      ...(i.outputTokensPerSec !== undefined ? { outputTokensPerSec: round(i.outputTokensPerSec) } : {}),
      ...(i.receipts && Object.keys(i.receipts).length > 0 ? { receipts: i.receipts } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      dnsMs: roundStats(r.summary.dnsMs),
      tcpMs: roundStats(r.summary.tcpMs),
      tlsMs: roundStats(r.summary.tlsMs),
      coldTtfbMs: roundStats(r.summary.coldTtfbMs),
      coldTtftMs: roundStats(r.summary.coldTtftMs),
      coldE2eMs: roundStats(r.summary.coldE2eMs),
      warmTtfbMs: roundStats(r.summary.warmTtfbMs),
      warmTtftMs: roundStats(r.summary.warmTtftMs),
      outputTokensPerSec: roundStats(r.summary.outputTokensPerSec),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results.find(r => !r.skipped)?.iterations.length || 0,
      timeoutMs: 45000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
