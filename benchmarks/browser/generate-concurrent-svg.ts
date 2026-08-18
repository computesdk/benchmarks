/**
 * SVG generator for the browser concurrent sessions benchmark.
 *
 * Produces two SVGs:
 * 1. browser-concurrent.svg — ranked leaderboard table from the highest
 *    available concurrency level (like the throughput benchmark's SVG).
 * 2. browser-concurrent-degradation.svg — multi-line chart showing median
 *    per-action latency vs. concurrency level for each provider (the
 *    degradation curve). Requires results from multiple concurrency levels.
 *
 *   tsx benchmarks/browser/generate-concurrent-svg.ts
 *   tsx benchmarks/browser/generate-concurrent-svg.ts --action-type screenshot
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CONCURRENCY_LEVELS,
  type ActionType,
  type ConcurrentBenchmarkResult,
} from './concurrent-types.js';
import {
  computeConcurrentCompositeScores,
  sortConcurrentByCompositeScore,
  supportedP95,
} from './concurrent-scoring.js';
import { ensureCapacityFields } from './concurrent-capacity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'results', 'browser-concurrent');

const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

interface ResultFile {
  version: string;
  timestamp: string;
  results: ConcurrentBenchmarkResult[];
  config: { concurrencyLevel?: number };
}

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const actionTypeArg = (getArgValue('--action-type') ?? 'screenshot') as ActionType;

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Provider limit messages carry `&`, `<` and quotes; unescaped they break the SVG. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatProviderName(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

// ── Find the highest available concurrency level ────────────────────────────
function findHighestLevel(): number {
  let highest = 0;
  for (const level of CONCURRENCY_LEVELS) {
    const p = path.join(RESULTS_DIR, `c${level}`, 'latest.json');
    if (fs.existsSync(p)) highest = level;
  }
  return highest;
}

// ── Leaderboard SVG (from highest concurrency level) ─────────────────────────
function generateLeaderboardSVG(
  results: ConcurrentBenchmarkResult[],
  timestamp: string,
  concurrencyLevel: number,
): string {
  if (!results.every(r => r.compositeScore !== undefined)) {
    computeConcurrentCompositeScores(results);
  }
  ensureCapacityFields(results);

  const sorted = sortConcurrentByCompositeScore(results).filter(r => !r.skipped);

  const withheld = sorted.filter(r => r.latencyRepresentative === false);
  const quotaCapped = sorted.filter(r => r.quotaLimited);
  const footerLines = [
    `Each round creates ${concurrencyLevel} sessions in parallel, holds all alive (barrier), runs 10 actions on each simultaneously, then releases all. Lower latency is better.`,
  ];
  if (withheld.length > 0) {
    footerLines.push(
      `-- latency withheld, load not sustained: ${withheld
        .map(r => `${formatProviderName(r.provider)} held ${Math.round(r.concurrencyAchieved ?? 0)}/${concurrencyLevel}`)
        .join(', ')}. Timings taken while most of the load was refused are not comparable.`,
    );
  }
  if (quotaCapped.length > 0) {
    footerLines.push(
      `* capped by an account limit rather than capacity: ${quotaCapped
        .map(r => formatProviderName(r.provider))
        .join(', ')}.`,
    );
  }

  const rowHeight = 44;
  const headerHeight = 110;
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 1280;
  const tableTop = headerHeight + padding;
  const tableBottom = tableTop + tableHeaderHeight + (sorted.length * rowHeight);
  const height = tableBottom + padding + 30 + 20 + (footerLines.length - 1) * 14;

  const cols = {
    rank: 40,
    provider: 80,
    score: 240,
    create: 360,
    task: 500,
    taskP95: 640,
    screenshot: 780,
    aps: 920,
    alive: 1060,
    status: 1180,
  };

  const title = 'Browser Concurrent Sessions Benchmarks';
  const subtitle = `${concurrencyLevel} concurrent sessions per round — barrier-protocol (all sessions alive before actions)`;

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

  <rect class="bg" width="${width}" height="${height}"/>

  <g transform="translate(${padding}, 24)">
    <rect width="60" height="60" fill="#000000"/>
    <g transform="scale(0.035) translate(0, 0)">
      <path fill="#ffffff" d="${LOGO_C_PATH}"/>
    </g>
  </g>

  <text class="title" x="${padding + 76}" y="55">${title}</text>
  <text class="subtitle" x="${padding + 76}" y="78">${subtitle}</text>

  <rect class="table-header-bg" y="${tableTop}" width="${width}" height="${tableHeaderHeight}"/>

  <text class="table-header" x="${cols.rank}" y="${tableTop + 28}">#</text>
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.score}" y="${tableTop + 28}">Score</text>
  <text class="table-header" x="${cols.create}" y="${tableTop + 28}">Create (med)</text>
  <text class="table-header" x="${cols.task}" y="${tableTop + 28}">Loop (med)</text>
  <text class="table-header" x="${cols.taskP95}" y="${tableTop + 28}">Loop (p95)</text>
  <text class="table-header" x="${cols.screenshot}" y="${tableTop + 28}">Screenshot</text>
  <text class="table-header" x="${cols.aps}" y="${tableTop + 28}">Per-sess APS</text>
  <text class="table-header" x="${cols.alive}" y="${tableTop + 28}">Alive</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Success</text>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const rank = i + 1;
    const createMed = r.summary.createMs.median;
    // Per-loop, the unit that compares across levels.
    const loop = r.summary.loopMs;
    const taskMed = loop?.median ?? null;
    const taskP95 = loop ? supportedP95(loop) : null;
    const screenshotMed = r.summary.perActionType.screenshot?.median ?? 0;
    const perSessionAps = r.summary.perSessionActionsPerSecond.median;
    const aliveMed = r.summary.sessionsAlive.median;

    // Count successful sessions across all rounds
    let totalSessions = 0;
    let fullSuccess = 0;
    for (const round of r.rounds) {
      for (const session of round.sessions) {
        totalSessions++;
        const attempted = session.actions.length;
        if (!session.error && attempted > 0 && session.actionsCompleted === attempted) fullSuccess++;
      }
    }
    const allFailed = fullSuccess === 0;
    // Latency measured while most of the load was refused describes a smaller
    // experiment than the one requested, so it is withheld rather than shown
    // next to providers that ran the full level.
    const hideLatency = allFailed || r.latencyRepresentative === false;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';

    let speedClass = hideLatency ? 'slow' : 'fast';
    if (!hideLatency && perSessionAps < 1.0) speedClass = 'slow';
    else if (!hideLatency && perSessionAps < 2.5) speedClass = 'medium';

    let rankClass = 'rank';
    if (rank === 1) rankClass = 'rank rank-1';
    else if (rank === 2) rankClass = 'rank rank-2';
    else if (rank === 3) rankClass = 'rank rank-3';

    // Attempted sessions, not recorded ones: a round the provider refused
    // outright records nothing, so recorded-session denominators hide it.
    const successPct =
      r.successRate !== undefined
        ? (r.successRate * 100).toFixed(0)
        : totalSessions > 0
          ? ((fullSuccess / totalSessions) * 100).toFixed(0)
          : '0';
    // The sustained figure, not the best round: a provider that touched the
    // full level once and spent the rest throttled would otherwise report the
    // peak as if it were typical.
    const sustained = r.concurrencyAchieved !== undefined ? Math.round(r.concurrencyAchieved) : aliveMed;

    svg += `
  <text class="${rankClass}" x="${cols.rank}" y="${y}">${rank}</text>
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(r.provider)}</text>
  <text class="row total" x="${cols.score}" y="${y}">${score}</text>
  <text class="row total ${speedClass}" x="${cols.create}" y="${y}">${hideLatency ? '--' : formatSeconds(createMed)}</text>
  <text class="row" x="${cols.task}" y="${y}">${hideLatency || taskMed === null ? '--' : formatSeconds(taskMed)}</text>
  <text class="row" x="${cols.taskP95}" y="${y}">${hideLatency || taskP95 === null ? '--' : formatSeconds(taskP95)}</text>
  <text class="row" x="${cols.screenshot}" y="${y}">${hideLatency ? '--' : formatMs(screenshotMed)}</text>
  <text class="row ${speedClass}" x="${cols.aps}" y="${y}">${hideLatency ? '--' : perSessionAps.toFixed(2) + '/s'}</text>
  <text class="row" x="${cols.alive}" y="${y}">${sustained}/${r.concurrencyLevel}${r.quotaLimited ? ' *' : ''}</text>
  <text class="row status" x="${cols.status}" y="${y}">${successPct}%</text>
`;

    if (i < sorted.length - 1) {
      const lineY = tableTop + tableHeaderHeight + ((i + 1) * rowHeight);
      svg += `  <line class="divider" x1="${padding}" y1="${lineY}" x2="${width - padding}" y2="${lineY}"/>\n`;
    }
  });

  const date = new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  const footerTop = height - 14 - (footerLines.length - 1) * 14;

  svg += `
  <text class="timestamp" x="${width - padding}" y="${footerTop - 14}" text-anchor="end">Last updated: ${date}</text>
${footerLines
  .map((line, i) => `  <text class="timestamp" x="${padding}" y="${footerTop + i * 14}">${escapeXml(line)}</text>`)
  .join('\n')}
</svg>`;

  return svg;
}

// ── Degradation curve SVG ───────────────────────────────────────────────────
const PROVIDER_COLORS: Record<string, string> = {
  browserbase: '#0969da',
  steel: '#cf222e',
  hyperbrowser: '#1a7f37',
  kernel: '#8250df',
  notte: '#9a6700',
  tilion: '#0550ae',
  browseruse: '#d4a000',
};

function generateDegradationSVG(
  dataByLevel: Map<number, ConcurrentBenchmarkResult[]>,
  actionType: ActionType,
): string {
  const levels = CONCURRENCY_LEVELS.filter(l => dataByLevel.has(l));
  if (levels.length < 2) {
    console.log('Not enough concurrency levels for a degradation curve (need >= 2)');
    return '';
  }

  // Collect all providers that have data at all levels
  const providerSet = new Set<string>();
  for (const level of levels) {
    for (const r of dataByLevel.get(level)!) {
      if (!r.skipped) providerSet.add(r.provider);
    }
  }
  const providers = [...providerSet].sort();

  const padding = 80;
  const width = 1000;
  const chartHeight = 400;
  const headerHeight = 110;
  const legendHeight = 40;
  const height = headerHeight + chartHeight + legendHeight + padding;

  const chartLeft = padding;
  const chartRight = width - padding;
  const chartTop = headerHeight;
  const chartBottom = headerHeight + chartHeight;
  const chartWidth = chartRight - chartLeft;

  // Find max latency for Y axis scaling
  // Scaled over charted points only, so a withheld outlier can't stretch the
  // axis and flatten every line that is actually plotted.
  let maxLatency = 0;
  for (const level of levels) {
    for (const r of dataByLevel.get(level)!) {
      if (r.skipped || r.latencyRepresentative === false) continue;
      const med = r.summary.perActionType[actionType]?.median ?? 0;
      if (med > maxLatency) maxLatency = med;
    }
  }
  // Round up to a nice number
  const yMax = Math.ceil(maxLatency / 500) * 500 || 1000;

  const xScale = (level: number): number => {
    const minL = levels[0];
    const maxL = levels[levels.length - 1];
    if (maxL === minL) return chartLeft + chartWidth / 2;
    // Log-ish scale for better spacing at low levels
    const logMin = Math.log10(minL);
    const logMax = Math.log10(maxL);
    const t = (Math.log10(level) - logMin) / (logMax - logMin);
    return chartLeft + t * chartWidth;
  };

  const yScale = (ms: number): number => {
    return chartBottom - (ms / yMax) * chartHeight;
  };

  const title = 'Browser Concurrent — Degradation Curve';
  const subtitle = `Median ${actionType} latency vs. concurrent sessions — a line ends at the highest level the provider sustained`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .bg { fill: #ffffff; }
    .title { font: bold 24px 'Inter', 'SF Pro Display', -apple-system, sans-serif; fill: #24292f; }
    .subtitle { font: 13px 'Inter', 'SF Pro Display', -apple-system, sans-serif; fill: #57606a; }
    .axis { font: 11px 'Inter', 'SF Pro Display', -apple-system, sans-serif; fill: #57606a; }
    .axis-label { font: 600 12px 'Inter', 'SF Pro Display', -apple-system, sans-serif; fill: #24292f; }
    .grid { stroke: #e1e4e8; stroke-width: 1; stroke-dasharray: 4 4; }
    .axis-line { stroke: #d0d7de; stroke-width: 1; }
    .legend { font: 12px 'Inter', 'SF Pro Display', -apple-system, sans-serif; fill: #24292f; }
  </style>
  <rect class="bg" width="${width}" height="${height}"/>

  <text class="title" x="${padding}" y="40">${title}</text>
  <text class="subtitle" x="${padding}" y="62">${subtitle}</text>
`;

  // Y axis grid lines + labels
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const ms = (yMax / ySteps) * i;
    const y = yScale(ms);
    svg += `  <line class="grid" x1="${chartLeft}" y1="${y}" x2="${chartRight}" y2="${y}"/>\n`;
    svg += `  <text class="axis" x="${chartLeft - 8}" y="${y + 4}" text-anchor="end">${Math.round(ms)}ms</text>\n`;
  }

  // X axis
  svg += `  <line class="axis-line" x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}"/>\n`;
  svg += `  <line class="axis-line" x1="${chartLeft}" y1="${chartTop}" x2="${chartLeft}" y2="${chartBottom}"/>\n`;

  // X axis labels
  for (const level of levels) {
    const x = xScale(level);
    svg += `  <text class="axis" x="${x}" y="${chartBottom + 20}" text-anchor="middle">${level}</text>\n`;
  }
  svg += `  <text class="axis-label" x="${(chartLeft + chartRight) / 2}" y="${chartBottom + 42}" text-anchor="middle">Concurrent Sessions</text>\n`;
  svg += `  <text class="axis-label" x="20" y="${(chartTop + chartBottom) / 2}" text-anchor="middle" transform="rotate(-90 20 ${(chartTop + chartBottom) / 2})">Latency (ms)</text>\n`;

  // Plot lines for each provider
  const legendEntries: { name: string; color: string }[] = [];
  const ceilingNotes: string[] = [];
  for (const provider of providers) {
    const color = PROVIDER_COLORS[provider] ?? '#656d76';
    legendEntries.push({ name: provider, color });

    const points: string[] = [];
    let sustainedLevel = 0;
    for (const level of levels) {
      const results = dataByLevel.get(level)!;
      const r = results.find(r => r.provider === provider && !r.skipped);
      if (!r) continue;
      // A level the provider never sustained produces latency for a smaller
      // experiment. Plotting it reads as "flat under load" when the truth is
      // that the load was refused, so the line simply ends here.
      //
      // The note reports the highest level actually sustained, not the peak
      // session count: a provider can touch 13 sessions in one round of c50
      // while sustaining nothing above c1, and reporting 13 would credit it
      // with a concurrency it never held.
      if (r.latencyRepresentative === false) {
        ceilingNotes.push(`${formatProviderName(provider)} ${sustainedLevel}${r.quotaLimited ? '*' : ''}`);
        break;
      }
      sustainedLevel = level;
      const med = r.summary.perActionType[actionType]?.median ?? 0;
      if (med > 0) {
        const x = xScale(level);
        const y = yScale(med);
        points.push(`${x},${y}`);
      }
    }

    // A single sustained level still deserves its marker; only the connecting
    // line needs two.
    if (points.length >= 2) {
      svg += `  <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5"/>\n`;
    }
    for (const p of points) {
      const [x, y] = p.split(',').map(Number);
      svg += `  <circle cx="${x}" cy="${y}" r="4" fill="${color}"/>\n`;
    }
  }

  // Legend
  let legendX = padding;
  const legendY = height - 20;
  for (const entry of legendEntries) {
    svg += `  <rect x="${legendX}" y="${legendY - 10}" width="12" height="12" fill="${entry.color}" rx="2"/>\n`;
    svg += `  <text class="legend" x="${legendX + 18}" y="${legendY}">${formatProviderName(entry.name)}</text>\n`;
    legendX += 18 + formatProviderName(entry.name).length * 7 + 24;
  }

  if (ceilingNotes.length > 0) {
    svg += `  <text class="subtitle" x="${padding}" y="${legendY - 22}">Highest concurrency sustained: ${escapeXml(ceilingNotes.join(', '))} (* account limit, not capacity)</text>\n`;
  }

  svg += `</svg>`;
  return svg;
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  // ── Leaderboard SVG (from highest available concurrency level) ─────────────
  const highestLevel = findHighestLevel();
  if (highestLevel === 0) {
    console.error(`No concurrent benchmark results found in ${RESULTS_DIR}`);
    process.exit(1);
  }

  const highestPath = path.join(RESULTS_DIR, `c${highestLevel}`, 'latest.json');
  const highestRaw = fs.readFileSync(highestPath, 'utf-8');
  const highestData: ResultFile = JSON.parse(highestRaw);

  const leaderboardSvg = generateLeaderboardSVG(
    highestData.results,
    highestData.timestamp,
    highestLevel,
  );
  const leaderboardPath = path.join(ROOT, 'browser-concurrent.svg');
  fs.writeFileSync(leaderboardPath, leaderboardSvg);
  console.log(`Leaderboard SVG written to ${leaderboardPath}`);

  // ── Degradation curve SVG (requires multiple concurrency levels) ───────────
  const dataByLevel = new Map<number, ConcurrentBenchmarkResult[]>();
  for (const level of CONCURRENCY_LEVELS) {
    const p = path.join(RESULTS_DIR, `c${level}`, 'latest.json');
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf-8');
    const data: ResultFile = JSON.parse(raw);
    ensureCapacityFields(data.results);
    dataByLevel.set(level, data.results);
  }

  const degradationSvg = generateDegradationSVG(dataByLevel, actionTypeArg);
  if (degradationSvg) {
    const degradationPath = path.join(ROOT, 'browser-concurrent-degradation.svg');
    fs.writeFileSync(degradationPath, degradationSvg);
    console.log(`Degradation SVG written to ${degradationPath}`);
  }
}

main();
