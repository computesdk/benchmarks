import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SnapshotForkBenchmarkResult, DatasetPreset } from './snapshot-fork-types.js';
import { computeSnapshotForkCompositeScores } from './snapshot-fork-benchmark.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'results', 'snapshot-fork');

// Datasets to render, in display order. Matches DATASET_PRESETS in
// snapshot-fork-types.ts; only those with a latest.json on disk are emitted.
const DATASETS: DatasetPreset[] = ['small', 'wide', 'deep'];

// ComputeSDK logo
const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

interface ResultFile {
  timestamp: string;
  results: SnapshotForkBenchmarkResult[];
}

// Parse CLI args
const args = process.argv.slice(2);
function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function formatProviderName(s: string): string {
  if (s === 'aws-s3') return 'AWS S3';
  if (s === 'cloudflare-r2') return 'Cloudflare R2';
  if (s === 'vercel-blob') return 'Vercel Blob';
  if (s === 'gcs') return 'Google Cloud Storage';
  if (s === 'azure-blob') return 'Azure Blob Storage';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

function generateSVG(results: SnapshotForkBenchmarkResult[], timestamp: string, datasetLabel: string): string {
  // Compute scores if any are missing
  if (!results.every(r => r.compositeScore !== undefined)) {
    computeSnapshotForkCompositeScores(results);
  }

  const sorted = results
    .filter(r => !r.skipped)
    .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));

  const rowHeight = 44;
  const headerHeight = 110;
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 1200;
  const tableTop = headerHeight + padding;
  const tableBottom = tableTop + tableHeaderHeight + (sorted.length * rowHeight);
  const footnoteHeight = 20;

  const height = tableBottom + padding + 30 + footnoteHeight;

  // Column positions
  const cols = {
    rank: 40,
    provider: 80,
    score: 280,
    snapshot: 400,
    forkSnapshot: 590,
    forkLive: 780,
    firstRead: 940,
    status: 1090,
  };

  const title = 'Object Storage Snapshot &amp; Fork Benchmarks';
  const subtitle = `Snapshot/fork provisioning - ${datasetLabel} dataset`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#f6f8fa;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#ffffff;stop-opacity:1" />
    </linearGradient>
  </defs>
  <style>
    .bg { fill: #ffffff; }
    .header-bg { fill: url(#headerGrad); }
    .table-header-bg { fill: #f6f8fa; }
    .table-header { font: 600 12px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; text-transform: uppercase; letter-spacing: 0.5px; }
    .row { font: 14px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #24292f; }
    .rank { font-weight: 700; fill: #57606a; }
    .rank-1 { fill: #d4a000; }
    .rank-2 { fill: #8a8a8a; }
    .rank-3 { fill: #a0522d; }
    .provider { font-weight: 600; fill: #0969da; }
    .metric { font-weight: 700; font-size: 15px; }
    .fast { fill: #1a7f37; }
    .medium { fill: #9a6700; }
    .slow { fill: #cf222e; }
    .status { fill: #57606a; }
    .divider { stroke: #d0d7de; stroke-width: 1; }
    .timestamp { font: 11px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; }
    .title { font: bold 28px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #24292f; }
    .subtitle { font: 14px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; }
  </style>

  <!-- Background -->
  <rect class="bg" width="${width}" height="${height}"/>

  <!-- Logo -->
  <g transform="translate(${padding}, 24)">
    <rect width="60" height="60" fill="#000000"/>
    <g transform="scale(0.035) translate(0, 0)">
      <path fill="#ffffff" d="${LOGO_C_PATH}"/>
    </g>
  </g>

  <!-- Title -->
  <text class="title" x="${padding + 76}" y="55">${title}</text>
  <text class="subtitle" x="${padding + 76}" y="78">${subtitle}</text>
  <!-- Table header background -->
  <rect class="table-header-bg" y="${tableTop}" width="${width}" height="${tableHeaderHeight}"/>

  <!-- Table header text -->
  <text class="table-header" x="${cols.rank}" y="${tableTop + 28}">#</text>
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.score}" y="${tableTop + 28}">Score</text>
  <text class="table-header" x="${cols.snapshot}" y="${tableTop + 28}">Snapshot</text>
  <text class="table-header" x="${cols.forkSnapshot}" y="${tableTop + 28}">Fork (Snapshot)</text>
  <text class="table-header" x="${cols.forkLive}" y="${tableTop + 28}">Fork (Live)</text>
  <text class="table-header" x="${cols.firstRead}" y="${tableTop + 28}">First Read</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Status</text>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const ok = r.iterations.filter(it => !it.error && it.verified).length;
    const total = r.iterations.length;
    const rank = i + 1;
    const snapshotMs = r.summary.snapshotCreateMs.median;
    const allFailed = ok === 0;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';

    // Color code based on snapshot-create speed
    let speedClass = allFailed ? 'slow' : 'fast';
    if (!allFailed && snapshotMs > 5000) speedClass = 'slow';
    else if (!allFailed && snapshotMs > 2000) speedClass = 'medium';

    // Rank styling
    let rankClass = 'rank';
    if (rank === 1) rankClass = 'rank rank-1';
    else if (rank === 2) rankClass = 'rank rank-2';
    else if (rank === 3) rankClass = 'rank rank-3';

    const snapshotDisplay = allFailed ? '--' : formatSeconds(snapshotMs);
    const forkSnapshotDisplay = allFailed ? '--' : formatSeconds(r.summary.forkFromSnapshotMs.median);
    const forkLiveDisplay = allFailed ? '--' : formatSeconds(r.summary.forkFromLiveMs.median);
    const firstReadDisplay = allFailed ? '--' : formatSeconds(r.summary.forkFirstReadMs.median);

    svg += `
  <!-- Row ${rank} -->
  <text class="${rankClass}" x="${cols.rank}" y="${y}">${rank}</text>
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(r.provider)}</text>
  <text class="row metric" x="${cols.score}" y="${y}">${score}</text>
  <text class="row metric ${speedClass}" x="${cols.snapshot}" y="${y}">${snapshotDisplay}</text>
  <text class="row" x="${cols.forkSnapshot}" y="${y}">${forkSnapshotDisplay}</text>
  <text class="row" x="${cols.forkLive}" y="${y}">${forkLiveDisplay}</text>
  <text class="row" x="${cols.firstRead}" y="${y}">${firstReadDisplay}</text>
  <text class="row status" x="${cols.status}" y="${y}">${ok}/${total}</text>
`;

    if (i < sorted.length - 1) {
      const lineY = tableTop + tableHeaderHeight + ((i + 1) * rowHeight);
      svg += `  <line class="divider" x1="${padding}" y1="${lineY}" x2="${width - padding}" y2="${lineY}"/>
`;
    }
  });

  const date = new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  svg += `
  <!-- Timestamp -->
  <text class="timestamp" x="${width - padding}" y="${height - 28}" text-anchor="end">Last updated: ${date}</text>

  <!-- Footnote -->
  <text class="timestamp" x="${padding}" y="${height - 14}">Measures snapshot creation and fork provisioning (from snapshot and from live). Lower time is better.</text>

</svg>`;

  return svg;
}

function generateForDataset(datasetLabel: string): boolean {
  const datasetDir = path.join(RESULTS_DIR, datasetLabel.toLowerCase());
  const latestPath = path.join(datasetDir, 'latest.json');

  if (!fs.existsSync(latestPath)) {
    console.log(`No results found for dataset: ${datasetLabel}`);
    return false;
  }

  const raw = fs.readFileSync(latestPath, 'utf-8');
  const data: ResultFile = JSON.parse(raw);

  const svg = generateSVG(data.results, data.timestamp, datasetLabel);
  const svgPath = path.join(ROOT, `snapshot_fork_${datasetLabel.toLowerCase()}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`SVG written to ${svgPath}`);

  return true;
}

function main() {
  const requestedDataset = getArgValue(args, '--dataset');

  if (requestedDataset) {
    // Generate SVG for a specific dataset
    if (!generateForDataset(requestedDataset)) {
      process.exit(1);
    }
  } else {
    // Generate SVGs for all available datasets
    let generated = 0;
    for (const dataset of DATASETS) {
      if (generateForDataset(dataset)) {
        generated++;
      }
    }
    if (generated === 0) {
      console.error('No snapshot/fork benchmark results found for any dataset');
      process.exit(1);
    }
  }
}

main();
