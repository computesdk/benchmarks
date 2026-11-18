import type { FsIoBenchmarkResult, FsIoMode, FsIoWorkloadResult } from './sandbox-fs-io.js';

const nameWidth = 14;
const scoreWidth = 8;
const colWidths = [11, 11, 11, 10, 8];
const statusWidth = 10;

const labels = ['Provider', 'Score', 'Total (ms)', 'Seq ins', 'LIKE', 'Reads qps', 'DB MB', 'Status'];
const widths = [nameWidth, scoreWidth, ...colWidths, statusWidth];

/** Print a comparison table of fs-io results for one mode to stdout. */
export function printResultsTable(mode: FsIoMode, results: FsIoBenchmarkResult[]): void {
  const header = labels.map((label, i) => pad(label, widths[i])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');

  console.log('\n' + '='.repeat(separator.length));
  console.log(`  FS I/O BENCHMARK RESULTS — ${mode.toUpperCase()}`);
  console.log('='.repeat(separator.length));
  console.log(header);
  console.log(separator);

  const sorted = sortByCompositeScore(results);

  for (const result of sorted) {
    if (result.skipped) {
      console.log(
        [
          pad(result.provider, nameWidth),
          pad('--', scoreWidth),
          pad('--', colWidths[0]),
          pad('--', colWidths[1]),
          pad('--', colWidths[2]),
          pad('--', colWidths[3]),
          pad('--', colWidths[4]),
          pad('SKIPPED', statusWidth),
        ].join(' | '),
      );
      continue;
    }

    const ok = result.iterations.filter((i) => i.ok === true).length;
    const total = result.iterations.length;
    const score = result.compositeScore !== undefined ? result.compositeScore.toFixed(1) : '--';
    const meta = getMeta(result);
    const verified = ok > 0 && meta.verified === true;

    console.log(
      [
        pad(result.provider, nameWidth),
        pad(score, scoreWidth),
        pad(formatMs(result.summary?.median), colWidths[0]),
        pad(formatMs(meta.sequentialInsertsMs), colWidths[1]),
        pad(formatMs(meta.likeQueriesMs), colWidths[2]),
        pad(formatNum(meta.concurrentReadsQps), colWidths[3]),
        pad(formatNum(meta.dbSizeMb), colWidths[4]),
        pad(`${ok}/${total} ${verified ? 'OK' : 'FAIL'}`, statusWidth),
      ].join(' | '),
    );
  }

  console.log('='.repeat(separator.length));
  console.log('  Composite score is suite totalMs vs the 8s ceiling × success rate.\n');
}

function getMeta(result: FsIoBenchmarkResult): Record<string, unknown> {
  return (result.summary?.meta ?? result.meta ?? lastSuccessfulMeta(result.iterations) ?? {}) as Record<string, unknown>;
}

function lastSuccessfulMeta(iterations: FsIoWorkloadResult[]): Record<string, unknown> | undefined {
  for (let i = iterations.length - 1; i >= 0; i--) {
    if (iterations[i].ok && iterations[i].meta) return iterations[i].meta;
  }
  return undefined;
}

function sortByCompositeScore(results: FsIoBenchmarkResult[]): FsIoBenchmarkResult[] {
  return [...results].sort((a, b) => {
    const aBottom = a.skipped || (a.compositeScore ?? 0) <= 0;
    const bBottom = b.skipped || (b.compositeScore ?? 0) <= 0;

    if (aBottom && !bBottom) return 1;
    if (!aBottom && bBottom) return -1;

    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function formatMs(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return value >= 1000 ? (value / 1000).toFixed(2) + 's' : value.toFixed(0);
}

function formatNum(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return value.toFixed(1);
}
