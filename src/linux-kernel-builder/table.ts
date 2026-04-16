import type { LinuxKernelBuilderBenchmarkResult } from './types.js';
import { sortLinuxKernelBuilderByCompositeScore } from './scoring.js';
import { WORKLOAD, WORKLOAD_ACRONYM, WORKLOAD_LABEL } from './types.js';

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export function printLinuxKernelBuilderResultsTable(results: LinuxKernelBuilderBenchmarkResult[]): void {
  const header = [
    pad('Provider', 12),
    pad('Score', 8),
    pad('Build Med', 12),
    pad('Build P95', 12),
    pad('Build P99', 12),
    pad('Total Med', 12),
    pad('Status', 10),
  ].join(' | ');

  const separator = [12, 8, 12, 12, 12, 12, 10]
    .map(w => '-'.repeat(w))
    .join('-+-');

  console.log('\n' + '='.repeat(separator.length));
  console.log(`  COMPUTE PERFORMANCE RESULTS - ${WORKLOAD_ACRONYM} (${WORKLOAD_LABEL})`);
  console.log('='.repeat(separator.length));
  console.log(header);
  console.log(separator);

  const sorted = sortLinuxKernelBuilderByCompositeScore(results);

  for (const result of sorted) {
    const successful = result.iterations.filter(i => !i.error).length;
    const total = result.iterations.length;

    if (result.skipped) {
      console.log([
        pad(result.provider, 12),
        pad('--', 8),
        pad('--', 12),
        pad('--', 12),
        pad('--', 12),
        pad('--', 12),
        pad('SKIPPED', 10),
      ].join(' | '));
      continue;
    }

    const score = result.compositeScore !== undefined ? result.compositeScore.toFixed(1) : '--';
    const allFailed = successful === 0;

    console.log([
      pad(result.provider, 12),
      pad(score, 8),
      pad(allFailed ? '--' : formatSeconds(result.summary.buildMs.median), 12),
      pad(allFailed ? '--' : formatSeconds(result.summary.buildMs.p95), 12),
      pad(allFailed ? '--' : formatSeconds(result.summary.buildMs.p99), 12),
      pad(allFailed ? '--' : formatSeconds(result.summary.totalMs.median), 12),
      pad(`${successful}/${total} OK`, 10),
    ].join(' | '));
  }

  console.log('='.repeat(separator.length));
}

export async function writeLinuxKernelBuilderResultsJson(results: LinuxKernelBuilderBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    workload: r.workload,
    workloadAcronym: r.workloadAcronym,
    kernelVersion: r.kernelVersion,
    iterations: r.iterations.map(i => ({
      totalMs: round(i.totalMs),
      buildMs: round(i.buildMs),
      ...(i.cpuCount !== undefined ? { cpuCount: i.cpuCount } : {}),
      ...(i.memTotalKb !== undefined ? { memTotalKb: i.memTotalKb } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      buildMs: roundStats(r.summary.buildMs),
      totalMs: roundStats(r.summary.totalMs),
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
      iterations: results[0]?.iterations.length || 0,
      mode: 'linux-kernel-builder',
      workload: WORKLOAD,
      workloadAcronym: WORKLOAD_ACRONYM,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
