/**
 * Render cpu-node SVG bar chart from results/cpu_node/latest.json.
 * Pure SVG (no external libs); renders identically on GitHub.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITE_CONFIG, type SerializedCpuNodeBenchmarkResult } from './cpu-node.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const OUT_DIR = ROOT;

function readLatest(): SerializedCpuNodeBenchmarkResult[] | null {
  const dir = path.join(RESULTS_DIR, 'cpu_node');
  const f = path.join(dir, 'latest.json');
  if (!fs.existsSync(f)) return null;
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Array.isArray(data?.results)) return data.results;
  return null;
}

function color(score: number): string {
  if (score >= 90) return '#16a34a';
  if (score >= 75) return '#22c55e';
  if (score >= 50) return '#eab308';
  if (score > 0) return '#f97316';
  return '#9ca3af';
}

function escapeXml(s: string): string {
  return s.replace(/[&<>'"]/g, function (c) {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;',
    };
    return map[c] || c;
  });
}

function generateSvg(): string {
  const suite = SUITE_CONFIG;
  const results = (readLatest() ?? []).filter(function (r) { return !r.skipped; });
  const visible = results.slice().sort(function (a, b) { return b.compositeScore - a.compositeScore; });

  const W = 760;
  const ROW = 30;
  const HEADER_H = 64;
  const FOOTER_H = 32;
  const H = HEADER_H + Math.max(1, visible.length) * ROW + FOOTER_H;

  const parts: string[] = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" font-family="system-ui,sans-serif">');
  parts.push('<rect width="100%" height="100%" fill="#f8fafc"/>');
  parts.push('<text x="20" y="28" font-size="16" font-weight="600" fill="#0f172a">' + escapeXml(suite.label) + '</text>');
  parts.push('<text x="20" y="48" font-size="12" fill="#475569">unit: ' + suite.unit + '  ceiling: ' + suite.ceiling + '  method: median, 2-sigma trim</text>');

  if (visible.length === 0) {
    parts.push('<text x="20" y="' + (HEADER_H + 24) + '" font-size="13" fill="#475569">no results yet</text>');
    parts.push('</svg>');
    return parts.join('\n');
  }

  const labelX = 20;
  const barX = 220;
  const barW = 440;
  for (let i = 0; i < visible.length; i++) {
    const y = HEADER_H + 8 + i * ROW;
    const r = visible[i];
    const w = Math.max(2, (r.compositeScore / 100) * barW);
    const sublabel = 'n=' + r.n + ' ' + suite.unit + ' ceiling=' + suite.ceiling;
    parts.push('<text x="' + labelX + '" y="' + (y + 4) + '" font-size="13" fill="#1e293b">' + escapeXml(r.provider) + '</text>');
    parts.push('<rect x="' + barX + '" y="' + (y - 10) + '" width="' + barW + '" height="14" fill="#e2e8f0"/>');
    parts.push('<rect x="' + barX + '" y="' + (y - 10) + '" width="' + w + '" height="14" fill="' + color(r.compositeScore) + '"/>');
    parts.push('<text x="' + (barX + barW + 8) + '" y="' + (y + 4) + '" font-size="13" fill="#0f172a">' + r.compositeScore.toFixed(1) + '</text>');
    parts.push('<text x="' + labelX + '" y="' + (y + 18) + '" font-size="11" fill="#64748b">' + escapeXml(sublabel) + '</text>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function main(): void {
  const svg = generateSvg();
  const name = 'cpu_node.svg';
  const target = path.join(OUT_DIR, name);
  fs.writeFileSync(target, svg);
  console.log('Wrote ' + name + ' (' + svg.length + ' bytes)');
}

if (process.argv[1] && process.argv[1].endsWith('generate-cpu-node-svg.ts')) {
  main();
}
