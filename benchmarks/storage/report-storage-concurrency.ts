import fs from 'node:fs';
import path from 'node:path';
import {
  STORAGE_CONCURRENCY_RESULTS_PATH,
  type StorageConcurrencyResults,
} from './storage-concurrency-results.js';

const root = path.resolve('.');
const input = process.env.STORAGE_CONCURRENCY_RESULTS
  ? path.resolve(process.env.STORAGE_CONCURRENCY_RESULTS)
  : STORAGE_CONCURRENCY_RESULTS_PATH;
const data = JSON.parse(fs.readFileSync(input, 'utf8')) as StorageConcurrencyResults;

function providerName(provider: string): string {
  return {
    'aws-s3': 'AWS S3',
    'cloudflare-r2': 'Cloudflare R2',
    'vercel-blob': 'Vercel Blob',
    'azure-blob': 'Azure Blob',
  }[provider] ?? provider;
}

function number(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  }[character]!));
}

const rows = data.results.flatMap((provider) =>
  provider.cells.map((cell) => ({
    provider: providerName(provider.provider),
    ...cell,
  })),
);

const summaries = [...data.results]
  .sort((a, b) => b.compositeScore - a.compositeScore)
  .map((provider) => ({
    ...provider,
    displayName: providerName(provider.provider),
    peakThroughput: Math.max(...provider.cells.map((cell) => cell.throughputOpsPerSecond), 0),
  }));

const markdown = [
  '# Storage Concurrency Results',
  '',
  `Run: \`${data.runId}\`  `,
  `Generated: ${data.timestamp}`,
  '',
  '## Provider ranking',
  '',
  ...(summaries.length > 0
    ? [`Top provider: **${summaries[0].displayName}** (${summaries[0].compositeScore.toFixed(2)}/100)`, '']
    : ['No provider results were available.', '']),
  '| Rank | Provider | Composite score | Success rate | Valid cells | Peak throughput (ops/s) |',
  '|---:|---|---:|---:|---:|---:|',
  ...summaries.map((provider, index) =>
    `| ${index + 1} | ${provider.displayName} | ${provider.compositeScore.toFixed(2)} | ${(provider.successRate * 100).toFixed(1)}% | ${(provider.validCellRate * 100).toFixed(1)}% | ${provider.peakThroughput.toFixed(1)} |`,
  ),
  '',
  'Scores combine throughput (45%), p50 latency (20%), p95 latency (20%), and p99 latency (15%) per cell, then apply success-rate penalties.',
  '',
  '## Cell details',
  '',
  '| Provider | Cell | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | Success | Valid |',
  '|---|---|---:|---:|---:|---:|---:|:---:|',
  ...rows.map((row) =>
    `| ${row.provider} | ${row.phase} | ${row.throughputOpsPerSecond.toFixed(1)} | ${number(row.p50Ms)} | ${number(row.p95Ms)} | ${number(row.p99Ms)} | ${(row.successRate * 100).toFixed(1)}% | ${row.valid ? 'yes' : 'NO'} |`,
  ),
  '',
  'This is a closed-loop benchmark. Throughput is the output observed at the requested client concurrency.',
].join('\n');

fs.writeFileSync(path.join(root, 'storage-concurrency.md'), `${markdown}\n`);

const width = 1200;
const rowHeight = 28;
const headerHeight = 70;
const chartHeight = Math.max(180, summaries.length * rowHeight + 90);
const barWidth = 700;
const chartRows = summaries.map((row, index) => {
  const y = headerHeight + index * rowHeight;
  const widthValue = Math.max(1, (row.compositeScore / 100) * barWidth);
  return `
  <text x="12" y="${y + 18}" class="label">${escapeXml(row.displayName)}</text>
  <rect x="390" y="${y + 4}" width="${widthValue.toFixed(1)}" height="18" class="${row.validCellRate === 1 ? 'bar' : 'invalid'}"/>
  <text x="${Math.min(1100, 400 + widthValue + 8)}" y="${y + 18}" class="value">${row.compositeScore.toFixed(2)}</text>`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${chartHeight}" viewBox="0 0 ${width} ${chartHeight}">
<style>
.title { font: 700 24px sans-serif; fill: #24292f; }
.subtitle { font: 13px sans-serif; fill: #57606a; }
.label { font: 12px sans-serif; fill: #24292f; }
.value { font: 12px sans-serif; fill: #57606a; }
.bar { fill: #0969da; }
.invalid { fill: #cf222e; }
</style>
<rect width="100%" height="100%" fill="white"/>
<text x="12" y="30" class="title">Storage Concurrency Composite Score</text>
<text x="12" y="50" class="subtitle">Run ${escapeXml(data.runId)} · higher is better</text>
${chartRows}
</svg>`;

fs.writeFileSync(path.join(root, 'storage-concurrency.svg'), svg);
console.log('Wrote storage-concurrency.md and storage-concurrency.svg');
