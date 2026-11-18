#!/usr/bin/env tsx
/**
 * Merge per-provider benchmark results downloaded as artifacts into a single
 * `results/<slug_snake>/latest.json`. The slug comes from BENCHMARK_SLUG
 * (set by the workflow env).
 */
import fs from 'node:fs';
import { recordResultArtifacts } from './util/results.js';
import path from 'node:path';

const inputDir = process.argv.find((arg, i) => i > 0 && process.argv[i - 1] === '--input') || 'artifacts';
const slug = process.env.BENCHMARK_SLUG;
if (!slug) {
  console.error('BENCHMARK_SLUG env var is required');
  process.exit(1);
}
const outputDir = `results/${slug.replace(/-/g, '_')}`;

function findResultFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findResultFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'latest.json') {
      files.push(fullPath);
    }
  }
  return files;
}

function merge(): void {
  if (!fs.existsSync(inputDir)) {
    console.log(`Input directory ${inputDir} does not exist; nothing to merge.`);
    return;
  }

  const files = findResultFiles(inputDir);
  const byProvider = new Map<string, any>();
  let environment: any;
  let config: any;
  let timestamp = new Date().toISOString();

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn(`Skipping invalid JSON: ${file}`);
      continue;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.results)) continue;

    environment = data.environment ?? environment;
    config = data.config ?? config;
    timestamp = data.timestamp ?? timestamp;

    for (const result of data.results) {
      if (result && typeof result.provider === 'string') {
        byProvider.set(result.provider, result);
      }
    }
  }

  if (byProvider.size === 0) {
    console.log('No provider results found to merge.');
    return;
  }

  const merged = {
    version: '1.0',
    timestamp,
    environment,
    config,
    results: Array.from(byProvider.values()).sort((a, b) => {
      const tierA = typeof a.compositeScore === 'number' ? a.compositeScore : -1;
      const tierB = typeof b.compositeScore === 'number' ? b.compositeScore : -1;
      if (tierB !== tierA) return tierB - tierA;
      const totalA = a.summary?.totalMs?.median ?? Infinity;
      const totalB = b.summary?.totalMs?.median ?? Infinity;
      if (totalA !== totalB) return totalA - totalB;
      return a.provider.localeCompare(b.provider);
    }),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const latestPath = path.join(outputDir, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(merged, null, 2));
  recordResultArtifacts([latestPath]);
  console.log(`Merged ${byProvider.size} provider(s) into ${latestPath}`);

  // Coverage gate: when the workflow supplies the expected provider set
  // (EXPECTED_PROVIDERS as JSON array or comma list), report which providers
  // produced no merged result so the collect job can skip publishing a
  // partial latest.json.
  const expectedEnv = process.env.EXPECTED_PROVIDERS?.trim();
  if (expectedEnv) {
    let expected: string[] = [];
    try {
      const parsed = JSON.parse(expectedEnv);
      if (Array.isArray(parsed)) expected = parsed.filter((p): p is string => typeof p === 'string');
    } catch {
      expected = expectedEnv.split(',').map((p) => p.trim()).filter(Boolean);
    }
    const missing = expected.filter((p) => !byProvider.has(p));
    console.log(`Coverage: ${byProvider.size}/${expected.length} expected providers`);
    if (missing.length > 0) {
      console.warn(`::warning::Missing results for ${missing.length} provider(s): ${missing.join(', ')}`);
    }
    const outFile = process.env.GITHUB_OUTPUT;
    if (outFile) {
      fs.appendFileSync(outFile, `expected=${expected.length}\ncoverage=${byProvider.size}\nmissing=${missing.join(',')}\n`);
    }
  }
}

merge();
