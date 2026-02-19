import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BenchmarkResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const README_PATH = path.join(ROOT, 'README.md');

const START_MARKER = '<!-- BENCHMARK-RESULTS-START -->';
const END_MARKER = '<!-- BENCHMARK-RESULTS-END -->';

interface ResultFile {
  timestamp: string;
  results: BenchmarkResult[];
}

function getMostRecentFile(isDirect: boolean): ResultFile | null {
  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f => isDirect ? f.startsWith('direct-') : !f.startsWith('direct-'))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  const raw = fs.readFileSync(path.join(RESULTS_DIR, files[0]), 'utf-8');
  return JSON.parse(raw);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildTable(results: BenchmarkResult[]): string {
  const sorted = [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    return a.summary.ttiMs.median - b.summary.ttiMs.median;
  });

  const lines: string[] = [];
  lines.push('<table width="100%">');
  lines.push('<thead>');
  lines.push('<tr>');
  lines.push('<th align="left">Provider</th>');
  lines.push('<th align="center">Median TTI</th>');
  lines.push('<th align="center">Min</th>');
  lines.push('<th align="center">Max</th>');
  lines.push('<th align="center">Status</th>');
  lines.push('</tr>');
  lines.push('</thead>');
  lines.push('<tbody>');

  for (const r of sorted) {
    if (r.skipped) {
      lines.push(`<tr><td>${capitalize(r.provider)}</td><td align="center">--</td><td align="center">--</td><td align="center">--</td><td align="center">Skipped</td></tr>`);
    } else {
      const ok = r.iterations.filter(i => !i.error).length;
      const total = r.iterations.length;
      lines.push(
        `<tr><td>${capitalize(r.provider)}</td><td align="center"><b>${formatSeconds(r.summary.ttiMs.median)}</b></td><td align="center">${formatSeconds(r.summary.ttiMs.min)}</td><td align="center">${formatSeconds(r.summary.ttiMs.max)}</td><td align="center">${ok}/${total}</td></tr>`
      );
    }
  }
  
  lines.push('</tbody>');
  lines.push('</table>');
  return lines.join('\n');
}

function main() {
  const magic = getMostRecentFile(false);
  const direct = getMostRecentFile(true);

  const sections: string[] = [''];

  // TODO: Re-enable magic mode results once orchestrator benchmarks are stable
  // if (magic) {
  //   sections.push(`### Magic Mode (via ComputeSDK Gateway)`);
  //   sections.push(`> Last run: ${magic.timestamp}`);
  //   sections.push('');
  //   sections.push(buildTable(magic.results));
  //   sections.push('');
  // }

  if (direct) {
    sections.push(`> Last run: ${direct.timestamp}`);
    sections.push('');
    sections.push(buildTable(direct.results));
    sections.push('');
  }

  if (!magic && !direct) {
    sections.push('*No benchmark results available yet.*');
    sections.push('');
  }

  const readme = fs.readFileSync(README_PATH, 'utf-8');
  const startIdx = readme.indexOf(START_MARKER);
  const endIdx = readme.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error('README.md missing benchmark markers.');
    console.error(`Add ${START_MARKER} and ${END_MARKER} to README.md`);
    process.exit(1);
  }

  const before = readme.substring(0, startIdx + START_MARKER.length);
  const after = readme.substring(endIdx);
  const updated = before + '\n' + sections.join('\n') + after;

  fs.writeFileSync(README_PATH, updated);
  console.log('README.md updated with benchmark results.');
}

main();
