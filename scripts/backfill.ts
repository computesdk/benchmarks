/**
 * Backfill historical benchmark results into the platform.
 *
 * Walks all dated result files, transforms them to the ingest API shape,
 * and POSTs in chronological order (oldest first). Skips latest.json.
 *
 * Usage:
 *   INGEST_URL=https://... INGEST_SECRET=... npx tsx scripts/backfill.ts
 *   INGEST_URL=https://... INGEST_SECRET=... npx tsx scripts/backfill.ts --dry-run
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!INGEST_URL || !INGEST_SECRET)) {
  console.error('INGEST_URL and INGEST_SECRET are required (or pass --dry-run)');
  process.exit(1);
}

if (DRY_RUN) console.log('DRY RUN — no requests will be sent\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a sortable date string from a filename like:
 *   2026-03-16.json           → "2026-03-16"
 *   2026-02-21T01-11-59-562Z.json → "2026-02-21T01:11:59.562Z" (normalized)
 */
function sortKey(filename: string): string {
  const base = filename.replace('.json', '');
  // Normalize timestamp filenames: replace dashes-in-time with colons
  // e.g. "2026-02-21T01-11-59-562Z" → "2026-02-21T01:11:59.562Z"
  return base.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, 'T$1:$2:$3.$4Z');
}

function datedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'latest.json' && f !== '.gitkeep')
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .map((f) => path.join(dir, f));
}

async function post(body: unknown, label: string): Promise<void> {
  if (DRY_RUN) {
    const results = (body as any).results;
    console.log(`  [dry-run] ${label} — ${results.length} provider(s): ${results.map((r: any) => r.provider).join(', ')}`);
    return;
  }

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
    throw new Error(`POST failed for ${label}: ${res.status} ${text}`);
  }

  const { runId } = (await res.json()) as { runId: string };
  console.log(`  ✓ ${label} → runId=${runId}`);
}

// ---------------------------------------------------------------------------
// Percentile helper (for old files that lack p95/p99 in summary)
// ---------------------------------------------------------------------------

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, idx)];
}

function ttiPercentiles(r: any): { median: number; p95: number; p99: number } {
  const { median, p95, p99 } = r.summary.ttiMs;
  if (p95 != null && p99 != null) return { median, p95, p99 };
  // Old format: compute from raw iterations
  const values = (r.iterations as any[]).map((it: any) => it.ttiMs as number).sort((a, b) => a - b);
  return {
    median,
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const SANDBOX_MODES = [
  { dir: 'sequential_tti', mode: 'sequential' },
  { dir: 'staggered_tti', mode: 'staggered' },
  { dir: 'burst_tti', mode: 'burst' },
] as const;

function transformSandboxResult(r: any, mode: string) {
  const dimensions: Record<string, unknown> = { mode };
  if (r.concurrency != null) dimensions.concurrency = r.concurrency;

  const scalars = [];
  if (r.wallClockMs != null) scalars.push({ name: 'wall_clock_ms', value: r.wallClockMs, unit: 'ms' });
  if (r.timeToFirstReadyMs != null) scalars.push({ name: 'time_to_first_ready_ms', value: r.timeToFirstReadyMs, unit: 'ms' });

  const { median, p95, p99 } = ttiPercentiles(r);

  return {
    provider: r.provider,
    dimensions,
    iterations: r.iterations,
    metrics: [{ name: 'tti', unit: 'ms', median, p95, p99 }],
    scalars,
    compositeScore: r.compositeScore,
    scoringVersion: 'sandbox_v1',
    successRate: r.successRate,
    skipped: r.skipped ?? false,
    skipReason: r.skipReason,
  };
}

async function backfillSandbox() {
  // Collect all (file, mode) pairs and sort globally by date
  const all: { file: string; mode: string }[] = [];
  for (const { dir, mode } of SANDBOX_MODES) {
    for (const file of datedFiles(path.join(ROOT, 'results', dir))) {
      all.push({ file, mode });
    }
  }
  all.sort((a, b) => sortKey(path.basename(a.file)).localeCompare(sortKey(path.basename(b.file))));

  console.log(`Sandbox: ${all.length} files to backfill`);

  for (const { file, mode } of all) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const label = `sandbox/${mode}/${path.basename(file)}`;
    const createdAt = raw.timestamp ?? sortKey(path.basename(file));
    await post(
      {
        run: {
          benchmarkType: 'sandbox',
          gitSha: null,
          gitRef: 'backfill',
          triggeredBy: 'backfill',
          createdAt,
          environment: raw.environment,
        },
        results: raw.results.map((r: any) => transformSandboxResult(r, mode)),
      },
      label
    );
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function backfillStorage() {
  const storageDir = path.join(ROOT, 'results', 'storage');
  if (!fs.existsSync(storageDir)) {
    console.log('Storage: no results/storage/ directory found, skipping');
    return;
  }

  const sizeDirs = fs
    .readdirSync(storageDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const all: { file: string; fileSize: string }[] = [];
  for (const sizeDir of sizeDirs) {
    const fileSize = sizeDir.toUpperCase(); // "10mb" → "10MB"
    for (const file of datedFiles(path.join(storageDir, sizeDir))) {
      all.push({ file, fileSize });
    }
  }
  all.sort((a, b) => sortKey(path.basename(a.file)).localeCompare(sortKey(path.basename(b.file))));

  console.log(`Storage: ${all.length} files to backfill`);

  for (const { file, fileSize } of all) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const label = `storage/${fileSize}/${path.basename(file)}`;
    const createdAt = raw.timestamp ?? sortKey(path.basename(file));
    await post(
      {
        run: {
          benchmarkType: 'storage',
          gitSha: null,
          gitRef: 'backfill',
          triggeredBy: 'backfill',
          createdAt,
          environment: raw.environment,
        },
        results: raw.results.map((r: any) => ({
          provider: r.provider,
          dimensions: { file_size: fileSize },
          iterations: r.iterations,
          metrics: [
            { name: 'upload', unit: 'ms', median: r.summary.uploadMs.median, p95: r.summary.uploadMs.p95, p99: r.summary.uploadMs.p99 },
            { name: 'download', unit: 'ms', median: r.summary.downloadMs.median, p95: r.summary.downloadMs.p95, p99: r.summary.downloadMs.p99 },
            { name: 'throughput', unit: 'mbps', median: r.summary.throughputMbps.median, p95: r.summary.throughputMbps.p95, p99: r.summary.throughputMbps.p99 },
          ],
          scalars: [{ name: 'file_size_bytes', value: r.fileSizeBytes, unit: 'bytes' }],
          compositeScore: r.compositeScore,
          scoringVersion: 'storage_v1',
          successRate: r.successRate,
          skipped: r.skipped ?? false,
          skipReason: r.skipReason,
        })),
      },
      label
    );
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

async function backfillBrowser() {
  const browserDir = path.join(ROOT, 'results', 'browser');
  const files = datedFiles(browserDir);

  if (files.length === 0) {
    console.log('Browser: no dated result files found, skipping');
    return;
  }

  console.log(`Browser: ${files.length} files to backfill`);

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const label = `browser/${path.basename(file)}`;
    const createdAt = raw.timestamp ?? sortKey(path.basename(file));
    await post(
      {
        run: {
          benchmarkType: 'browser',
          gitSha: null,
          gitRef: 'backfill',
          triggeredBy: 'backfill',
          createdAt,
          environment: raw.environment,
        },
        results: raw.results.map((r: any) => ({
          provider: r.provider,
          dimensions: {},
          iterations: r.iterations,
          metrics: [
            { name: 'create', unit: 'ms', median: r.summary.createMs.median, p95: r.summary.createMs.p95, p99: r.summary.createMs.p99 },
            { name: 'connect', unit: 'ms', median: r.summary.connectMs.median, p95: r.summary.connectMs.p95, p99: r.summary.connectMs.p99 },
            { name: 'navigate', unit: 'ms', median: r.summary.navigateMs.median, p95: r.summary.navigateMs.p95, p99: r.summary.navigateMs.p99 },
            { name: 'release', unit: 'ms', median: r.summary.releaseMs.median, p95: r.summary.releaseMs.p95, p99: r.summary.releaseMs.p99 },
            { name: 'total', unit: 'ms', median: r.summary.totalMs.median, p95: r.summary.totalMs.p95, p99: r.summary.totalMs.p99 },
          ],
          scalars: [],
          compositeScore: r.compositeScore,
          scoringVersion: 'browser_v1',
          successRate: r.successRate,
          skipped: r.skipped ?? false,
          skipReason: r.skipReason,
        })),
      },
      label
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const start = Date.now();

  await backfillSandbox();
  console.log();
  await backfillStorage();
  console.log();
  await backfillBrowser();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error('\nBackfill failed:', err.message);
  process.exit(1);
});
