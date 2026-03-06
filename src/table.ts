import type { BenchmarkResult, ConcurrentBenchmarkResult, StaggeredBenchmarkResult } from './types.js';
import { sortByCompositeScore } from './scoring.js';

function isConcurrent(r: BenchmarkResult): r is ConcurrentBenchmarkResult {
  return r.mode === 'concurrent';
}

function isStaggered(r: BenchmarkResult): r is StaggeredBenchmarkResult {
  return r.mode === 'staggered';
}

/**
 * Print a comparison table of benchmark results to stdout
 */
export function printResultsTable(results: BenchmarkResult[]): void {
  const nameWidth = 12;
  const colWidth = 14;

  const header = [
    pad('Provider', nameWidth),
    pad('Score', 8),
    pad('Median (s)', colWidth),
    pad('Min (s)', colWidth),
    pad('Max (s)', colWidth),
    pad('P95 (s)', colWidth),
    pad('P99 (s)', colWidth),
    pad('Status', 10),
  ].join(' | ');

  const separator = [
    '-'.repeat(nameWidth),
    '-'.repeat(8),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    '-'.repeat(10),
  ].join('-+-');

  console.log('\n' + '='.repeat(separator.length));
  console.log('  SANDBOX PROVIDER BENCHMARK RESULTS - TTI (Time to Interactive)');
  console.log('='.repeat(separator.length));
  console.log(header);
  console.log(separator);

  // Sort by composite score (highest first, skipped last)
  const sorted = sortByCompositeScore(results);

  for (const result of sorted) {
    if (result.skipped) {
      console.log([
        pad(result.provider, nameWidth),
        pad('--', 8),
        pad('--', colWidth),
        pad('--', colWidth),
        pad('--', colWidth),
        pad('--', colWidth),
        pad('--', colWidth),
        pad('SKIPPED', 10),
      ].join(' | '));
      continue;
    }

    const successful = result.iterations.filter(r => !r.error).length;
    const total = result.iterations.length;
    const score = result.compositeScore !== undefined
      ? result.compositeScore.toFixed(1)
      : '--';

    console.log([
      pad(result.provider, nameWidth),
      pad(score, 8),
      pad(formatSeconds(result.summary.ttiMs.median), colWidth),
      pad(formatSeconds(result.summary.ttiMs.min), colWidth),
      pad(formatSeconds(result.summary.ttiMs.max), colWidth),
      pad(formatSeconds(result.summary.ttiMs.p95), colWidth),
      pad(formatSeconds(result.summary.ttiMs.p99), colWidth),
      pad(`${successful}/${total} OK`, 10),
    ].join(' | '));
  }

  console.log('='.repeat(separator.length));

  // Show concurrent-specific metrics if applicable
  const concurrentResults = sorted.filter(isConcurrent);
  if (concurrentResults.length > 0) {
    console.log('  Burst concurrent metrics:');
    for (const r of concurrentResults) {
      console.log(`    ${r.provider}: ${r.concurrency} sandboxes | Wall clock: ${formatSeconds(r.wallClockMs)}s | First ready: ${formatSeconds(r.timeToFirstReadyMs)}s`);
    }
  }

  // Show staggered-specific metrics if applicable
  const staggeredResults = sorted.filter(isStaggered);
  if (staggeredResults.length > 0) {
    console.log('  Staggered metrics:');
    for (const r of staggeredResults) {
      console.log(`    ${r.provider}: ${r.concurrency} sandboxes (${r.staggerDelayMs}ms apart) | Wall clock: ${formatSeconds(r.wallClockMs)}s | First ready: ${formatSeconds(r.timeToFirstReadyMs)}s`);
    }
  }

  console.log('  TTI = Time to Interactive. Create + first code execution.\n');
}

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/**
 * Round a number to 2 decimal places
 */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Write results to a JSON file with clean formatting
 */
export async function writeResultsJson(results: BenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  // Clean up floating point noise in results
  const cleanResults = results.map(r => ({
    provider: r.provider,
    ...(r.mode ? { mode: r.mode } : {}),
    ...(isConcurrent(r) ? {
      concurrency: r.concurrency,
      wallClockMs: round(r.wallClockMs),
      timeToFirstReadyMs: round(r.timeToFirstReadyMs),
    } : {}),
    ...(isStaggered(r) ? {
      concurrency: r.concurrency,
      staggerDelayMs: r.staggerDelayMs,
      wallClockMs: round(r.wallClockMs),
      timeToFirstReadyMs: round(r.timeToFirstReadyMs),
      rampProfile: r.rampProfile.map(p => ({
        launchedAt: round(p.launchedAt),
        readyAt: round(p.readyAt),
        ttiMs: round(p.ttiMs),
      })),
    } : {}),
    iterations: r.iterations.map(i => ({
      ttiMs: round(i.ttiMs),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      ttiMs: {
        min: round(r.summary.ttiMs.min),
        max: round(r.summary.ttiMs.max),
        median: round(r.summary.ttiMs.median),
        p95: round(r.summary.ttiMs.p95),
        p99: round(r.summary.ttiMs.p99),
        avg: round(r.summary.ttiMs.avg),
      },
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.1',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 120000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}