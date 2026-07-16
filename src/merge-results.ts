/**
 * Merge per-provider benchmark results into combined result files.
 *
 * Usage: tsx src/merge-results.ts --input <artifacts-dir> [--mode storage|snapshot-fork|browser|browser-throughput]
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
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeCompositeScores } from './sandbox/scoring.js';
import { computeStorageCompositeScores, sortStorageByCompositeScore } from './storage/scoring.js';
import { computeBrowserCompositeScores, sortBrowserByCompositeScore } from './browser/scoring.js';
import {
  computeThroughputCompositeScores,
  sortThroughputByCompositeScore,
} from './browser/throughput-scoring.js';
import { printResultsTable, writeResultsJson } from './sandbox/table.js';
import type { BenchmarkResult } from './sandbox/types.js';
import type { StorageBenchmarkResult } from './storage/types.js';
import type { SnapshotForkBenchmarkResult } from './storage/snapshot-fork-types.js';
import type { BrowserBenchmarkResult } from './browser/types.js';
import type { ThroughputBenchmarkResult } from './browser/throughput-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SANDBOX_WORKLOAD_DIRS = new Set([
  'sandbox-filesystem',
  'sandbox-git-clone',
  'sandbox-npm-install',
  'sandbox-resources',
  'sandbox-heavy-build',
]);

const args = process.argv.slice(2);
function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const inputDir = getArgValue('--input');
const mergeMode = getArgValue('--mode');
if (!inputDir) {
  console.error('Usage: tsx src/merge-results.ts --input <artifacts-dir> [--mode storage|snapshot-fork|browser|browser-throughput]');
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
    case 'sandbox-filesystem': return 'sandbox-filesystem';
    case 'sandbox-git-clone': return 'sandbox-git-clone';
    case 'sandbox-npm-install': return 'sandbox-npm-install';
    case 'sandbox-resources': return 'sandbox-resources';
    case 'sandbox-heavy-build': return 'sandbox-heavy-build';
    default: return `${mode}_tti`;
  }
}

/** Normalize mode name (concurrent -> burst) */
function normalizeMode(mode: string): string {
  switch (mode) {
    case 'sandbox-tti-sequential':
      return 'sequential';
    case 'sandbox-tti-staggered':
      return 'staggered';
    case 'concurrent':
    case 'sandbox-tti-burst':
      return 'burst';
    default:
      return mode;
  }
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

  // For each TTI mode, deduplicate by provider and compute scores
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
    const { writeStorageResultsJson } = await import('./storage/benchmark.js');
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

  const { computeSnapshotForkCompositeScores, writeSnapshotForkResultsJson } = await import('./storage/snapshot-fork-benchmark.js');

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
  const { writeBrowserResultsJson } = await import('./browser/benchmark.js');
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

  const { writeThroughputResultsJson } = await import('./browser/throughput-benchmark.js');
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(ROOT, 'results/browser-throughput');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeThroughputResultsJson(deduped, outPath);

  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

const runner = mergeMode === 'storage'
  ? mainStorage
  : mergeMode === 'snapshot-fork'
  ? mainSnapshotFork
  : mergeMode === 'browser'
  ? mainBrowser
  : mergeMode === 'browser-throughput'
  ? mainBrowserThroughput
  : main;
runner().catch(err => {
  console.error('Merge failed:', err);
  process.exit(1);
});
