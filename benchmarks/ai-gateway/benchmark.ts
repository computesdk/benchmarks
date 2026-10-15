import { computeStats } from '../src/util/stats.js';
import { runColdProbe, runWarmProbe } from './phase-probe.js';
import type { AIGatewayProviderConfig, AIGatewayBenchmarkResult, AIGatewayStats, PhaseProbeResult } from './types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
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
      ...(i.resolvedProvider !== undefined ? { resolvedProvider: i.resolvedProvider } : {}),
      ...(i.protocol !== undefined ? { protocol: i.protocol } : {}),
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
