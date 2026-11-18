import type { CpuBurstBenchmarkResult, CpuBurstWorkloadResult } from './sandbox-cpu-burst.js';

const nameWidth = 14;
const scoreWidth = 8;
const colWidths = [6, 12, 9, 10, 10];
const statusWidth = 10;

const labels = ['Provider', 'Score', 'Burst?', 'Headroom (x)', 'Eff cores', 'Prov cores', 'Status'];
const widths = [nameWidth, scoreWidth, ...colWidths, statusWidth];

/**
 * Print a comparison table of CPU burst benchmark results to stdout.
 */
export function printResultsTable(results: CpuBurstBenchmarkResult[]): void {
  const header = labels.map((label, i) => pad(label, widths[i])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');

  console.log('\n' + '='.repeat(separator.length));
  console.log('  CPU BURST BENCHMARK RESULTS');
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
          pad('SKIPPED', statusWidth),
        ].join(' | '),
      );
      continue;
    }

    const ok = result.iterations.filter((i) => i.ok === true).length;
    const total = result.iterations.length;
    const score = result.compositeScore !== undefined ? result.compositeScore.toFixed(1) : '--';
    const meta = getMeta(result);

    const allFailed = ok === 0;

    console.log(
      [
        pad(result.provider, nameWidth),
        pad(score, scoreWidth),
        pad(meta.burstDetected === true ? 'YES' : allFailed ? '--' : 'no', colWidths[0]),
        pad(meta.burstDetected === true ? formatHeadroom(meta.burstHeadroom) : '--', colWidths[1]),
        pad(formatCores(meta.effectiveCores), colWidths[2]),
        pad(formatCores(meta.provisionedCpu), colWidths[3]),
        pad(`${ok}/${total} OK`, statusWidth),
      ].join(' | '),
    );
  }

  console.log('='.repeat(separator.length));
  console.log('  Composite score is based on burst headroom × success rate.\n');
}

function getMeta(result: CpuBurstBenchmarkResult) {
  return result.summary?.meta ?? result.meta ?? lastSuccessfulMeta(result.iterations) ?? {};
}

function lastSuccessfulMeta(iterations: CpuBurstWorkloadResult[]): any {
  for (let i = iterations.length - 1; i >= 0; i--) {
    if (iterations[i].ok && iterations[i].meta) return iterations[i].meta;
  }
  return undefined;
}

function sortByCompositeScore(results: CpuBurstBenchmarkResult[]): CpuBurstBenchmarkResult[] {
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

function formatHeadroom(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${value.toFixed(2)}x`;
}

function formatCores(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return value.toFixed(1);
}
