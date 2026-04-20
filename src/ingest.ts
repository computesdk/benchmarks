/**
 * Transforms merged sandbox benchmark results into the platform ingest API
 * format and POSTs them. Reads results/sequential_tti/latest.json,
 * results/staggered_tti/latest.json, and results/burst_tti/latest.json.
 *
 * Usage: tsx src/ingest.ts
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

const MODES = [
  { dir: 'sequential_tti', mode: 'sequential' },
  { dir: 'staggered_tti', mode: 'staggered' },
  { dir: 'burst_tti',     mode: 'burst' },
];

async function ingestMode(mode: string, latestPath: string) {
  if (!fs.existsSync(latestPath)) {
    console.log(`Skipping ${mode}: ${latestPath} not found`);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));

  const triggeredBy =
    process.env.GITHUB_EVENT_NAME === 'schedule' ? 'scheduled' :
    process.env.GITHUB_EVENT_NAME === 'pull_request' ? 'pr' : 'manual';

  const body = {
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
        metrics: [
          {
            name: 'tti',
            unit: 'ms',
            median: r.summary.ttiMs.median,
            p95: r.summary.ttiMs.p95,
            p99: r.summary.ttiMs.p99,
          },
        ],
        scalars,
        compositeScore: r.compositeScore,
        scoringVersion: 'sandbox_v1',
        successRate: r.successRate,
        skipped: r.skipped ?? false,
        skipReason: r.skipReason,
      };
    }),
  };

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
    throw new Error(`Ingest failed for ${mode}: ${res.status} ${text}`);
  }

  const { runId } = await res.json() as { runId: string };
  console.log(`Ingested sandbox/${mode} → runId=${runId}`);
}

async function main() {
  for (const { dir, mode } of MODES) {
    const latestPath = path.join(ROOT, 'results', dir, 'latest.json');
    await ingestMode(mode, latestPath);
  }
}

main().catch(err => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
