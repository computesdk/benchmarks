import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BenchmarkResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const SVG_PATH = path.join(ROOT, 'results.svg');

// ComputeSDK logo - the "C" path
const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

interface ResultFile {
  timestamp: string;
  results: BenchmarkResult[];
}

function getMostRecentFile(): ResultFile | null {
  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith('.json') && f.startsWith('direct-'))
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
  if (s.toLowerCase() === 'e2b') return 'E2B';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function generateSVG(results: BenchmarkResult[], timestamp: string): string {
  const sorted = [...results]
    .filter(r => !r.skipped)
    .sort((a, b) => a.summary.ttiMs.median - b.summary.ttiMs.median);

  const rowHeight = 44;
  const headerHeight = 140; // Space for logo and title
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 800;
  const tableTop = headerHeight;
  const height = tableTop + tableHeaderHeight + (sorted.length * rowHeight) + padding + 40;

  // Column positions
  const cols = {
    rank: 40,
    provider: 90,
    median: 320,
    min: 480,
    max: 600,
    status: 720,
  };

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
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
    .table-header { font: 600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #57606a; text-transform: uppercase; letter-spacing: 0.5px; }
    .row { font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #24292f; }
    .rank { font-weight: 700; fill: #57606a; }
    .rank-1 { fill: #d4a000; }
    .rank-2 { fill: #8a8a8a; }
    .rank-3 { fill: #a0522d; }
    .provider { font-weight: 600; fill: #0969da; }
    .median { font-weight: 700; font-size: 15px; }
    .fast { fill: #1a7f37; }
    .medium { fill: #9a6700; }
    .slow { fill: #cf222e; }
    .status { fill: #57606a; }
    .divider { stroke: #d0d7de; stroke-width: 1; }
    .border { stroke: #d0d7de; stroke-width: 1; fill: none; }
    .timestamp { font: 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #57606a; }
    .title { font: bold 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #24292f; }
    .subtitle { font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #57606a; }
    .logo { fill: #24292f; }
  </style>
  
  <!-- Background -->
  <rect class="bg" width="${width}" height="${height}" rx="8"/>
  <rect class="border" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8"/>
  
  <!-- Header section -->
  <rect class="header-bg" width="${width}" height="${headerHeight}" rx="8"/>
  <rect class="bg" y="${headerHeight - 8}" width="${width}" height="8"/>
  
  <!-- Logo (black square with white C) -->
  <g transform="translate(${padding}, 24)">
    <rect width="60" height="60" fill="#000000"/>
    <g transform="scale(0.035) translate(0, 0)">
      <path fill="#ffffff" d="${LOGO_C_PATH}"/>
    </g>
  </g>
  
  <!-- Title -->
  <text class="title" x="110" y="68">Benchmarks</text>
  <text class="subtitle" x="110" y="95">Independent performance benchmarks for cloud sandbox providers</text>
  
  <!-- Table header background -->
  <rect class="table-header-bg" y="${tableTop}" width="${width}" height="${tableHeaderHeight}"/>
  
  <!-- Table header text -->
  <text class="table-header" x="${cols.rank}" y="${tableTop + 28}">#</text>
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.median}" y="${tableTop + 28}">Median TTI</text>
  <text class="table-header" x="${cols.min}" y="${tableTop + 28}">Min</text>
  <text class="table-header" x="${cols.max}" y="${tableTop + 28}">Max</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Status</text>
  
  <!-- Divider -->
  <line class="divider" x1="0" y1="${tableTop + tableHeaderHeight}" x2="${width}" y2="${tableTop + tableHeaderHeight}"/>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const ok = r.iterations.filter(it => !it.error).length;
    const total = r.iterations.length;
    const rank = i + 1;
    const medianMs = r.summary.ttiMs.median;
    
    // Color code based on speed
    let speedClass = 'fast';
    if (medianMs > 2000) speedClass = 'slow';
    else if (medianMs > 1000) speedClass = 'medium';
    
    // Rank styling
    let rankClass = 'rank';
    if (rank === 1) rankClass = 'rank rank-1';
    else if (rank === 2) rankClass = 'rank rank-2';
    else if (rank === 3) rankClass = 'rank rank-3';
    
    svg += `
  <!-- Row ${rank} -->
  <text class="${rankClass}" x="${cols.rank}" y="${y}">${rank}</text>
  <text class="row provider" x="${cols.provider}" y="${y}">${capitalize(r.provider)}</text>
  <text class="row median ${speedClass}" x="${cols.median}" y="${y}">${formatSeconds(medianMs)}</text>
  <text class="row" x="${cols.min}" y="${y}">${formatSeconds(r.summary.ttiMs.min)}</text>
  <text class="row" x="${cols.max}" y="${y}">${formatSeconds(r.summary.ttiMs.max)}</text>
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
  <text class="timestamp" x="${padding}" y="${height - 14}">Last updated: ${date}</text>
  
</svg>`;

  return svg;
}

function main() {
  const data = getMostRecentFile();
  
  if (!data) {
    console.error('No benchmark results found');
    process.exit(1);
  }

  const svg = generateSVG(data.results, data.timestamp);
  fs.writeFileSync(SVG_PATH, svg);
  console.log(`SVG written to ${SVG_PATH}`);
}

main();
