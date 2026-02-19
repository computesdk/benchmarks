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

// E2B logo paths
const E2B_LOGO = `
<path d="M545.35 202V30H608.499C627.501 30 642.162 34.0952 652.482 42.2857C662.802 50.3124 667.962 61.3695 667.962 75.4571C667.962 85.7771 665.259 94.0495 659.853 100.274C654.611 106.335 647.485 110.594 638.476 113.051C645.356 114.198 651.499 116.328 656.905 119.44C662.31 122.552 666.569 126.893 669.682 132.463C672.958 137.869 674.596 144.667 674.596 152.857C674.596 168.091 669.108 180.131 658.133 188.977C647.322 197.659 631.514 202 610.71 202H545.35ZM573.607 178.166H610.956C622.259 178.166 630.859 175.954 636.756 171.531C642.653 166.945 645.602 160.638 645.602 152.611C645.602 144.257 642.571 137.787 636.51 133.2C630.449 128.613 621.931 126.32 610.956 126.32H573.607V178.166ZM573.607 102.977H609.236C619.064 102.977 626.6 100.766 631.842 96.3429C637.084 91.92 639.705 85.8591 639.705 78.16C639.705 70.461 637.084 64.4819 631.842 60.2229C626.6 55.8 619.064 53.5886 609.236 53.5886H573.607V102.977Z" fill="black"/>
<path d="M405.588 202V179.851L472.534 122.86C477.843 118.381 482.571 113.984 486.719 109.67C490.867 105.357 494.102 100.877 496.425 96.2316C498.748 91.4202 499.909 86.277 499.909 80.8019C499.909 70.8472 496.84 63.2153 490.701 57.9061C484.728 52.597 476.764 49.9424 466.81 49.9424C456.855 49.9424 448.808 53.0947 442.67 59.3993C436.531 65.704 433.461 74.2484 433.461 85.0326V88.019H405.837V83.5394C405.837 72.4234 408.326 62.6346 413.303 54.1731C418.281 45.5457 425.332 38.7434 434.457 33.766C443.748 28.7887 454.532 26.3 466.81 26.3C479.917 26.3 490.95 28.5398 499.909 33.0195C509.034 37.4991 515.919 43.7207 520.565 51.6845C525.376 59.6482 527.782 68.9392 527.782 79.5576C527.782 88.1849 526.206 95.8998 523.054 102.702C519.901 109.339 515.505 115.643 509.864 121.616C504.389 127.423 498.084 133.313 490.95 139.286L444.66 177.86H529.026V202H405.588Z" fill="black"/>
<path d="M274 202V30H386.292V55.0629H302.257V102.731H371.549V127.057H302.257V176.937H389.24V202H274Z" fill="black"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M188.212 157.998C186.672 157.998 185.71 159.665 186.48 160.998L202.585 188.894C203.476 190.437 202.056 192.287 200.335 191.826L151.491 178.737C149.357 178.165 147.163 179.432 146.592 181.566L133.504 230.411C133.042 232.132 130.731 232.436 129.84 230.893L113.732 202.992C112.962 201.659 111.037 201.659 110.268 202.992L94.1595 230.893C93.2686 232.436 90.9568 232.132 90.4956 230.411L77.4075 181.566C76.8357 179.432 74.6423 178.165 72.5085 178.737L23.664 191.826C21.9429 192.287 20.5234 190.437 21.4143 188.894L37.5192 160.998C38.289 159.665 37.3267 157.998 35.7871 157.998L3.57893 157.998C1.79713 157.998 0.904821 155.844 2.16476 154.584L37.9218 118.827C39.484 117.265 39.484 114.733 37.9218 113.171L2.16478 77.4133C0.904844 76.1533 1.7972 73.999 3.57902 73.9991L35.7837 73.9995C37.3233 73.9995 38.2856 72.3328 37.5158 70.9995L21.4143 43.11C20.5234 41.5669 21.9429 39.717 23.664 40.1781L72.5085 53.2665C74.6423 53.8383 76.8357 52.572 77.4075 50.4381L90.4956 1.59292C90.9568 -0.128187 93.2686 -0.432531 94.1595 1.11058L110.267 29.0111C111.037 30.3445 112.962 30.3445 113.732 29.0111L129.84 1.11058C130.73 -0.432532 133.042 -0.128189 133.503 1.59292L146.592 50.4381C147.163 52.572 149.357 53.8383 151.491 53.2665L200.335 40.1781C202.056 39.717 203.476 41.5669 202.585 43.11L186.483 70.9995C185.713 72.3328 186.676 73.9995 188.215 73.9995L220.421 73.9991C222.203 73.999 223.095 76.1533 221.835 77.4133L186.078 113.171C184.516 114.733 184.516 117.265 186.078 118.827L221.835 154.584C223.095 155.844 222.203 157.998 220.421 157.998L188.212 157.998ZM175.919 81.3306C177.366 79.8837 175.963 77.4549 173.987 77.9845L130.491 89.6396C128.357 90.2114 126.164 88.9451 125.592 86.8112L113.931 43.293C113.402 41.3166 110.597 41.3166 110.068 43.293L98.4069 86.8112C97.8351 88.9451 95.6418 90.2114 93.5079 89.6396L50.0136 77.9849C48.0371 77.4553 46.6348 79.8841 48.0817 81.331L79.9216 113.171C81.4837 114.733 81.4837 117.266 79.9216 118.828L48.0742 150.675C46.6273 152.122 48.0296 154.55 50.0061 154.021L93.5079 142.364C95.6418 141.792 97.8351 143.059 98.4069 145.192L110.068 188.711C110.597 190.687 113.402 190.687 113.931 188.711L125.592 145.192C126.164 143.059 128.357 141.792 130.491 142.364L173.994 154.021C175.971 154.551 177.373 152.122 175.926 150.675L144.079 118.828C142.516 117.266 142.516 114.733 144.079 113.171L175.919 81.3306Z" fill="black"/>
`;

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
  const headerHeight = 110; // Space for logo and title
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 1000; // Wider to fill GitHub readme
  const sponsorSectionHeight = 80; // Space for sponsors
  const tableTop = headerHeight + padding; // Add padding between header and table
  const tableBottom = tableTop + tableHeaderHeight + (sorted.length * rowHeight);
  const height = tableBottom + sponsorSectionHeight + padding;

  // Column positions (spread out for wider layout)
  const cols = {
    rank: 40,
    provider: 100,
    median: 400,
    min: 600,
    max: 750,
    status: 900,
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
    .table-header { font: 600 12px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; text-transform: uppercase; letter-spacing: 0.5px; }
    .row { font: 14px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #24292f; }
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
    .timestamp { font: 11px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; }
    .title { font: bold 28px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #24292f; }
    .subtitle { font: 14px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; }
    .logo { fill: #24292f; }
  </style>
  
  <!-- Background -->
  <rect class="bg" width="${width}" height="${height}"/>
  
  <!-- Logo (black square with white C) -->
  <g transform="translate(${padding}, 24)">
    <rect width="60" height="60" fill="#000000"/>
    <g transform="scale(0.035) translate(0, 0)">
      <path fill="#ffffff" d="${LOGO_C_PATH}"/>
    </g>
  </g>
  
  <!-- Title -->
  <text class="title" x="${padding + 76}" y="55">Benchmarks</text>
  <text class="subtitle" x="${padding + 76}" y="78">Independent performance benchmarks for sandbox providers</text>
  
  <!-- Table header background -->
  <rect class="table-header-bg" y="${tableTop}" width="${width}" height="${tableHeaderHeight}"/>
  
  <!-- Table header text -->
  <text class="table-header" x="${cols.rank}" y="${tableTop + 28}">#</text>
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.median}" y="${tableTop + 28}">Median TTI</text>
  <text class="table-header" x="${cols.min}" y="${tableTop + 28}">Min</text>
  <text class="table-header" x="${cols.max}" y="${tableTop + 28}">Max</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Status</text>
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

  const sponsorY = tableBottom + 30;
  
  svg += `
  <!-- Sponsors section -->
  <text class="table-header" x="${padding}" y="${sponsorY}">SPONSORS</text>
  
  <!-- E2B logo -->
  <g transform="translate(${padding}, ${sponsorY + 10}) scale(0.12)">
    ${E2B_LOGO}
  </g>
  
  <!-- Your logo placeholder -->
  <g transform="translate(${padding + 120}, ${sponsorY + 10})">
    <rect width="80" height="30" rx="4" fill="none" stroke="#d0d7de" stroke-dasharray="4 2"/>
    <text x="40" y="20" text-anchor="middle" class="timestamp">Your logo</text>
  </g>
  
  <!-- Timestamp -->
  <text class="timestamp" x="${width - padding}" y="${height - 14}" text-anchor="end">Last updated: ${date}</text>
  
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
