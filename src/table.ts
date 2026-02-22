import type { BenchmarkResult, WorkloadConfig } from './types.js';

interface ResultsFileConfig {
  iterations: number;
  timeoutMs: number;
  providerFilter?: string;
  workload?: WorkloadConfig;
}

/**
 * Print a comparison table of benchmark results to stdout
 */
export function printResultsTable(results: BenchmarkResult[]): void {
  const nameWidth = 12;
  const colWidth = 14;
  const hasWorkloadMetric = results.some(result => !!result.summary.workloadMs);
  const hasTotalMetric = results.some(result => !!result.summary.totalMs);

  const headerColumns = [
    pad('Provider', nameWidth),
    pad('TTI (s)', colWidth),
    pad('Min (s)', colWidth),
    pad('Max (s)', colWidth),
    ...(hasWorkloadMetric ? [pad('Workload (s)', colWidth)] : []),
    ...(hasTotalMetric ? [pad('Total (s)', colWidth)] : []),
    pad('Status', 10),
  ];

  const header = headerColumns.join(' | ');

  const separatorColumns = [
    '-'.repeat(nameWidth),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    '-'.repeat(colWidth),
    ...(hasWorkloadMetric ? ['-'.repeat(colWidth)] : []),
    ...(hasTotalMetric ? ['-'.repeat(colWidth)] : []),
    '-'.repeat(10),
  ];

  const separator = separatorColumns.join('-+-');

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
      const skippedColumns = [
        pad(result.provider, nameWidth),
        pad('--', colWidth),
        pad('--', colWidth),
        pad('--', colWidth),
        ...(hasWorkloadMetric ? [pad('--', colWidth)] : []),
        ...(hasTotalMetric ? [pad('--', colWidth)] : []),
        pad('SKIPPED', 10),
      ];

      console.log(skippedColumns.join(' | '));
      continue;
    }

    const successful = result.iterations.filter(r => !r.error).length;
    const total = result.iterations.length;

    const rowColumns = [
      pad(result.provider, nameWidth),
      pad(formatSeconds(result.summary.ttiMs.median), colWidth),
      pad(formatSeconds(result.summary.ttiMs.min), colWidth),
      pad(formatSeconds(result.summary.ttiMs.max), colWidth),
      ...(hasWorkloadMetric
        ? [pad(result.summary.workloadMs ? formatSeconds(result.summary.workloadMs.median) : '--', colWidth)]
        : []),
      ...(hasTotalMetric
        ? [pad(result.summary.totalMs ? formatSeconds(result.summary.totalMs.median) : '--', colWidth)]
        : []),
      pad(`${successful}/${total} OK`, 10),
    ];

    console.log(rowColumns.join(' | '));
  }

  console.log('='.repeat(separator.length));
  console.log('  TTI = Time to Interactive (median). Create + first code execution.');
  if (hasWorkloadMetric || hasTotalMetric) {
    console.log('  Workload = Setup + workload commands. Total = TTI + workload.');
  }
  console.log('');
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
export async function writeResultsJson(
  results: BenchmarkResult[],
  outPath: string,
  config: ResultsFileConfig
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  // Clean up floating point noise in results
  const cleanResults = results.map(r => ({
    provider: r.provider,
    iterations: r.iterations.map(i => ({
      ttiMs: round(i.ttiMs),
      ...(typeof i.workloadMs === 'number' ? { workloadMs: round(i.workloadMs) } : {}),
      ...(typeof i.totalMs === 'number' ? { totalMs: round(i.totalMs) } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      ttiMs: {
        min: round(r.summary.ttiMs.min),
        max: round(r.summary.ttiMs.max),
        median: round(r.summary.ttiMs.median),
        avg: round(r.summary.ttiMs.avg),
      },
      ...(r.summary.workloadMs
        ? {
            workloadMs: {
              min: round(r.summary.workloadMs.min),
              max: round(r.summary.workloadMs.max),
              median: round(r.summary.workloadMs.median),
              avg: round(r.summary.workloadMs.avg),
            },
          }
        : {}),
      ...(r.summary.totalMs
        ? {
            totalMs: {
              min: round(r.summary.totalMs.min),
              max: round(r.summary.totalMs.max),
              median: round(r.summary.totalMs.median),
              avg: round(r.summary.totalMs.avg),
            },
          }
        : {}),
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
      iterations: config.iterations,
      timeoutMs: config.timeoutMs,
      ...(config.providerFilter ? { providerFilter: config.providerFilter } : {}),
      ...(config.workload
        ? {
            workload: {
              name: config.workload.name,
              hasSetupCommand: Boolean(config.workload.setupCommand),
              hasWorkloadCommand: Boolean(config.workload.command),
              ...(config.workload.cwd ? { cwd: config.workload.cwd } : {}),
              ...(typeof config.workload.timeoutMs === 'number'
                ? { timeoutMs: config.workload.timeoutMs }
                : {}),
            },
          }
        : {}),
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
