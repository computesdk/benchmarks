#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import type { DaxBenchmarkResult } from './dax.js';

const root = path.resolve(import.meta.dirname, '../..');
const inputPath = path.join(root, 'results', 'sandbox-dax', 'latest.json');
const outputPath = path.join(root, 'dax.svg');

interface DaxResultFile {
  timestamp: string;
  results: DaxBenchmarkResult[];
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as DaxResultFile;

const escape = (value: string | number): string => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const format = (ms: number | undefined): string => (ms && ms > 0 ? `${(ms / 1000).toFixed(2)}s` : '—');
const displayName = (name: string): string => name.toLowerCase() === 'e2b'
  ? 'E2B'
  : name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const results = data.results.filter((result) => !result.skipped).map((result) => {
  const successful = result.iterations.filter((iteration) =>
    !iteration.error && typeof iteration.totalMs === 'number' && iteration.totalMs > 0,
  );
  const phaseTotal = Math.max(7, ...result.iterations.map((iteration) => iteration.phasesTotal || 0));
  const phaseCompleted = result.iterations.length
    ? Math.max(...result.iterations.map((iteration) => iteration.phasesCompleted || 0))
    : 0;
  return {
    ...result,
    successful,
    phaseTotal,
    phaseCompleted,
    successPercent: result.iterations.length ? Math.round(successful.length / result.iterations.length * 100) : 0,
    median: result.summary?.totalMs?.median || 0,
  };
}).sort((a, b) => {
  if (a.phaseCompleted !== b.phaseCompleted) return b.phaseCompleted - a.phaseCompleted;
  if (Boolean(a.successful.length) !== Boolean(b.successful.length)) return b.successful.length - a.successful.length;
  return (a.median || Number.MAX_SAFE_INTEGER) - (b.median || Number.MAX_SAFE_INTEGER);
});

const width = 1200;
const padding = 24;
const headerHeight = 110;
const sectionGap = 28;
const tableHeaderHeight = 42;
const tableRowHeight = 42;
const tableTop = headerHeight + sectionGap + 34;
const height = tableTop + tableHeaderHeight + results.length * tableRowHeight + 52;
const timestamp = new Date(data.timestamp).toISOString().slice(0, 10);
const logoPath = 'M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z';
const cols = [
  { x: 40, label: 'PROVIDER' },
  { x: 220, label: 'PHASES' },
  { x: 300, label: 'SUCCESS' },
  { x: 390, label: 'TOTAL (MED)' },
  { x: 530, label: 'PREPARE' },
  { x: 640, label: 'BUN DL' },
  { x: 735, label: 'BUN UNPACK' },
  { x: 850, label: 'CLONE' },
  { x: 940, label: 'INSTALL' },
  { x: 1050, label: 'TYPECHECK' },
];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#f6f8fa;stop-opacity:1"/>
      <stop offset="100%" style="stop-color:#fff;stop-opacity:1"/>
    </linearGradient>
  </defs>
  <style>
    .bg { fill:#fff; }.table-header-bg { fill:#f6f8fa; }
    .title { font:bold 28px Inter,Arial,sans-serif;fill:#24292f; }
    .subtitle { font:14px Inter,Arial,sans-serif;fill:#57606a; }
    .section { font:600 18px Inter,Arial,sans-serif;fill:#24292f; }
    .small { font:11px Inter,Arial,sans-serif;fill:#57606a; }
    .table-head { font:600 12px Inter,Arial,sans-serif;fill:#57606a;letter-spacing:.5px; }
    .table-text { font:14px Inter,Arial,sans-serif;fill:#24292f; }
    .table-name { font-weight:600;fill:#0969da; }.good { fill:#1a7f37; }
    .warn { fill:#9a6700; }.bad { fill:#cf222e; }.line { stroke:#d0d7de;stroke-width:1; }
  </style>
  <rect class="bg" width="${width}" height="${height}"/>
  <g transform="translate(24,24)">
    <rect width="60" height="60" fill="#000"/>
    <g transform="scale(0.035)"><path fill="#fff" d="${logoPath}"/></g>
  </g>
  <text class="title" x="100" y="55">DAX Sandbox Benchmarks</text>
  <text class="subtitle" x="100" y="78">Build and typecheck workload performance across sandbox providers</text>
  <text class="section" x="${padding}" y="${tableTop - 36}">Detailed Metrics</text>
`;

const tableHeaderY = tableTop;
svg += `  <line class="line" x1="0" y1="${tableHeaderY - 22}" x2="${width}" y2="${tableHeaderY - 22}"/>
  <rect class="table-header-bg" x="0" y="${tableHeaderY}" width="${width}" height="${tableHeaderHeight}"/>
`;
for (const col of cols) svg += `  <text class="table-head" x="${col.x}" y="${tableHeaderY + 26}">${col.label}</text>\n`;

results.forEach((result, index) => {
  const y = tableHeaderY + tableHeaderHeight + index * tableRowHeight;
  const successful = result.successful.length;
  const total = result.iterations.length;
  const successClass = result.successPercent >= 100 ? 'good' : result.successPercent ? 'warn' : 'bad';
  const summary = result.summary || {};
  const values = [
    summary.totalMs?.median,
    summary.prepareMs?.median,
    summary.bunDownloadMs?.median,
    summary.bunUnpackMs?.median,
    summary.cloneMs?.median,
    summary.installMs?.median,
    summary.typecheckMs?.median,
  ];
  svg += `  <line class="line" x1="${padding}" y1="${y + tableRowHeight}" x2="${width - padding}" y2="${y + tableRowHeight}"/>
  <text class="table-text table-name" x="${cols[0].x}" y="${y + 27}">${escape(displayName(result.provider))}</text>
  <text class="table-text" x="${cols[1].x}" y="${y + 27}">${result.phaseCompleted}/${result.phaseTotal}</text>
  <text class="table-text ${successClass}" x="${cols[2].x}" y="${y + 27}">${result.successPercent}%</text>
  <text class="table-text ${successful ? '' : 'bad'}" x="${cols[3].x}" y="${y + 27}">${successful ? format(values[0]) : 'Failed'}</text>
`;
  values.slice(1).forEach((value, valueIndex) => {
    svg += `  <text class="table-text" x="${cols[valueIndex + 4].x}" y="${y + 27}">${successful ? format(value) : '—'}</text>\n`;
  });
});

svg += `  <text class="small" x="${padding}" y="${height - 18}">DAX phases: prepare, Bun download, Bun unpack, clone, install, and typecheck. Lower duration is better.</text>
</svg>\n`;

fs.writeFileSync(outputPath, svg);
console.log(`Wrote ${outputPath}`);
