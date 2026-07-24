import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ACTIONS_PER_SESSION, type ThroughputBenchmarkResult } from './throughput-types.js';
import {
  computeThroughputCompositeScores,
  sortThroughputByCompositeScore,
} from './throughput-scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'results', 'browser-throughput');

const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

interface ResultFile {
  timestamp: string;
  results: ThroughputBenchmarkResult[];
}

function formatProviderName(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function generateSVG(results: ThroughputBenchmarkResult[], timestamp: string): string {
  if (!results.every(r => r.compositeScore !== undefined)) {
    computeThroughputCompositeScores(results);
  }

  const sorted = sortThroughputByCompositeScore(results).filter(r => !r.skipped);

  const rowHeight = 44;
  const headerHeight = 110;
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 1280;
  const tableTop = headerHeight + padding;
  const tableBottom = tableTop + tableHeaderHeight + (sorted.length * rowHeight);
  const footnoteHeight = 20;

  const height = tableBottom + padding + 30 + footnoteHeight;

  const cols = {
    rank: 40,
    provider: 80,
    score: 240,
    aps: 360,
    task: 500,
    taskP95: 640,
    screenshot: 780,
    create: 920,
    total: 1040,
    status: 1180,
  };

  const title = 'Browser Step Throughput Benchmarks';
  const subtitle = `${ACTIONS_PER_SESSION}-action Wikipedia loop per session — agent-style sequential actions`;

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
    .total { font-weight: 700; font-size: 15px; }
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
  <text class="table-header" x="${cols.aps}" y="${tableTop + 28}">APS (med)</text>
  <text class="table-header" x="${cols.task}" y="${tableTop + 28}">Task (med)</text>
  <text class="table-header" x="${cols.taskP95}" y="${tableTop + 28}">Task (p95)</text>
  <text class="table-header" x="${cols.screenshot}" y="${tableTop + 28}">Screenshot</text>
  <text class="table-header" x="${cols.create}" y="${tableTop + 28}">Create</text>
  <text class="table-header" x="${cols.total}" y="${tableTop + 28}">Total</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Status</text>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const rank = i + 1;
    const aps = r.summary.actionsPerSecond.median;
    const taskMed = r.summary.taskMs.median;
    const taskP95 = r.summary.taskMs.p95;
    const totalMs = r.summary.totalMs.median;
    const screenshotMed = r.summary.perActionType.screenshot?.median ?? 0;
    const createMed = r.summary.createMs.median;

    const fullSuccess = r.iterations.filter(it => !it.error && it.actionsCompleted === ACTIONS_PER_SESSION).length;
    const total = r.iterations.length;
    const allFailed = fullSuccess === 0;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';

    let speedClass = allFailed ? 'slow' : 'fast';
    if (!allFailed && aps < 2.0) speedClass = 'slow';
    else if (!allFailed && aps < 3.5) speedClass = 'medium';

    let rankClass = 'rank';
    if (rank === 1) rankClass = 'rank rank-1';
    else if (rank === 2) rankClass = 'rank rank-2';
    else if (rank === 3) rankClass = 'rank rank-3';

    const apsDisplay = allFailed ? '--' : `${aps.toFixed(2)}/s`;
    const taskDisplay = allFailed ? '--' : formatSeconds(taskMed);
    const taskP95Display = allFailed ? '--' : formatSeconds(taskP95);
    const screenshotDisplay = allFailed ? '--' : formatMs(screenshotMed);
    const createDisplay = allFailed ? '--' : formatSeconds(createMed);
    const totalDisplay = allFailed ? '--' : formatSeconds(totalMs);

    svg += `
  <!-- Row ${rank} -->
  <text class="${rankClass}" x="${cols.rank}" y="${y}">${rank}</text>
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(r.provider)}</text>
  <text class="row total" x="${cols.score}" y="${y}">${score}</text>
  <text class="row total ${speedClass}" x="${cols.aps}" y="${y}">${apsDisplay}</text>
  <text class="row" x="${cols.task}" y="${y}">${taskDisplay}</text>
  <text class="row" x="${cols.taskP95}" y="${y}">${taskP95Display}</text>
  <text class="row" x="${cols.screenshot}" y="${y}">${screenshotDisplay}</text>
  <text class="row" x="${cols.create}" y="${y}">${createDisplay}</text>
  <text class="row" x="${cols.total}" y="${y}">${totalDisplay}</text>
  <text class="row status" x="${cols.status}" y="${y}">${fullSuccess}/${total}</text>
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
  <text class="timestamp" x="${padding}" y="${height - 14}">Each session runs ${ACTIONS_PER_SESSION} sequential actions (navigate, wait, screenshot, textContent, click, goBack) on Wikipedia. Higher APS is better.</text>

</svg>`;

  return svg;
}

function main() {
  const latestPath = path.join(RESULTS_DIR, 'latest.json');

  if (!fs.existsSync(latestPath)) {
    console.error(`No throughput benchmark results found at ${latestPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(latestPath, 'utf-8');
  const data: ResultFile = JSON.parse(raw);

  const svg = generateSVG(data.results, data.timestamp);
  const svgPath = path.join(ROOT, 'browser-throughput.svg');
  fs.writeFileSync(svgPath, svg);
  console.log(`SVG written to ${svgPath}`);
}

main();
