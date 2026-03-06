import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BenchmarkResult, BenchmarkMode, ConcurrentBenchmarkResult, StaggeredBenchmarkResult } from './types.js';
import { sortByCompositeScore, computeCompositeScores } from './scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');

// ComputeSDK logo - the "C" path
const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

interface ResultFile {
  timestamp: string;
  results: BenchmarkResult[];
}

// Parse CLI args
const args = process.argv.slice(2);
function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const MODE_TITLES: Record<string, string> = {
  sequential: 'Sequential Benchmarks',
  staggered: 'Staggered Concurrency Benchmarks',
  burst: 'Burst Concurrency Benchmarks',
};

const MODE_SUBTITLES: Record<string, string> = {
  sequential: 'Independent performance benchmarks for sandbox providers',
  staggered: 'Sandbox TTI under gradually increasing concurrent load',
  burst: 'Sandbox TTI under simultaneous burst load',
};

/** Map mode name to results subdirectory */
function modeToDir(mode: string): string {
  return `${mode}_tti`;
}

/**
 * Find the latest result file for a given mode.
 */
function getMostRecentFile(mode: string): ResultFile | null {
  const subDir = path.join(RESULTS_DIR, modeToDir(mode));

  if (!fs.existsSync(subDir)) {
    return null;
  }

  const latestPath = path.join(subDir, 'latest.json');
  if (fs.existsSync(latestPath)) {
    const raw = fs.readFileSync(latestPath, 'utf-8');
    return JSON.parse(raw);
  }

  const files = fs.readdirSync(subDir)
    .filter(f => f.endsWith('.json') && f !== 'latest.json')
    .sort()
    .reverse();
  if (files.length > 0) {
    const raw = fs.readFileSync(path.join(subDir, files[0]), 'utf-8');
    return JSON.parse(raw);
  }

  return null;
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

// Providers that require COMPUTESDK_API_KEY (via ComputeSDK orchestrator)
const GATEWAY_PROVIDERS = ['railway', 'render'];

function formatProviderName(s: string): string {
  if (s.toLowerCase() === 'e2b') return 'E2B';
  const name = s.charAt(0).toUpperCase() + s.slice(1);
  return GATEWAY_PROVIDERS.includes(s.toLowerCase()) ? name + '*' : name;
}

function isConcurrent(r: BenchmarkResult): r is ConcurrentBenchmarkResult {
  return r.mode === 'concurrent';
}

function isStaggered(r: BenchmarkResult): r is StaggeredBenchmarkResult {
  return r.mode === 'staggered';
}

function buildFootnote(results: BenchmarkResult[], mode: string): string {
  if (mode === 'burst') {
    const concurrent = results.find(isConcurrent);
    if (concurrent) {
      return `Burst mode: ${concurrent.concurrency} sandboxes launched simultaneously`;
    }
    return 'Burst mode: all sandboxes launched simultaneously';
  }
  if (mode === 'staggered') {
    const staggered = results.find(isStaggered);
    if (staggered) {
      return `Staggered mode: ${staggered.concurrency} sandboxes, ${staggered.staggerDelayMs}ms between launches`;
    }
    return 'Staggered mode: sandboxes launched with delay between each';
  }
  return '* Uses ComputeSDK orchestrator';
}

function generateSVG(results: BenchmarkResult[], timestamp: string, mode: string): string {
  // Compute scores if not already attached
  const hasScores = results.some(r => r.compositeScore !== undefined);
  if (!hasScores) {
    computeCompositeScores(results);
  }

  const sorted = sortByCompositeScore(results).filter(r => !r.skipped);

  const rowHeight = 44;
  const headerHeight = 110;
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 1200;
  const tableTop = headerHeight + padding;
  const tableBottom = tableTop + tableHeaderHeight + (sorted.length * rowHeight);
  const footnoteHeight = 20;

  // For concurrency modes, add extra space for wall-clock metrics
  const hasConcurrencyMetrics = mode === 'burst' || mode === 'staggered';
  const concurrencyMetricsHeight = hasConcurrencyMetrics ? (sorted.length * 20 + 40) : 0;

  const height = tableBottom + padding + 30 + footnoteHeight + concurrencyMetricsHeight;

  // Column positions
  const cols = {
    rank: 40,
    provider: 80,
    score: 280,
    median: 400,
    min: 530,
    max: 650,
    p95: 770,
    p99: 890,
    status: 1050,
  };

  const title = MODE_TITLES[mode] || 'Benchmarks';
  const subtitle = MODE_SUBTITLES[mode] || 'Independent performance benchmarks for sandbox providers';

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
    .metrics-label { font: 600 12px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; text-transform: uppercase; letter-spacing: 0.5px; }
    .metrics-row { font: 13px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #24292f; }
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
  <text class="title" x="${padding + 76}" y="55">${title}</text>
  <text class="subtitle" x="${padding + 76}" y="78">${subtitle}</text>

  <!-- Table header background -->
  <rect class="table-header-bg" y="${tableTop}" width="${width}" height="${tableHeaderHeight}"/>

  <!-- Table header text -->
  <text class="table-header" x="${cols.rank}" y="${tableTop + 28}">#</text>
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.score}" y="${tableTop + 28}">Score</text>
  <text class="table-header" x="${cols.median}" y="${tableTop + 28}">Median TTI</text>
  <text class="table-header" x="${cols.min}" y="${tableTop + 28}">Min</text>
  <text class="table-header" x="${cols.max}" y="${tableTop + 28}">Max</text>
  <text class="table-header" x="${cols.p95}" y="${tableTop + 28}">P95</text>
  <text class="table-header" x="${cols.p99}" y="${tableTop + 28}">P99</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Status</text>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const ok = r.iterations.filter(it => !it.error).length;
    const total = r.iterations.length;
    const rank = i + 1;
    const medianMs = r.summary.ttiMs.median;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';

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
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(r.provider)}</text>
  <text class="row median" x="${cols.score}" y="${y}">${score}</text>
  <text class="row median ${speedClass}" x="${cols.median}" y="${y}">${formatSeconds(medianMs)}</text>
  <text class="row" x="${cols.min}" y="${y}">${formatSeconds(r.summary.ttiMs.min)}</text>
  <text class="row" x="${cols.max}" y="${y}">${formatSeconds(r.summary.ttiMs.max)}</text>
  <text class="row" x="${cols.p95}" y="${y}">${formatSeconds(r.summary.ttiMs.p95)}</text>
  <text class="row" x="${cols.p99}" y="${y}">${formatSeconds(r.summary.ttiMs.p99)}</text>
  <text class="row status" x="${cols.status}" y="${y}">${ok}/${total}</text>
`;

    if (i < sorted.length - 1) {
      const lineY = tableTop + tableHeaderHeight + ((i + 1) * rowHeight);
      svg += `  <line class="divider" x1="${padding}" y1="${lineY}" x2="${width - padding}" y2="${lineY}"/>
`;
    }
  });

  // Add concurrency-specific metrics section
  if (hasConcurrencyMetrics && sorted.length > 0) {
    const metricsY = tableBottom + 20;
    const metricsLabel = mode === 'burst' ? 'BURST METRICS' : 'STAGGERED METRICS';
    svg += `
  <text class="metrics-label" x="${padding}" y="${metricsY}">${metricsLabel}</text>
`;
    sorted.forEach((r, i) => {
      const y = metricsY + 20 + (i * 20);
      if (isConcurrent(r)) {
        svg += `  <text class="metrics-row" x="${padding + 10}" y="${y}">${formatProviderName(r.provider)}: ${r.concurrency} sandboxes | Wall clock: ${formatSeconds(r.wallClockMs)} | First ready: ${formatSeconds(r.timeToFirstReadyMs)}</text>
`;
      } else if (isStaggered(r)) {
        svg += `  <text class="metrics-row" x="${padding + 10}" y="${y}">${formatProviderName(r.provider)}: ${r.concurrency} sandboxes (${r.staggerDelayMs}ms apart) | Wall clock: ${formatSeconds(r.wallClockMs)} | First ready: ${formatSeconds(r.timeToFirstReadyMs)}</text>
`;
      }
    });
  }

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
  <text class="timestamp" x="${padding}" y="${height - 14}">${buildFootnote(sorted, mode)}</text>

</svg>`;

  return svg;
}

function generateForMode(mode: string): boolean {
  const data = getMostRecentFile(mode);
  if (!data) {
    console.log(`No results found for mode: ${mode}`);
    return false;
  }

  const svg = generateSVG(data.results, data.timestamp, mode);
  const svgPath = path.join(ROOT, `${modeToDir(mode)}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`SVG written to ${svgPath}`);

  // For sequential, also write the root results.svg for backward compat
  if (mode === 'sequential') {
    const rootSvgPath = path.join(ROOT, 'results.svg');
    fs.writeFileSync(rootSvgPath, svg);
    console.log(`SVG written to ${rootSvgPath} (backward compat)`);
  }

  return true;
}

function main() {
  const requestedMode = getArgValue(args, '--mode');

  if (requestedMode) {
    // Generate SVG for a specific mode
    const mode = requestedMode === 'concurrent' ? 'burst' : requestedMode;
    if (!generateForMode(mode)) {
      process.exit(1);
    }
  } else {
    // Generate SVGs for all modes that have results
    const modes = ['sequential', 'staggered', 'burst'];
    let generated = 0;
    for (const mode of modes) {
      if (generateForMode(mode)) {
        generated++;
      }
    }
    if (generated === 0) {
      console.error('No benchmark results found for any mode');
      process.exit(1);
    }
  }
}

main();
