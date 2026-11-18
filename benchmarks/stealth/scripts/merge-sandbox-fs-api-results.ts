#!/usr/bin/env tsx
/**
 * Merge per-provider sandbox-fs-api benchmark results downloaded as
 * artifacts into per-size `results/sandbox_fs_api/<size>/latest.json`
 * files plus a combined `results/sandbox_fs_api/latest.json` with all
 * sizes' records per provider.
 */
import fs from 'node:fs';
import { recordResultArtifacts } from '../src/util/results.js';
import path from 'node:path';
import {
  computeSandboxFilesystemStats,
  writeSandboxFilesystemResultsJson,
  SUITE_CONFIG,
} from '../sandbox/sandbox-fs-api.js';
import type {
  SandboxFilesystemBenchmarkResult,
  SandboxFilesystemWorkloadResult,
} from '../sandbox/sandbox-fs-api.js';

const inputDir = process.argv.find((arg, i) => i > 0 && process.argv[i - 1] === '--input') || 'artifacts';
const outputDir = 'results/sandbox_fs_api';
const artifactPaths: string[] = [];

interface ResultFile {
  provider: string;
  timestamp: string;
  results: any[];
}

/** Result files live under sandbox_fs_api/<size>/ in each provider artifact. */
function sizeFromPath(file: string): string | undefined {
  const rel = file.split(path.sep).join('/');
  const match = /sandbox_fs_api\/([^/]+)\/[^/]+\.json$/.exec(rel);
  return match?.[1];
}

function findResultFiles(dir: string): { size: string; file: string }[] {
  const files: { size: string; file: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findResultFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'latest.json') {
      const size = sizeFromPath(fullPath);
      if (size) files.push({ size, file: fullPath });
    }
  }
  return files;
}

function sortByScore(results: any[]): any[] {
  return results.sort((a, b) => {
    const tierA = typeof a.compositeScore === 'number' ? a.compositeScore : -1;
    const tierB = typeof b.compositeScore === 'number' ? b.compositeScore : -1;
    if (tierB !== tierA) return tierB - tierA;
    return a.provider.localeCompare(b.provider);
  });
}

async function merge(): Promise<void> {
  if (!fs.existsSync(inputDir)) {
    console.log(`Input directory ${inputDir} does not exist; nothing to merge.`);
    return;
  }

  const files = findResultFiles(inputDir);
  const bySize = new Map<string, Map<string, any>>();
  let environment: any;
  let config: any;
  let timestamp = new Date().toISOString();

  for (const { size, file } of files) {
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

    const providers = bySize.get(size) ?? new Map<string, any>();
    for (const result of data.results) {
      if (result && typeof result.provider === 'string') {
        providers.set(result.provider, result);
      }
    }
    bySize.set(size, providers);
  }

  if (bySize.size === 0) {
    console.log('No provider results found to merge.');
    return;
  }

  // Per-size merged files.
  for (const [size, byProvider] of bySize) {
    const merged = {
      version: '1.0',
      timestamp,
      environment,
      config,
      fileSize: size,
      results: sortByScore(Array.from(byProvider.values())),
    };
    const dir = path.join(outputDir, size);
    fs.mkdirSync(dir, { recursive: true });
    const latestPath = path.join(dir, 'latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(merged, null, 2));
    artifactPaths.push(latestPath);
    console.log(`Merged ${byProvider.size} provider(s) into ${latestPath}`);
  }

  // Combined file: concatenate each provider's per-size records and rescore
  // across all size groups so the run-wide composite prices every size.
  const combined = new Map<string, SandboxFilesystemBenchmarkResult>();
  for (const byProvider of bySize.values()) {
    for (const r of byProvider.values()) {
      const existing = combined.get(r.provider);
      const iterations = (r.iterations ?? []) as SandboxFilesystemWorkloadResult[];
      if (!existing) {
        combined.set(r.provider, {
          provider: r.provider,
          suite: SUITE_CONFIG.id,
          mode: 'sandbox-fs-api',
          iterations: [...iterations],
          summary: undefined as any,
          wallClockMs: r.wallClockMs ?? 0,
          replicateMs: r.replicateMs ?? [],
          compositeScore: 0,
          skipped: r.skipped,
          skipReason: r.skipReason,
        });
      } else {
        existing.iterations.push(...iterations);
        existing.wallClockMs += r.wallClockMs ?? 0;
        existing.replicateMs.push(...(r.replicateMs ?? []));
      }
    }
  }
  for (const r of combined.values()) {
    r.summary = computeSandboxFilesystemStats(r.iterations);
    r.compositeScore = r.summary.compositeScore;
    if (r.iterations.length === 0) {
      r.skipped = true;
      r.skipReason = r.skipReason ?? 'no records';
    }
  }
  const combinedResults = sortByScore(
    Array.from(combined.values()),
  ) as SandboxFilesystemBenchmarkResult[];
  fs.mkdirSync(outputDir, { recursive: true });
  await writeSandboxFilesystemResultsJson(
    combinedResults,
    path.join(outputDir, 'latest.json'),
  );
  console.log(`Combined ${combinedResults.length} provider(s) into ${path.join(outputDir, 'latest.json')}`);
  recordResultArtifacts([...artifactPaths, path.join(outputDir, 'latest.json')]);
}

merge();
