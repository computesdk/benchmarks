/**
 * Merge per-provider benchmark results into combined result files.
 *
 * Usage: tsx src/merge-results.ts --input <artifacts-dir> [--mode storage|snapshot-fork|browser|browser-throughput|browser-concurrent|ai-gateway]
 *
 * By default, merges sandbox benchmark results: reads latest.json files from
 * the input directory, groups by mode (sequential/staggered/burst), computes
 * composite scores, and writes combined files to results/<mode>_tti/latest.json.
 *
 * With --mode storage, merges storage benchmark results instead: groups by
 * file size (1mb/10mb/100mb), computes storage-specific composite scores,
 * and writes combined files to results/storage/<size>/latest.json.
 *
 * With --mode browser, merges browser benchmark results: deduplicates by
 * provider, computes browser-specific composite scores, and writes combined
 * files to results/browser/latest.json.
 *
 * With --mode browser-throughput, merges throughput benchmark results into
 * results/browser-throughput/latest.json.
 *
 * With --mode ai-gateway, merges AI gateway benchmark results: deduplicates
 * by provider, computes AI-gateway-specific composite scores, and writes
 * combined files to results/ai-gateway/latest.json.
 *
 * With --mode browser-concurrent, merges concurrent benchmark results:
 * groups by concurrency level (c1/c5/c10/c25/c50), deduplicates by provider
 * within each level, computes concurrent-specific composite scores, and
 * writes combined files to results/browser-concurrent/<level>/latest.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeCompositeScores } from '../sandbox/scoring.js';
import { computeStorageCompositeScores, sortStorageByCompositeScore } from '../storage/scoring.js';
import { computeBrowserCompositeScores, sortBrowserByCompositeScore } from '../browser/scoring.js';
import {
  computeThroughputCompositeScores,
  sortThroughputByCompositeScore,
} from '../browser/throughput-scoring.js';
import { computeAIGatewayCompositeScores, sortAIGatewayByCompositeScore } from '../ai-gateway/scoring.js';
import {
  computeConcurrentCompositeScores,
  computeSweepScore,
  sortConcurrentByCompositeScore,
  supportedP95,
} from '../browser/concurrent-scoring.js';
import { printResultsTable, writeResultsJson } from '../sandbox/table.js';
import type { BenchmarkResult } from '../sandbox/types.js';
import type { StorageBenchmarkResult } from '../storage/types.js';
import type { SnapshotForkBenchmarkResult } from '../storage/snapshot-fork-types.js';
import type { BrowserBenchmarkResult } from '../browser/types.js';
import type { ThroughputBenchmarkResult } from '../browser/throughput-types.js';
import {
  CONCURRENCY_LEVELS,
  SWEEP_WEIGHTS,
  type ConcurrentBenchmarkResult,
} from '../browser/concurrent-types.js';
import type { AIGatewayBenchmarkResult } from '../ai-gateway/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SANDBOX_WORKLOAD_DIRS = new Set([
  'sandbox-dax',
]);

const args = process.argv.slice(2);
function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const inputDir = getArgValue('--input');
const mergeMode = getArgValue('--mode');
if (!inputDir) {
  console.error('Usage: tsx src/merge-results.ts --input <artifacts-dir> [--mode storage|snapshot-fork|browser|browser-throughput|ai-gateway]');
  process.exit(1);
}

interface ResultFile {
  version: string;
  timestamp: string;
  environment: Record<string, any>;
  config: Record<string, any>;
  results: BenchmarkResult[];
}

interface StorageResultFile {
  version: string;
  timestamp: string;
  environment: Record<string, any>;
  config: Record<string, any>;
  results: StorageBenchmarkResult[];
}

/** Map mode to results subdirectory name, matching run.ts logic */
function modeToDir(mode: string): string {
  switch (mode) {
    case 'sequential': return 'sequential_tti';
    case 'staggered': return 'staggered_tti';
    case 'burst':
    case 'concurrent': return 'burst_tti';
    case 'sandbox-dax': return 'sandbox-dax';
    default: return `${mode}_tti`;
  }
}

/** Normalize mode name (concurrent -> burst) */
function normalizeMode(mode: string): string {
  return mode === 'concurrent' ? 'burst' : mode;
}

async function main() {
  // Find only latest.json files recursively to avoid duplicates.
  // Artifact layout: artifacts/results-<provider>/<mode>_tti/latest.json
  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(inputDir!);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${inputDir}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  // Group results by mode, tracking source file size to detect stale multi-provider files
  const byMode: Record<string, { results: { result: BenchmarkResult; fromSingleProvider: boolean }[] }> = {};

  for (const file of jsonFiles) {
    const raw: ResultFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const fromSingleProvider = raw.results.length === 1;
    const dirName = path.basename(path.dirname(file));
    const isSandboxDir = dirName === 'sequential_tti' || dirName === 'staggered_tti' || dirName === 'burst_tti';

    if (!isSandboxDir) {
      continue;
    }

    for (const result of raw.results) {
      // Determine mode from the directory name (e.g. sequential_tti, burst_tti)
      let mode = normalizeMode(result.mode || 'sequential');
      // Infer from directory name if available
      if (dirName.includes('sequential')) mode = 'sequential';
      else if (dirName.includes('staggered')) mode = 'staggered';
      else if (dirName.includes('burst')) mode = 'burst';

      if (!byMode[mode]) {
        byMode[mode] = { results: [] };
      }
      byMode[mode].results.push({ result, fromSingleProvider });
    }
  }

  // For each mode, deduplicate by provider and compute scores
  for (const [mode, { results }] of Object.entries(byMode)) {
    // Deduplicate by provider name. Prefer results from single-provider files
    // (fresh per-job results) over multi-provider files (stale combined results
    // from a previous run that were checked out by git).
    const seen = new Map<string, { result: BenchmarkResult; fromSingleProvider: boolean }>();
    for (const entry of results) {
      const existing = seen.get(entry.result.provider);
      if (!existing || (entry.fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(entry.result.provider, entry);
      }
    }
    const deduped = Array.from(seen.values()).map(e => e.result);

    if (deduped.length !== results.length) {
      console.log(`\nMerging ${deduped.length} provider results for mode: ${mode} (deduplicated from ${results.length})`);
    } else {
      console.log(`\nMerging ${deduped.length} provider results for mode: ${mode}`);
    }

    // Compute composite scores across all providers
    computeCompositeScores(deduped);

    // Print the combined table
    printResultsTable(deduped);

    // Write combined results
    const timestamp = new Date().toISOString().slice(0, 10);
    const subDir = modeToDir(mode);
    const resultsDir = path.resolve(ROOT, `results/${subDir}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    const outPath = path.join(resultsDir, `${timestamp}.json`);
    await writeResultsJson(deduped, outPath);

    // Copy to latest.json
    const latestPath = path.join(resultsDir, 'latest.json');
    fs.copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }

  // Merge sandbox workload benchmark results (e.g. sandbox-dax)
  const workloadByMode: Record<string, { results: { result: any; fromSingleProvider: boolean }[] }> = {};

  for (const file of jsonFiles) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results?: any[] };
    if (!raw.results || raw.results.length === 0) continue;

    const dirName = path.basename(path.dirname(file));
    if (!SANDBOX_WORKLOAD_DIRS.has(dirName)) continue;

    const fromSingleProvider = raw.results.length === 1;
    if (!workloadByMode[dirName]) workloadByMode[dirName] = { results: [] };
    for (const result of raw.results) {
      workloadByMode[dirName].results.push({ result, fromSingleProvider });
    }
  }

  for (const [mode, { results }] of Object.entries(workloadByMode)) {
    const seen = new Map<string, { result: any; fromSingleProvider: boolean }>();
    for (const entry of results) {
      const existing = seen.get(entry.result.provider);
      if (!existing || (entry.fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(entry.result.provider, entry);
      }
    }

    const deduped = Array.from(seen.values()).map(e => e.result);
    console.log(`\nMerging ${deduped.length} provider results for mode: ${mode}`);

    const timestamp = new Date().toISOString().slice(0, 10);
    const resultsDir = path.resolve(ROOT, `results/${modeToDir(mode)}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    const output = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      config: { mode },
      results: deduped,
    };

    const outPath = path.join(resultsDir, `${timestamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`Results written to ${outPath}`);

    const latestPath = path.join(resultsDir, 'latest.json');
    fs.copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }
}

/**
 * Print a storage results table to stdout.
 */
function printStorageResultsTable(results: StorageBenchmarkResult[], fileSize: string): void {
  const sorted = sortStorageByCompositeScore(results);

  console.log(`\n${'='.repeat(95)}`);
  console.log(`  STORAGE BENCHMARK RESULTS - ${fileSize.toUpperCase()}`);
  console.log('='.repeat(95));
  console.log(
    ['Provider', 'Score', 'Download', 'Throughput', 'Upload', 'Status']
      .map((h, i) => h.padEnd([14, 8, 14, 14, 14, 10][i]))
      .join(' | ')
  );
  console.log(
    [14, 8, 14, 14, 14, 10].map(w => '-'.repeat(w)).join('-+-')
  );

  for (const r of sorted) {
    if (r.skipped) {
      console.log([r.provider.padEnd(14), '--'.padEnd(8), '--'.padEnd(14), '--'.padEnd(14), '--'.padEnd(14), 'SKIPPED'.padEnd(10)].join(' | '));
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
    const dl = (r.summary.downloadMs.median / 1000).toFixed(2) + 's';
    const tp = r.summary.throughputMbps.median.toFixed(1) + ' Mbps';
    const ul = (r.summary.uploadMs.median / 1000).toFixed(2) + 's';
    console.log([r.provider.padEnd(14), score.padEnd(8), dl.padEnd(14), tp.padEnd(14), ul.padEnd(14), `${ok}/${total} OK`.padEnd(10)].join(' | '));
  }
  console.log('='.repeat(95));
}

/**
 * Merge storage benchmark results, grouped by file size.
 */
async function mainStorage() {
  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(inputDir!);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${inputDir}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  // Group results by file size (e.g. "1mb", "10mb", "100mb")
  const bySize: Record<string, { results: { result: StorageBenchmarkResult; fromSingleProvider: boolean }[] }> = {};

  for (const file of jsonFiles) {
    const raw: StorageResultFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const fromSingleProvider = raw.results.length === 1;
    for (const result of raw.results) {
      // Infer file size from the directory name (e.g. artifacts/storage-results-aws-s3/storage/10mb/latest.json)
      const dirName = path.basename(path.dirname(file));
      const fileSize = dirName.toLowerCase();

      if (!bySize[fileSize]) {
        bySize[fileSize] = { results: [] };
      }
      bySize[fileSize].results.push({ result, fromSingleProvider });
    }
  }

  for (const [fileSize, { results }] of Object.entries(bySize)) {
    // Deduplicate by provider, preferring single-provider files
    const seen = new Map<string, { result: StorageBenchmarkResult; fromSingleProvider: boolean }>();
    for (const entry of results) {
      const existing = seen.get(entry.result.provider);
      if (!existing || (entry.fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(entry.result.provider, entry);
      }
    }
    const deduped = Array.from(seen.values()).map(e => e.result);

    if (deduped.length !== results.length) {
      console.log(`\nMerging ${deduped.length} provider results for storage/${fileSize} (deduplicated from ${results.length})`);
    } else {
      console.log(`\nMerging ${deduped.length} provider results for storage/${fileSize}`);
    }

    // Compute storage-specific composite scores
    computeStorageCompositeScores(deduped);

    // Print storage table
    printStorageResultsTable(deduped, fileSize);

    // Write combined results
    const timestamp = new Date().toISOString().slice(0, 10);
    const { writeStorageResultsJson } = await import('../storage/benchmark.js');
    const resultsDir = path.resolve(ROOT, `results/storage/${fileSize}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    const outPath = path.join(resultsDir, `${timestamp}.json`);
    await writeStorageResultsJson(deduped, outPath);

    const latestPath = path.join(resultsDir, 'latest.json');
    fs.copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }
}

/**
 * Print a snapshot/fork results table to stdout.
 */
function printSnapshotForkResultsTable(results: SnapshotForkBenchmarkResult[], dataset: string): void {
  const sorted = [...results].sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0));

  console.log(`\n${'='.repeat(95)}`);
  console.log(`  SNAPSHOT/FORK BENCHMARK RESULTS - ${dataset.toUpperCase()}`);
  console.log('='.repeat(95));
  console.log(
    ['Provider', 'Score', 'Snap create', 'Fork(snap)', 'Fork(live)', 'Status']
      .map((h, i) => h.padEnd([14, 8, 14, 14, 14, 10][i]))
      .join(' | ')
  );
  console.log(
    [14, 8, 14, 14, 14, 10].map(w => '-'.repeat(w)).join('-+-')
  );

  for (const r of sorted) {
    if (r.skipped) {
      console.log([r.provider.padEnd(14), '--'.padEnd(8), '--'.padEnd(14), '--'.padEnd(14), '--'.padEnd(14), 'SKIPPED'.padEnd(10)].join(' | '));
      continue;
    }
    const ok = r.iterations.filter(i => !i.error && i.verified).length;
    const total = r.iterations.length;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
    const snap = (r.summary.snapshotCreateMs.median / 1000).toFixed(2) + 's';
    const forkSnap = (r.summary.forkFromSnapshotMs.median / 1000).toFixed(2) + 's';
    const forkLive = (r.summary.forkFromLiveMs.median / 1000).toFixed(2) + 's';
    console.log([r.provider.padEnd(14), score.padEnd(8), snap.padEnd(14), forkSnap.padEnd(14), forkLive.padEnd(14), `${ok}/${total} OK`.padEnd(10)].join(' | '));
  }
  console.log('='.repeat(95));
}

/**
 * Merge snapshot/fork benchmark results, grouped by dataset.
 *
 * Composite scores use an absolute latency ceiling (not cross-provider
 * normalization), so merging is just dedupe-by-provider + recompute + write —
 * the per-provider scores are already comparable.
 */
async function mainSnapshotFork() {
  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(inputDir!);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${inputDir}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  // Group by dataset, inferred from the parent directory name, e.g.
  // sf-artifacts/snapshot-fork-results-aws-s3/snapshot-fork/small/latest.json
  const byDataset: Record<string, { results: { result: SnapshotForkBenchmarkResult; fromSingleProvider: boolean }[] }> = {};

  for (const file of jsonFiles) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: SnapshotForkBenchmarkResult[] };
    const fromSingleProvider = raw.results.length === 1;
    const dataset = path.basename(path.dirname(file));
    for (const result of raw.results) {
      if (!byDataset[dataset]) byDataset[dataset] = { results: [] };
      byDataset[dataset].results.push({ result, fromSingleProvider });
    }
  }

  const { computeSnapshotForkCompositeScores, writeSnapshotForkResultsJson } = await import('../storage/snapshot-fork-benchmark.js');

  for (const [dataset, { results }] of Object.entries(byDataset)) {
    // Deduplicate by provider, preferring fresh single-provider files over
    // stale combined files that may have been checked out by git.
    const seen = new Map<string, { result: SnapshotForkBenchmarkResult; fromSingleProvider: boolean }>();
    for (const entry of results) {
      const existing = seen.get(entry.result.provider);
      if (!existing || (entry.fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(entry.result.provider, entry);
      }
    }
    const deduped = Array.from(seen.values()).map(e => e.result);

    if (deduped.length !== results.length) {
      console.log(`\nMerging ${deduped.length} provider results for snapshot-fork/${dataset} (deduplicated from ${results.length})`);
    } else {
      console.log(`\nMerging ${deduped.length} provider results for snapshot-fork/${dataset}`);
    }

    computeSnapshotForkCompositeScores(deduped);
    printSnapshotForkResultsTable(deduped, dataset);

    const timestamp = new Date().toISOString().slice(0, 10);
    const resultsDir = path.resolve(ROOT, `results/snapshot-fork/${dataset}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    const outPath = path.join(resultsDir, `${timestamp}.json`);
    await writeSnapshotForkResultsJson(deduped, outPath);

    const latestPath = path.join(resultsDir, 'latest.json');
    fs.copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }
}

/**
 * Print a browser results table to stdout.
 */
function printBrowserResultsTable(results: BrowserBenchmarkResult[]): void {
  const sorted = sortBrowserByCompositeScore(results);

  console.log(`\n${'='.repeat(110)}`);
  console.log('  BROWSER PROVIDER BENCHMARK RESULTS');
  console.log('='.repeat(110));
  console.log(
    ['Provider', 'Score', 'Create', 'Connect', 'Navigate', 'Release', 'Total', 'Status']
      .map((h, i) => h.padEnd([14, 8, 12, 12, 12, 12, 12, 10][i]))
      .join(' | ')
  );
  console.log(
    [14, 8, 12, 12, 12, 12, 12, 10].map(w => '-'.repeat(w)).join('-+-')
  );

  for (const r of sorted) {
    if (r.skipped) {
      console.log([r.provider.padEnd(14), '--'.padEnd(8), '--'.padEnd(12), '--'.padEnd(12), '--'.padEnd(12), '--'.padEnd(12), '--'.padEnd(12), 'SKIPPED'.padEnd(10)].join(' | '));
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
    const create = (r.summary.createMs.median / 1000).toFixed(2) + 's';
    const connect = (r.summary.connectMs.median / 1000).toFixed(2) + 's';
    const navigate = (r.summary.navigateMs.median / 1000).toFixed(2) + 's';
    const release = (r.summary.releaseMs.median / 1000).toFixed(2) + 's';
    const tot = (r.summary.totalMs.median / 1000).toFixed(2) + 's';
    console.log([r.provider.padEnd(14), score.padEnd(8), create.padEnd(12), connect.padEnd(12), navigate.padEnd(12), release.padEnd(12), tot.padEnd(12), `${ok}/${total} OK`.padEnd(10)].join(' | '));
  }
  console.log('='.repeat(110));
}

/**
 * Merge browser benchmark results.
 */
async function mainBrowser() {
  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(inputDir!);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${inputDir}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  // Collect all results, deduplicating by provider
  const seen = new Map<string, { result: BrowserBenchmarkResult; fromSingleProvider: boolean }>();

  for (const file of jsonFiles) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: BrowserBenchmarkResult[] };
    const fromSingleProvider = raw.results.length === 1;
    for (const result of raw.results) {
      const existing = seen.get(result.provider);
      if (!existing || (fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(result.provider, { result, fromSingleProvider });
      }
    }
  }

  const deduped = Array.from(seen.values()).map(e => e.result);
  console.log(`\nMerging ${deduped.length} provider results for mode: browser`);

  // Compute composite scores
  computeBrowserCompositeScores(deduped);

  // Print table
  printBrowserResultsTable(deduped);

  // Write combined results
  const { writeBrowserResultsJson } = await import('../browser/benchmark.js');
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(ROOT, 'results/browser');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeBrowserResultsJson(deduped, outPath);

  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

/**
 * Print a browser-throughput results table to stdout.
 */
function printThroughputResultsTable(results: ThroughputBenchmarkResult[]): void {
  const sorted = sortThroughputByCompositeScore(results);

  console.log(`\n${'='.repeat(120)}`);
  console.log('  BROWSER THROUGHPUT BENCHMARK RESULTS');
  console.log('='.repeat(120));
  console.log(
    ['Provider', 'Score', 'APS (med)', 'Task (med)', 'Task (p95)', 'Screenshot', 'Create', 'Status']
      .map((h, i) => h.padEnd([14, 8, 12, 12, 12, 12, 12, 10][i]))
      .join(' | ')
  );
  console.log(
    [14, 8, 12, 12, 12, 12, 12, 10].map(w => '-'.repeat(w)).join('-+-')
  );

  for (const r of sorted) {
    if (r.skipped) {
      console.log([r.provider.padEnd(14), '--'.padEnd(8), '--'.padEnd(12), '--'.padEnd(12), '--'.padEnd(12), '--'.padEnd(12), '--'.padEnd(12), 'SKIPPED'.padEnd(10)].join(' | '));
      continue;
    }
    const expectedActions = 50;
    const fullSuccess = r.iterations.filter(i => !i.error && i.actionsCompleted === expectedActions).length;
    const total = r.iterations.length;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
    const aps = `${r.summary.actionsPerSecond.median.toFixed(2)}/s`;
    const taskMed = `${(r.summary.taskMs.median / 1000).toFixed(2)}s`;
    const taskP95 = `${(r.summary.taskMs.p95 / 1000).toFixed(2)}s`;
    const screenshotMed = `${Math.round(r.summary.perActionType.screenshot?.median ?? 0)}ms`;
    const createMed = `${(r.summary.createMs.median / 1000).toFixed(2)}s`;
    console.log([r.provider.padEnd(14), score.padEnd(8), aps.padEnd(12), taskMed.padEnd(12), taskP95.padEnd(12), screenshotMed.padEnd(12), createMed.padEnd(12), `${fullSuccess}/${total} OK`.padEnd(10)].join(' | '));
  }
  console.log('='.repeat(120));
}

/**
 * Merge browser-throughput benchmark results.
 */
async function mainBrowserThroughput() {
  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(inputDir!);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${inputDir}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  const seen = new Map<string, { result: ThroughputBenchmarkResult; fromSingleProvider: boolean }>();

  for (const file of jsonFiles) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: ThroughputBenchmarkResult[] };
    const fromSingleProvider = raw.results.length === 1;
    for (const result of raw.results) {
      const existing = seen.get(result.provider);
      if (!existing || (fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(result.provider, { result, fromSingleProvider });
      }
    }
  }

  const deduped = Array.from(seen.values()).map(e => e.result);
  console.log(`\nMerging ${deduped.length} provider results for mode: browser-throughput`);

  computeThroughputCompositeScores(deduped);
  printThroughputResultsTable(deduped);

  const { writeThroughputResultsJson } = await import('../browser/throughput-benchmark.js');
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(ROOT, 'results/browser-throughput');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeThroughputResultsJson(deduped, outPath);

  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

/**
 * Print an AI gateway results table to stdout.
 */
function printAIGatewayResultsTable(results: AIGatewayBenchmarkResult[]): void {
  const sorted = sortAIGatewayByCompositeScore(results);

  console.log(`\n${'='.repeat(110)}`);
  console.log('  AI GATEWAY BENCHMARK RESULTS');
  console.log('='.repeat(110));
  console.log(
    ['Provider', 'Score', 'Cold E2E', 'Warm TTFT', 'Tok/sec', 'Status']
      .map((h, i) => h.padEnd([22, 8, 12, 12, 12, 10][i]))
      .join(' | ')
  );
  console.log(
    [22, 8, 12, 12, 12, 10].map(w => '-'.repeat(w)).join('-+-')
  );

  for (const r of sorted) {
    if (r.skipped) {
      console.log([r.provider.padEnd(22), '--'.padEnd(8), '--'.padEnd(12), '--'.padEnd(12), '--'.padEnd(12), 'SKIPPED'.padEnd(10)].join(' | '));
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
    const coldE2e = `${Math.round(r.summary.coldE2eMs.median)}ms`;
    const warmTtft = `${Math.round(r.summary.warmTtftMs.median)}ms`;
    const tokensPerSec = r.summary.outputTokensPerSec.median.toFixed(1);
    console.log([r.provider.padEnd(22), score.padEnd(8), coldE2e.padEnd(12), warmTtft.padEnd(12), tokensPerSec.padEnd(12), `${ok}/${total} OK`.padEnd(10)].join(' | '));
  }
  console.log('='.repeat(110));
}

/**
 * Merge AI gateway benchmark results.
 */
async function mainAIGateway() {
  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(inputDir!);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${inputDir}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  // Collect all results, deduplicating by provider
  const seen = new Map<string, { result: AIGatewayBenchmarkResult; fromSingleProvider: boolean }>();

  for (const file of jsonFiles) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: AIGatewayBenchmarkResult[] };
    const fromSingleProvider = raw.results.length === 1;
    for (const result of raw.results) {
      const existing = seen.get(result.provider);
      if (!existing || (fromSingleProvider && !existing.fromSingleProvider)) {
        seen.set(result.provider, { result, fromSingleProvider });
      }
    }
  }

  const deduped = Array.from(seen.values()).map(e => e.result);
  console.log(`\nMerging ${deduped.length} provider results for mode: ai-gateway`);

  // Compute composite scores
  computeAIGatewayCompositeScores(deduped);

  // Print table
  printAIGatewayResultsTable(deduped);

  // Write combined results
  const { writeAIGatewayResultsJson } = await import('../ai-gateway/benchmark.js');
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(ROOT, 'results/ai-gateway');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeAIGatewayResultsJson(deduped, outPath);

  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

/**
 * Merge browser-concurrent benchmark results. Results from different
 * concurrency levels are stored in separate subdirectories (c1, c5, c10,
 * c25, c50). Each subdirectory's latest.json contains results from a single
 * provider (one CI job per provider × concurrency level). This function
 * merges all providers' results within each concurrency level.
 */
async function mainBrowserConcurrent() {
  // Find all latest.json files, grouped by concurrency level directory
  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(path.resolve(inputDir!));

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${inputDir}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result files`);

  // Group files by their parent directory name (c1, c5, c10, c25, c50)
  const filesByLevel = new Map<string, string[]>();
  for (const file of jsonFiles) {
    const levelDir = path.basename(path.dirname(file));
    if (!filesByLevel.has(levelDir)) filesByLevel.set(levelDir, []);
    filesByLevel.get(levelDir)!.push(file);
  }

  const { writeConcurrentResultsJson } = await import('../browser/concurrent-benchmark.js');

  // provider -> level -> composite, collected across the loop so the sweep score
  // can weight every level once they have all been merged.
  const scoresByProvider = new Map<string, Map<number, number | undefined>>();
  const quotaLimitedProviders = new Set<string>();

  for (const [levelDir, files] of filesByLevel) {
    const seen = new Map<string, { result: ConcurrentBenchmarkResult; fromSingleProvider: boolean }>();

    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: ConcurrentBenchmarkResult[] };
      const fromSingleProvider = raw.results.length === 1;
      for (const result of raw.results) {
        const existing = seen.get(result.provider);
        if (!existing || (fromSingleProvider && !existing.fromSingleProvider)) {
          seen.set(result.provider, { result, fromSingleProvider });
        }
      }
    }

    const deduped = Array.from(seen.values()).map(e => e.result);
    const concurrencyLevel = deduped[0]?.concurrencyLevel ?? parseInt(levelDir.replace('c', ''), 10);
    console.log(`\nMerging ${deduped.length} provider results for mode: browser-concurrent (c${concurrencyLevel})`);

    computeConcurrentCompositeScores(deduped);

    for (const r of deduped) {
      if (!scoresByProvider.has(r.provider)) scoresByProvider.set(r.provider, new Map());
      // A skipped level scores zero rather than going unrecorded, so it costs its
      // weight instead of quietly shrinking the denominator.
      scoresByProvider.get(r.provider)!.set(concurrencyLevel, r.skipped ? 0 : r.compositeScore);
      if (r.quotaLimited) quotaLimitedProviders.add(r.provider);
    }

    // Print table
    const sorted = sortConcurrentByCompositeScore(deduped);
    console.log(`\n${'='.repeat(120)}`);
    console.log(`  BROWSER CONCURRENT BENCHMARK RESULTS (c${concurrencyLevel})`);
    console.log('='.repeat(120));
    console.log(
      ['Provider', 'Score', 'Create', 'Loop', 'Loop (p95)', 'Screenshot', 'APS/sess', 'Peak', 'Success']
        .map((h, i) => h.padEnd([14, 8, 10, 10, 10, 12, 10, 8, 10][i]))
        .join(' | '),
    );
    for (const r of sorted) {
      if (r.skipped) continue;
      const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
      // Withheld for the same reason the charts withhold it: timings sampled
      // while most of the load was refused describe a smaller experiment.
      const hideLatency = r.latencyRepresentative === false;
      const createMed = hideLatency ? '--' : `${(r.summary.createMs.median / 1000).toFixed(2)}s`;
      // Per-loop: one session's ten actions while the level's sessions run
      // together. taskMs covers a level's whole action phase, and levels differ
      // in how many loops that is.
      // No fallback to taskMs here: presenting a whole action phase under a
      // per-loop heading would relabel the number rather than report it.
      const loop = r.summary.loopMs;
      const taskMed = hideLatency || !loop ? '--' : `${(loop.median / 1000).toFixed(2)}s`;
      const p95 = loop ? supportedP95(loop) : null;
      // Dashed rather than repeated: below the sample gate the p95 is the median.
      const taskP95 = hideLatency || p95 === null ? '--' : `${(p95 / 1000).toFixed(2)}s`;
      const screenshotMed = hideLatency
        ? '--'
        : `${Math.round(r.summary.perActionType.screenshot?.median ?? 0)}ms`;
      const aps = hideLatency ? '--' : r.summary.perSessionActionsPerSecond.median.toFixed(2);
      // Measured peak simultaneity where the rounds recorded it, so the column
      // says how many sessions actually ran together rather than how many
      // survived. Falls back for artifacts written before the counter existed.
      const measuredPeak = r.rounds.reduce(
        (max, round) => Math.max(max, round.maxConcurrentActions ?? 0),
        0,
      );
      const sustained = measuredPeak > 0
        ? measuredPeak
        : r.concurrencyAchieved !== undefined
          ? Math.round(r.concurrencyAchieved)
          : r.summary.sessionsAlive.median;
      const alive = `${sustained}/${r.concurrencyLevel}${r.quotaLimited ? '*' : ''}`;
      let totalSessions = 0, fullSuccess = 0;
      for (const round of r.rounds) {
        for (const session of round.sessions) {
          totalSessions++;
          // Same all-or-nothing rule as computeConcurrentSuccessRate, against the
          // actions the session attempted. The old fixed 10 predates sessions
          // running more than one loop, so it counted a session that completed
          // all 200 of its actions as a failure.
          const attempted = session.actions.length;
          if (!session.error && attempted > 0 && session.actionsCompleted === attempted) fullSuccess++;
        }
      }
      const successPct =
        r.successRate !== undefined
          ? `${(r.successRate * 100).toFixed(0)}%`
          : totalSessions > 0
            ? `${((fullSuccess / totalSessions) * 100).toFixed(0)}%`
            : '0%';
      console.log([r.provider.padEnd(14), score.padEnd(8), createMed.padEnd(10), taskMed.padEnd(10), taskP95.padEnd(10), screenshotMed.padEnd(12), aps.padEnd(10), alive.padEnd(8), successPct.padEnd(10)].join(' | '));
    }
    console.log('='.repeat(120));
    const withheld = sorted.filter(r => !r.skipped && r.latencyRepresentative === false);
    if (withheld.length > 0) {
      console.log(
        `  -- latency withheld, load not sustained: ${withheld
          .map(r => `${r.provider} held ${Math.round(r.concurrencyAchieved ?? 0)}/${r.concurrencyLevel}`)
          .join(', ')}`,
      );
    }
    const quotaCapped = sorted.filter(r => r.quotaLimited);
    if (quotaCapped.length > 0) {
      console.log(`  *  capped by an account limit, not capacity: ${quotaCapped.map(r => r.provider).join(', ')}`);
      for (const r of quotaCapped) {
        if (r.quotaEvidence) console.log(`     ${r.provider}: ${r.quotaEvidence}`);
      }
    }

    // Write combined results
    const timestamp = new Date().toISOString().slice(0, 10);
    const resultsDir = path.resolve(ROOT, `results/browser-concurrent/${levelDir}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    const outPath = path.join(resultsDir, `${timestamp}.json`);
    await writeConcurrentResultsJson(deduped, outPath, { concurrencyLevel });

    const latestPath = path.join(resultsDir, 'latest.json');
    fs.copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }

  printConcurrentSweepTable(scoresByProvider, quotaLimitedProviders);
}

/**
 * One score per provider across every level, so the sweep has a headline number
 * without any single level standing in for the whole curve. Printed after the
 * per-level tables rather than instead of them: the curve is the finding, and one
 * number cannot show where a provider stopped keeping up.
 */
function printConcurrentSweepTable(
  scoresByProvider: Map<string, Map<number, number | undefined>>,
  quotaLimited: Set<string>,
): void {
  if (scoresByProvider.size === 0) return;

  const rows = Array.from(scoresByProvider.entries())
    .map(([provider, byLevel]) => ({ provider, byLevel, sweep: computeSweepScore(byLevel) }))
    .sort((a, b) => b.sweep - a.sweep);

  const weights = CONCURRENCY_LEVELS.map(l => `c${l} ${(SWEEP_WEIGHTS[l] * 100).toFixed(0)}%`).join('  ');
  console.log(`\n${'='.repeat(120)}`);
  console.log('  BROWSER CONCURRENCY SWEEP SCORE');
  console.log('='.repeat(120));
  console.log(`  weights: ${weights}   (a level with no result scores 0 and keeps its weight)`);
  console.log('-'.repeat(120));
  console.log(
    ['Provider'.padEnd(14), 'Sweep'.padEnd(8), ...CONCURRENCY_LEVELS.map(l => `c${l}`.padEnd(8))].join(' | '),
  );
  console.log('-'.repeat(120));
  for (const { provider, byLevel, sweep } of rows) {
    // '--' distinguishes a level that never ran from one that scored zero. Both
    // cost the weight, but only one of them was attempted.
    const cells = CONCURRENCY_LEVELS.map(l => {
      const score = byLevel.get(l);
      return (score === undefined ? '--' : score.toFixed(1)).padEnd(8);
    });
    const name = `${provider}${quotaLimited.has(provider) ? '*' : ''}`;
    console.log([name.padEnd(14), sweep.toFixed(1).padEnd(8), ...cells].join(' | '));
  }
  console.log('='.repeat(120));
  const missing = rows.filter(r => CONCURRENCY_LEVELS.some(l => r.byLevel.get(l) === undefined));
  if (missing.length > 0) {
    console.log(
      `  -- levels with no result count as 0: ${missing
        .map(r => `${r.provider} (${CONCURRENCY_LEVELS.filter(l => r.byLevel.get(l) === undefined).map(l => `c${l}`).join(', ')})`)
        .join('; ')}`,
    );
  }
  if (quotaLimited.size > 0) {
    console.log(`  *  capped by an account limit, not capacity: ${Array.from(quotaLimited).join(', ')}`);
  }
}

const runner = mergeMode === 'storage'
  ? mainStorage
  : mergeMode === 'snapshot-fork'
  ? mainSnapshotFork
  : mergeMode === 'browser'
  ? mainBrowser
  : mergeMode === 'browser-throughput'
  ? mainBrowserThroughput
  : mergeMode === 'browser-concurrent'
  ? mainBrowserConcurrent
  : mergeMode === 'ai-gateway'
  ? mainAIGateway
  : main;
runner().catch(err => {
  console.error('Merge failed:', err);
  process.exit(1);
});
