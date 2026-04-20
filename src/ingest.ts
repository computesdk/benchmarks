/**
 * Transforms merged benchmark results into the platform ingest API format and POSTs them.
 *
 * Usage: tsx src/ingest.ts --type sandbox|storage|browser
 * Env:   INGEST_URL, INGEST_SECRET, GITHUB_SHA, GITHUB_REF, GITHUB_EVENT_NAME
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!INGEST_URL || !INGEST_SECRET) {
  console.error('INGEST_URL and INGEST_SECRET are required');
  process.exit(1);
}

const args = process.argv.slice(2);
const typeArg = args[args.indexOf('--type') + 1] as 'sandbox' | 'storage' | 'browser' | undefined;
if (!typeArg || !['sandbox', 'storage', 'browser'].includes(typeArg)) {
  console.error('Usage: tsx src/ingest.ts --type sandbox|storage|browser');
  process.exit(1);
}

const triggeredBy =
  process.env.GITHUB_EVENT_NAME === 'schedule' ? 'scheduled' :
  process.env.GITHUB_EVENT_NAME === 'pull_request' ? 'pr' : 'manual';

async function post(body: unknown, label: string) {
  const res = await fetch(INGEST_URL!, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INGEST_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed for ${label}: ${res.status} ${text}`);
  }

  const { runId } = await res.json() as { runId: string };
  console.log(`Ingested ${label} → runId=${runId}`);
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const SANDBOX_MODES = [
  { dir: 'sequential_tti', mode: 'sequential' },
  { dir: 'staggered_tti',  mode: 'staggered' },
  { dir: 'burst_tti',      mode: 'burst' },
];

async function ingestSandbox() {
  for (const { dir, mode } of SANDBOX_MODES) {
    const latestPath = path.join(ROOT, 'results', dir, 'latest.json');
    if (!fs.existsSync(latestPath)) {
      console.log(`Skipping sandbox/${mode}: ${latestPath} not found`);
      continue;
    }

    const raw = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));

    await post({
      run: {
        benchmarkType: 'sandbox',
        gitSha: process.env.GITHUB_SHA,
        gitRef: process.env.GITHUB_REF,
        triggeredBy,
        environment: raw.environment,
      },
      results: raw.results.map((r: any) => {
        const dimensions: Record<string, unknown> = { mode };
        if (r.concurrency != null) dimensions.concurrency = r.concurrency;

        const scalars = [];
        if (r.wallClockMs != null)
          scalars.push({ name: 'wall_clock_ms', value: r.wallClockMs, unit: 'ms' });
        if (r.timeToFirstReadyMs != null)
          scalars.push({ name: 'time_to_first_ready_ms', value: r.timeToFirstReadyMs, unit: 'ms' });

        return {
          provider: r.provider,
          dimensions,
          iterations: r.iterations,
          metrics: [{
            name: 'tti', unit: 'ms',
            median: r.summary.ttiMs.median,
            p95: r.summary.ttiMs.p95,
            p99: r.summary.ttiMs.p99,
          }],
          scalars,
          compositeScore: r.compositeScore,
          scoringVersion: 'sandbox_v1',
          successRate: r.successRate,
          skipped: r.skipped ?? false,
          skipReason: r.skipReason,
        };
      }),
    }, `sandbox/${mode}`);
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function ingestStorage() {
  const storageDir = path.join(ROOT, 'results', 'storage');
  if (!fs.existsSync(storageDir)) {
    console.log('Skipping storage: results/storage/ not found');
    return;
  }

  // Each subdirectory is a file size (e.g. 1mb, 4mb, 10mb, 16mb)
  const sizeDirs = fs.readdirSync(storageDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const sizeDir of sizeDirs) {
    const latestPath = path.join(storageDir, sizeDir, 'latest.json');
    if (!fs.existsSync(latestPath)) continue;

    const raw = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
    // Normalise dir name to match API convention: "10mb" → "10MB"
    const fileSize = sizeDir.toUpperCase();

    await post({
      run: {
        benchmarkType: 'storage',
        gitSha: process.env.GITHUB_SHA,
        gitRef: process.env.GITHUB_REF,
        triggeredBy,
        environment: raw.environment,
      },
      results: raw.results.map((r: any) => ({
        provider: r.provider,
        dimensions: { file_size: fileSize },
        iterations: r.iterations,
        metrics: [
          { name: 'upload',     unit: 'ms',   median: r.summary.uploadMs.median,       p95: r.summary.uploadMs.p95,       p99: r.summary.uploadMs.p99 },
          { name: 'download',   unit: 'ms',   median: r.summary.downloadMs.median,     p95: r.summary.downloadMs.p95,     p99: r.summary.downloadMs.p99 },
          { name: 'throughput', unit: 'mbps', median: r.summary.throughputMbps.median, p95: r.summary.throughputMbps.p95, p99: r.summary.throughputMbps.p99 },
        ],
        scalars: [
          { name: 'file_size_bytes', value: r.fileSizeBytes, unit: 'bytes' },
        ],
        compositeScore: r.compositeScore,
        scoringVersion: 'storage_v1',
        successRate: r.successRate,
        skipped: r.skipped ?? false,
        skipReason: r.skipReason,
      })),
    }, `storage/${fileSize}`);
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

async function ingestBrowser() {
  const latestPath = path.join(ROOT, 'results', 'browser', 'latest.json');
  if (!fs.existsSync(latestPath)) {
    console.log('Skipping browser: results/browser/latest.json not found');
    return;
  }

  const raw = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));

  await post({
    run: {
      benchmarkType: 'browser',
      gitSha: process.env.GITHUB_SHA,
      gitRef: process.env.GITHUB_REF,
      triggeredBy,
      environment: raw.environment,
    },
    results: raw.results.map((r: any) => ({
      provider: r.provider,
      dimensions: {},
      iterations: r.iterations,
      metrics: [
        { name: 'create',   unit: 'ms', median: r.summary.createMs.median,   p95: r.summary.createMs.p95,   p99: r.summary.createMs.p99 },
        { name: 'connect',  unit: 'ms', median: r.summary.connectMs.median,  p95: r.summary.connectMs.p95,  p99: r.summary.connectMs.p99 },
        { name: 'navigate', unit: 'ms', median: r.summary.navigateMs.median, p95: r.summary.navigateMs.p95, p99: r.summary.navigateMs.p99 },
        { name: 'release',  unit: 'ms', median: r.summary.releaseMs.median,  p95: r.summary.releaseMs.p95,  p99: r.summary.releaseMs.p99 },
        { name: 'total',    unit: 'ms', median: r.summary.totalMs.median,    p95: r.summary.totalMs.p95,    p99: r.summary.totalMs.p99 },
      ],
      scalars: [],
      compositeScore: r.compositeScore,
      scoringVersion: 'browser_v1',
      successRate: r.successRate,
      skipped: r.skipped ?? false,
      skipReason: r.skipReason,
    })),
  }, 'browser');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const runners = { sandbox: ingestSandbox, storage: ingestStorage, browser: ingestBrowser };

runners[typeArg]().catch(err => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
