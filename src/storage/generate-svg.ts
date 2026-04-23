import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { StorageBenchmarkResult } from './types.js';
import { sortStorageByCompositeScore, computeStorageCompositeScores } from './scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'results', 'storage');
const SPONSORS_DIR_TIER1 = path.join(ROOT, 'sponsors', 'tier-1');
const SPONSORS_DIR_TIER2 = path.join(ROOT, 'sponsors', 'tier-2');

/**
 * Load all sponsor logos from both tier-1 and tier-2 directories.
 */
function loadSponsorImages(): { dataUri: string; name: string }[] {
  const allSponsors: { dataUri: string; name: string }[] = [];
  
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  const loadFromDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    
    const files = fs.readdirSync(dir)
      .filter(f => /\.(png|jpe?g|svg)$/i.test(f))
      .sort();

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const mime = mimeTypes[ext] || 'image/png';
      const raw = fs.readFileSync(path.join(dir, file));
      const b64 = raw.toString('base64');
      const name = path.basename(file, ext);
      allSponsors.push({ dataUri: `data:${mime};base64,${b64}`, name });
    }
  };

  loadFromDir(SPONSORS_DIR_TIER1);
  loadFromDir(SPONSORS_DIR_TIER2);

  return allSponsors;
}

// ComputeSDK logo
const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

interface ResultFile {
  timestamp: string;
  results: StorageBenchmarkResult[];
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
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

function formatMbps(mbps: number): string {
  return mbps.toFixed(1) + ' Mbps';
}

const sponsorImages = loadSponsorImages();

function generateSVG(results: StorageBenchmarkResult[], timestamp: string, fileSizeLabel: string): string {
  // Compute scores if any are missing
  if (!results.every(r => r.compositeScore !== undefined)) {
    computeStorageCompositeScores(results);
  }

  const sorted = sortStorageByCompositeScore(results).filter(r => !r.skipped);

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
    download: 420,
    throughput: 600,
    upload: 780,
    status: 960,
  };

  const title = 'Object Storage Benchmarks';
  const subtitle = `Download performance - ${fileSizeLabel} files`;

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
    .download { font-weight: 700; font-size: 15px; }
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
  const logosStartX = 1200 - padding - totalLogosW;
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
  <text class="table-header" x="${cols.download}" y="${tableTop + 28}">Download Time</text>
  <text class="table-header" x="${cols.throughput}" y="${tableTop + 28}">Throughput</text>
  <text class="table-header" x="${cols.upload}" y="${tableTop + 28}">Upload Time</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Status</text>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const ok = r.iterations.filter(it => !it.error).length;
    const total = r.iterations.length;
    const rank = i + 1;
    const downloadMs = r.summary.downloadMs.median;
    const allFailed = ok === 0;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';

    // Color code based on download speed
    let speedClass = allFailed ? 'slow' : 'fast';
    if (!allFailed && downloadMs > 5000) speedClass = 'slow';
    else if (!allFailed && downloadMs > 2000) speedClass = 'medium';

    // Rank styling
    let rankClass = 'rank';
    if (rank === 1) rankClass = 'rank rank-1';
    else if (rank === 2) rankClass = 'rank rank-2';
    else if (rank === 3) rankClass = 'rank rank-3';

    const downloadDisplay = allFailed ? '--' : formatSeconds(downloadMs);
    const throughputDisplay = allFailed ? '--' : formatMbps(r.summary.throughputMbps.median);
    const uploadDisplay = allFailed ? '--' : formatSeconds(r.summary.uploadMs.median);

    svg += `
  <!-- Row ${rank} -->
  <text class="${rankClass}" x="${cols.rank}" y="${y}">${rank}</text>
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(r.provider)}</text>
  <text class="row download" x="${cols.score}" y="${y}">${score}</text>
  <text class="row download ${speedClass}" x="${cols.download}" y="${y}">${downloadDisplay}</text>
  <text class="row" x="${cols.throughput}" y="${y}">${throughputDisplay}</text>
  <text class="row" x="${cols.upload}" y="${y}">${uploadDisplay}</text>
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
  <text class="timestamp" x="${padding}" y="${height - 14}">Tests upload then download. Lower download time is better. Throughput is computed from download timing.</text>

</svg>`;

  return svg;
}

function generateForFileSize(fileSizeLabel: string): boolean {
  const sizeDir = path.join(RESULTS_DIR, fileSizeLabel.toLowerCase());
  const latestPath = path.join(sizeDir, 'latest.json');

  if (!fs.existsSync(latestPath)) {
    console.log(`No results found for file size: ${fileSizeLabel}`);
    return false;
  }

  const raw = fs.readFileSync(latestPath, 'utf-8');
  const data: ResultFile = JSON.parse(raw);

  const svg = generateSVG(data.results, data.timestamp, fileSizeLabel);
  const svgPath = path.join(ROOT, `storage_${fileSizeLabel.toLowerCase()}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`SVG written to ${svgPath}`);

  return true;
}

function main() {
  const requestedSize = getArgValue(args, '--file-size');

  if (requestedSize) {
    // Generate SVG for a specific file size
    if (!generateForFileSize(requestedSize)) {
      process.exit(1);
    }
  } else {
    // Generate SVGs for all available file sizes
    const sizes = ['1MB', '4MB', '10MB', '16MB'];
    let generated = 0;
    for (const size of sizes) {
      if (generateForFileSize(size)) {
        generated++;
      }
    }
    if (generated === 0) {
      console.error('No storage benchmark results found for any file size');
      process.exit(1);
    }
  }
}

main();
