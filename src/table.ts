import type { BenchmarkResult } from './types.js';

/**
 * Print a comparison table of benchmark results to stdout
 */
export function printResultsTable(results: BenchmarkResult[]): void {
  const nameWidth = 12;
  const colWidth = 14;

  const header = [
    pad('Provider', nameWidth),
    pad('TTI (s)', colWidth),
    pad('Min (s)', colWidth),
    pad('Max (s)', colWidth),
    pad('Status', 10),
  ].join(' | ');

  const separator = [
    '-'.repeat(nameWidth),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    '-'.repeat(10),
  ].join('-+-');

  console.log('\n' + '='.repeat(separator.length));
  console.log('  SANDBOX PROVIDER BENCHMARK RESULTS');
  console.log('='.repeat(separator.length));
  console.log(header);
  console.log(separator);

  // Sort by TTI (skipped providers last)
  const sorted = [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    return a.summary.ttiMs.median - b.summary.ttiMs.median;
  });

  for (const result of sorted) {
    if (result.skipped) {
      console.log([
        pad(result.provider, nameWidth),
        pad('--', colWidth),
        pad('--', colWidth),
        pad('--', colWidth),
        pad('SKIPPED', 10),
      ].join(' | '));
      continue;
    }

    const successful = result.iterations.filter(r => !r.error).length;
    const total = result.iterations.length;

    console.log([
      pad(result.provider, nameWidth),
      pad(formatSeconds(result.summary.ttiMs.median), colWidth),
      pad(formatSeconds(result.summary.ttiMs.min), colWidth),
      pad(formatSeconds(result.summary.ttiMs.max), colWidth),
      pad(`${successful}/${total} OK`, 10),
    ].join(' | '));
  }

  console.log('='.repeat(separator.length));
  console.log('  TTI = Time to Interactive (median). Create + first code execution.\n');
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
    iterations: r.iterations.map(i => ({
      ttiMs: round(i.ttiMs),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      ttiMs: {
        min: round(r.summary.ttiMs.min),
        max: round(r.summary.ttiMs.max),
        median: round(r.summary.ttiMs.median),
        avg: round(r.summary.ttiMs.avg),
      },
    },
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
      timeoutMs: 120000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}