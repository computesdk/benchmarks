import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BenchmarkResult } from './types.js';
import { computeCompositeScores, computeSuccessRate } from './scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRICING_PATH = path.join(ROOT, 'pricing.json');
const RESULTS_DIR = path.join(ROOT, 'results');
const SPONSORS_DIR = path.join(ROOT, 'sponsors');

// ComputeSDK logo - the "C" path (same as generate-svg.ts)
const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

/** Active-CPU billing models where CPU is only charged during utilization */
const ACTIVE_CPU_MODELS = ['active_cpu', 'active_cpu_per_10ms'];

/** Default assumed CPU utilization for I/O-bound workloads */
const ESTIMATED_CPU_UTILIZATION = 0.10;

interface PricingProvider {
  id: string;
  benchmark: {
    score: number | null;
    success_rate: string;
    status: string;
    cold_start_ms: number | null;
  };
  pricing: {
    model: string;
    normalized: {
      cpu_per_vcpu_hr: number;
      memory_per_gib_hr: number;
      total_1vcpu_2gb_hr: number;
      confidence: string;
      notes?: string;
    };
  };
  free_credits: number | null;
  isolation: string;
}

/**
 * Compute the estimated cost at 10% CPU utilization for active-CPU providers.
 * For wall-clock providers, returns null (not applicable).
 *
 * Formula: (cpu_rate * utilization) + (memory_rate * 2 GB)
 * Memory is always wall-clock even for active-CPU providers.
 */
function computeEstimatedCost(provider: PricingProvider): number | null {
  if (!ACTIVE_CPU_MODELS.includes(provider.pricing.model)) return null;

  const cpuCost = provider.pricing.normalized.cpu_per_vcpu_hr * ESTIMATED_CPU_UTILIZATION;
  const memCost = provider.pricing.normalized.memory_per_gib_hr * 2; // 2 GB
  return cpuCost + memCost;
}

/**
 * Get the effective cost for a provider.
 * For active-CPU providers, uses estimated 25% CPU utilization.
 * For wall-clock providers, uses the full normalized cost.
 */
function getEffectiveCost(provider: PricingProvider): number {
  return computeEstimatedCost(provider) ?? provider.pricing.normalized.total_1vcpu_2gb_hr;
}

interface PricingData {
  meta: {
    version: string;
    last_updated: string;
    normalization_basis: string;
  };
  providers: PricingProvider[];
}

/**
 * Load all sponsor logos from the sponsors/ directory.
 */
function loadSponsorImages(): { dataUri: string; name: string }[] {
  if (!fs.existsSync(SPONSORS_DIR)) return [];

  const files = fs.readdirSync(SPONSORS_DIR)
    .filter(f => /\.(png|jpe?g|svg)$/i.test(f))
    .sort();

  if (files.length === 0) return [];

  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  return files.map(file => {
    const ext = path.extname(file).toLowerCase();
    const mime = mimeTypes[ext] || 'image/png';
    const raw = fs.readFileSync(path.join(SPONSORS_DIR, file));
    const b64 = raw.toString('base64');
    const name = path.basename(file, ext);
    return { dataUri: `data:${mime};base64,${b64}`, name };
  });
}

function formatProviderName(s: string): string {
  if (s.toLowerCase() === 'e2b') return 'E2B';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatBillingModel(model: string): string {
  const labels: Record<string, string> = {
    'per_second': 'Per-second',
    'per_minute': 'Per-minute',
    'active_cpu': 'Active CPU',
    'active_cpu_per_10ms': 'Active CPU',
    'per_hour_credits': 'Credits',
  };
  return labels[model] || model;
}

/**
 * Compute a value score that combines cost efficiency and benchmark performance.
 *
 * Value score = benchmarkScore * costEfficiency
 *
 * Cost efficiency is scored on a 0-100 scale where:
 *   - $0.00/hr = 100 (free)
 *   - $0.20/hr = 0 (ceiling)
 *
 * The two are multiplied and normalized to 0-100.
 */
function computeValueScore(benchmarkScore: number | null, costPerHr: number): number | null {
  if (benchmarkScore === null || benchmarkScore === 0) return null;

  const COST_CEILING = 0.20; // $/hr — anything at or above this scores 0 for cost
  const costScore = Math.max(0, 100 * (1 - costPerHr / COST_CEILING));

  // Geometric mean gives balanced weight to both dimensions
  return Math.round(Math.sqrt(benchmarkScore * costScore) * 10) / 10;
}

/**
 * Get color class for cost — lower is better (green).
 */
function costColorClass(cost: number): string {
  if (cost <= 0.09) return 'fast';    // green — cheap
  if (cost <= 0.12) return 'medium';  // yellow — moderate
  return 'slow';                       // red — expensive
}

/**
 * Get color class for value score — higher is better.
 */
function valueColorClass(score: number | null): string {
  if (score === null) return 'status';
  if (score >= 60) return 'fast';
  if (score >= 40) return 'medium';
  return 'slow';
}

/**
 * Load live benchmark scores from sequential results.
 * Returns a map of provider id -> { score, success_rate } or null if no results found.
 */
function loadLiveBenchmarkScores(): Map<string, { score: number; successRate: string }> | null {
  const latestPath = path.join(RESULTS_DIR, 'sequential_tti', 'latest.json');
  if (!fs.existsSync(latestPath)) return null;

  try {
    const raw = fs.readFileSync(latestPath, 'utf-8');
    const data = JSON.parse(raw);
    const results: BenchmarkResult[] = data.results;

    // Compute composite scores if not already present
    const hasScores = results.some(r => r.compositeScore !== undefined);
    if (!hasScores) {
      computeCompositeScores(results);
    }

    const scores = new Map<string, { score: number; successRate: string }>();
    for (const r of results) {
      const ok = r.iterations.filter(it => !it.error).length;
      const total = r.iterations.length;
      scores.set(r.provider, {
        score: r.compositeScore ?? 0,
        successRate: `${ok}/${total}`,
      });
    }

    console.log(`Loaded live benchmark scores for ${scores.size} providers from sequential results`);
    return scores;
  } catch (err) {
    console.warn(`Warning: failed to load live benchmark scores: ${err}`);
    return null;
  }
}

function generatePricingSVG(data: PricingData): string {
  const sponsorImages = loadSponsorImages();

  // Sort providers by effective cost (cheapest first)
  const providers = data.providers.map(p => {
    const effCost = getEffectiveCost(p);
    return {
      ...p,
      effectiveCost: effCost,
      isActiveCpu: ACTIVE_CPU_MODELS.includes(p.pricing.model),
      valueScore: computeValueScore(p.benchmark.score, effCost),
    };
  });

  providers.sort((a, b) => a.effectiveCost - b.effectiveCost);

  const rowHeight = 44;
  const headerHeight = 110;
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 1200;
  const tableTop = headerHeight + padding;
  const tableBottom = tableTop + tableHeaderHeight + (providers.length * rowHeight);
  const footnoteHeight = 54;
  const height = tableBottom + padding + 30 + footnoteHeight;

  // Column positions
  const cols = {
    provider: 40,
    cost: 200,
    benchmark: 380,
    billing: 580,
    value: 740,
    confidence: 920,
  };

  const title = 'Pricing Comparison';
  const subtitle = `Normalized to ${data.meta.normalization_basis} — sorted by effective cost`;

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
    .provider { font-weight: 600; fill: #0969da; }
    .cost { font-weight: 700; font-size: 15px; }
    .value { font-weight: 700; font-size: 15px; }
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
    .confidence-exact { fill: #1a7f37; }
    .confidence-estimated { fill: #9a6700; }
    .confidence-unknown { fill: #cf222e; }
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
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.cost}" y="${tableTop + 28}">Eff. Cost / hr</text>
  <text class="table-header" x="${cols.benchmark}" y="${tableTop + 28}">Benchmark</text>
  <text class="table-header" x="${cols.billing}" y="${tableTop + 28}">Billing</text>
  <text class="table-header" x="${cols.value}" y="${tableTop + 28}">Value Score</text>
  <text class="table-header" x="${cols.confidence}" y="${tableTop + 28}">Confidence</text>
`;

  providers.forEach((p, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;

    const cost = p.effectiveCost;
    const benchScore = p.benchmark.score !== null ? p.benchmark.score.toFixed(1) : '--';
    const valueScore = p.valueScore !== null ? p.valueScore.toFixed(1) : '--';
    const billing = formatBillingModel(p.pricing.model);
    const confidence = p.pricing.normalized.confidence;

    // Cost display: add ~ prefix for active-CPU estimated costs
    const costDisplay = p.isActiveCpu ? `~${formatCost(cost)}` : formatCost(cost);

    // Confidence styling
    let confidenceClass = 'status';
    if (confidence === 'exact') confidenceClass = 'confidence-exact';
    else if (confidence === 'estimated') confidenceClass = 'confidence-estimated';

    svg += `
  <!-- ${p.id} -->
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(p.id)}</text>
  <text class="row cost ${costColorClass(cost)}" x="${cols.cost}" y="${y}">${costDisplay}</text>
  <text class="row" x="${cols.benchmark}" y="${y}">${benchScore} (${p.benchmark.success_rate})</text>
  <text class="row" x="${cols.billing}" y="${y}">${billing}</text>
  <text class="row value ${valueColorClass(p.valueScore)}" x="${cols.value}" y="${y}">${valueScore}</text>
  <text class="row ${confidenceClass}" x="${cols.confidence}" y="${y}">${confidence}</text>
`;

    if (i < providers.length - 1) {
      const lineY = tableTop + tableHeaderHeight + ((i + 1) * rowHeight);
      svg += `  <line class="divider" x1="${padding}" y1="${lineY}" x2="${width - padding}" y2="${lineY}"/>
`;
    }
  });

  const date = new Date(data.meta.last_updated).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  svg += `
  <!-- Timestamp -->
  <text class="timestamp" x="${width - padding}" y="${height - 38}" text-anchor="end">Last updated: ${date}</text>

  <!-- Footnotes -->
  <text class="timestamp" x="${padding}" y="${height - 38}">Eff. Cost = effective cost for 1 vCPU + 2 GB RAM / hr. Active-CPU providers (~) estimated at 10% utilization. Value Score = sqrt(benchmark x cost efficiency).</text>
  <text class="timestamp" x="${padding}" y="${height - 24}">Active-CPU billing (Vercel, Cloudflare): CPU charged only during execution, memory always wall-clock. Wall-clock providers: full rate shown.</text>
  <text class="timestamp" x="${padding}" y="${height - 10}">Confidence: exact = official pricing page, estimated = back-calculated from bundled tier.</text>

</svg>`;

  return svg;
}

function main() {
  if (!fs.existsSync(PRICING_PATH)) {
    console.error(`pricing.json not found at ${PRICING_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(PRICING_PATH, 'utf-8');
  const data: PricingData = JSON.parse(raw);

  // Overlay live benchmark scores if available
  const liveScores = loadLiveBenchmarkScores();
  if (liveScores) {
    for (const provider of data.providers) {
      const live = liveScores.get(provider.id);
      if (live) {
        provider.benchmark.score = live.score;
        provider.benchmark.success_rate = live.successRate;
        provider.benchmark.status = live.score > 0 ? 'ok' : 'failed';
      }
    }
  }

  const svg = generatePricingSVG(data);
  const outputPath = path.join(ROOT, 'pricing.svg');
  fs.writeFileSync(outputPath, svg);
  console.log(`Pricing SVG written to ${outputPath}`);
}

main();
