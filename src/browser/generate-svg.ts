import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserBenchmarkResult } from './types.js';
import { sortBrowserByCompositeScore, computeBrowserCompositeScores } from './scoring.js';
import { LOGO_C_PATH, loadSponsorImages } from '../util/svg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'results', 'browser');

interface ResultFile {
  timestamp: string;
  results: BrowserBenchmarkResult[];
}

function formatProviderName(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

const sponsorImages = loadSponsorImages(
  path.join(ROOT, 'sponsors', 'tier-1'),
  path.join(ROOT, 'sponsors', 'tier-2'),
);

function generateSVG(results: BrowserBenchmarkResult[], timestamp: string): string {
  if (!results.every(r => r.compositeScore !== undefined)) {
    computeBrowserCompositeScores(results);
  }

  const sorted = sortBrowserByCompositeScore(results).filter(r => !r.skipped);

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
    create: 340,
    connect: 480,
    navigate: 620,
    release: 760,
    total: 900,
    status: 1060,
  };

  const title = 'Browser Session Benchmarks';
  const subtitle = 'Session creation, connection, navigation, and release latency';

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
${sponsorImages.length > 0 ? (() => {
  const logoW = 100;
  const logoH = 32;
  const logoGap = 12;
  const totalLogosW = sponsorImages.length * logoW + (sponsorImages.length - 1) * logoGap;
  const logosStartX = width - padding - totalLogosW;
  return `
  <!-- Sponsors -->
  <text font-size="11" font-family="Inter, SF Pro Display, sans-serif" fill="#8c959f" x="${logosStartX + totalLogosW / 2}" y="36" text-anchor="middle" letter-spacing="1">SPONSORED BY</text>
  ${sponsorImages.map((img, i) => `<image href="${img.dataUri}" x="${logosStartX + i * (logoW + logoGap)}" y="46" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>`).join('\n  ')}`;
})()
 : ''}
  <!-- Table header background -->
  <rect class="table-header-bg" y="${tableTop}" width="${width}" height="${tableHeaderHeight}"/>

  <!-- Table header text -->
  <text class="table-header" x="${cols.rank}" y="${tableTop + 28}">#</text>
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.score}" y="${tableTop + 28}">Score</text>
  <text class="table-header" x="${cols.create}" y="${tableTop + 28}">Create</text>
  <text class="table-header" x="${cols.connect}" y="${tableTop + 28}">Connect</text>
  <text class="table-header" x="${cols.navigate}" y="${tableTop + 28}">Navigate</text>
  <text class="table-header" x="${cols.release}" y="${tableTop + 28}">Release</text>
  <text class="table-header" x="${cols.total}" y="${tableTop + 28}">Total</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Status</text>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const ok = r.iterations.filter(it => !it.error).length;
    const total = r.iterations.length;
    const rank = i + 1;
    const totalMs = r.summary.totalMs.median;
    const allFailed = ok === 0;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';

    let speedClass = allFailed ? 'slow' : 'fast';
    if (!allFailed && totalMs > 7000) speedClass = 'slow';
    else if (!allFailed && totalMs > 3500) speedClass = 'medium';

    let rankClass = 'rank';
    if (rank === 1) rankClass = 'rank rank-1';
    else if (rank === 2) rankClass = 'rank rank-2';
    else if (rank === 3) rankClass = 'rank rank-3';

    const createDisplay = allFailed ? '--' : formatSeconds(r.summary.createMs.median);
    const connectDisplay = allFailed ? '--' : formatSeconds(r.summary.connectMs.median);
    const navigateDisplay = allFailed ? '--' : formatSeconds(r.summary.navigateMs.median);
    const releaseDisplay = allFailed ? '--' : formatSeconds(r.summary.releaseMs.median);
    const totalDisplay = allFailed ? '--' : formatSeconds(totalMs);

    svg += `
  <!-- Row ${rank} -->
  <text class="${rankClass}" x="${cols.rank}" y="${y}">${rank}</text>
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(r.provider)}</text>
  <text class="row total" x="${cols.score}" y="${y}">${score}</text>
  <text class="row" x="${cols.create}" y="${y}">${createDisplay}</text>
  <text class="row" x="${cols.connect}" y="${y}">${connectDisplay}</text>
  <text class="row" x="${cols.navigate}" y="${y}">${navigateDisplay}</text>
  <text class="row" x="${cols.release}" y="${y}">${releaseDisplay}</text>
  <text class="row total ${speedClass}" x="${cols.total}" y="${y}">${totalDisplay}</text>
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
  <text class="timestamp" x="${padding}" y="${height - 14}">Measures full session lifecycle: create, connect via CDP, navigate to example.com, release. Lower total time is better.</text>

</svg>`;

  return svg;
}

function main() {
  const latestPath = path.join(RESULTS_DIR, 'latest.json');

  if (!fs.existsSync(latestPath)) {
    console.error(`No browser benchmark results found at ${latestPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(latestPath, 'utf-8');
  const data: ResultFile = JSON.parse(raw);

  const svg = generateSVG(data.results, data.timestamp);
  const svgPath = path.join(ROOT, 'browser.svg');
  fs.writeFileSync(svgPath, svg);
  console.log(`SVG written to ${svgPath}`);
}

main();
