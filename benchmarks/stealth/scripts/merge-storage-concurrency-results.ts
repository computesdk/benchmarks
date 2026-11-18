#!/usr/bin/env tsx
/**
 * Merge per-provider storage-concurrency benchmark artifacts into a single
 * `results/storage_concurrency/latest.json`.
 *
 * Usage: tsx benchmarks/stealth/scripts/merge-storage-concurrency-results.ts --input <artifacts-dir>
 *
 * Each `results-<provider>` artifact carries `results/storage_concurrency/latest.json`
 * with one provider entry; this merges them, re-sorts by composite score, and
 * stamps the combined file with the latest timestamp seen.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  StorageConcurrencyProviderResult,
  StorageConcurrencyResults,
} from '../storage/storage-concurrency-results.js';

const inputDir = process.argv.find((arg, i) => i > 0 && process.argv[i - 1] === '--input') || 'artifacts';
const outputPath = 'results/storage_concurrency/latest.json';

function findResultFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findResultFiles(fullPath));
    } else if (entry.isFile() && entry.name === 'latest.json' && fullPath.includes('storage_concurrency')) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = findResultFiles(inputDir);
if (files.length === 0) {
  console.log(`No storage_concurrency result files found under ${inputDir}; nothing to merge.`);
  process.exit(0);
}

const byProvider = new Map<string, StorageConcurrencyProviderResult>();
let environment: StorageConcurrencyResults['environment'] | undefined;
let runId = '';
let timestamp = '';

for (const file of files) {
  let data: StorageConcurrencyResults;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    console.warn(`Skipping invalid JSON: ${file}`);
    continue;
  }
  if (!Array.isArray(data.results)) continue;
  environment = data.environment ?? environment;
  runId = runId || data.runId;
  if (data.timestamp > timestamp) timestamp = data.timestamp;
  for (const result of data.results) {
    if (result && typeof result.provider === 'string') {
      byProvider.set(result.provider, result);
    }
  }
}

if (byProvider.size === 0) {
  console.log('No provider results found to merge.');
  process.exit(0);
}

const results = Array.from(byProvider.values()).sort((a, b) => {
  if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
  return a.provider.localeCompare(b.provider);
});

const merged: StorageConcurrencyResults = {
  version: '1.0',
  timestamp: timestamp || new Date().toISOString(),
  runId,
  environment: environment ?? { node: process.version, platform: process.platform, arch: process.arch },
  results,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`Merged ${results.length} provider(s) into ${outputPath}`);
