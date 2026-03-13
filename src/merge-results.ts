/**
 * Merge per-provider benchmark results into combined result files.
 *
 * Usage: tsx src/merge-results.ts --input <artifacts-dir>
 *
 * Reads latest.json files from the input directory (one per provider per mode),
 * groups them by mode, merges results, computes composite scores, and writes
 * combined files to results/<mode>/latest.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeCompositeScores } from './scoring.js';
import { printResultsTable, writeResultsJson } from './table.js';
import type { BenchmarkResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const inputDir = getArgValue('--input');
if (!inputDir) {
  console.error('Usage: tsx src/merge-results.ts --input <artifacts-dir>');
  process.exit(1);
}

interface ResultFile {
  version: string;
  timestamp: string;
  environment: Record<string, any>;
  config: Record<string, any>;
  results: BenchmarkResult[];
}

/** Map mode to results subdirectory name, matching run.ts logic */
function modeToDir(mode: string): string {
  switch (mode) {
    case 'sequential': return 'sequential_tti';
    case 'staggered': return 'staggered_tti';
    case 'burst':
    case 'concurrent': return 'burst_tti';
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

  // Group results by mode
  const byMode: Record<string, { results: BenchmarkResult[]; meta: ResultFile }> = {};

  for (const file of jsonFiles) {
    const raw: ResultFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const result of raw.results) {
      // Determine mode from the directory name (e.g. sequential_tti, burst_tti)
      const dirName = path.basename(path.dirname(file));
      let mode = normalizeMode(result.mode || 'sequential');
      // Infer from directory name if available
      if (dirName.includes('sequential')) mode = 'sequential';
      else if (dirName.includes('staggered')) mode = 'staggered';
      else if (dirName.includes('burst')) mode = 'burst';

      if (!byMode[mode]) {
        byMode[mode] = { results: [], meta: raw };
      }
      byMode[mode].results.push(result);
    }
  }

  // For each mode, compute scores, print table, and write combined results
  for (const [mode, { results }] of Object.entries(byMode)) {
    console.log(`\nMerging ${results.length} provider results for mode: ${mode}`);

    // Compute composite scores across all providers
    computeCompositeScores(results);

    // Print the combined table
    printResultsTable(results);

    // Write combined results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const subDir = modeToDir(mode);
    const resultsDir = path.resolve(ROOT, `results/${subDir}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    const outPath = path.join(resultsDir, `${timestamp}.json`);
    await writeResultsJson(results, outPath);

    // Copy to latest.json
    const latestPath = path.join(resultsDir, 'latest.json');
    fs.copyFileSync(outPath, latestPath);
    console.log(`Copied latest: ${latestPath}`);
  }
}

main().catch(err => {
  console.error('Merge failed:', err);
  process.exit(1);
});
