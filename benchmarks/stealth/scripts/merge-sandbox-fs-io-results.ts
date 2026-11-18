#!/usr/bin/env tsx
/**
 * Merge per-provider sandbox-fs-io benchmark results downloaded as artifacts into
 * per-mode `results/sandbox_fs_io/<mode>/latest.json` files plus a combined
 * `results/sandbox_fs_io/latest.json` with all modes' records per provider.
 */
import fs from 'node:fs';
import { recordResultArtifacts } from '../src/util/results.js';
import path from 'node:path';
import {
  computeFsIoStats,
  writeFsIoResultsJson,
  SUITE_CONFIG,
  MODES,
} from '../sandbox/sandbox-fs-io.js';
import type {
  FsIoBenchmarkResult,
  FsIoMode,
  FsIoWorkloadResult,
} from '../sandbox/sandbox-fs-io.js';

const inputDir = process.argv.find((arg, i) => i > 0 && process.argv[i - 1] === '--input') || 'artifacts';
const outputDir = 'results/sandbox_fs_io';
const artifactPaths: string[] = [];

/** Result files live under sandbox_fs_io/<mode>/ in each provider artifact. */
function modeFromPath(file: string): FsIoMode | undefined {
  const rel = file.split(path.sep).join('/');
  const match = /sandbox_fs_io\/([^/]+)\/[^/]+\.json$/.exec(rel);
  const mode = match?.[1];
  return (MODES as readonly string[]).includes(mode ?? '') ? (mode as FsIoMode) : undefined;
}

function findResultFiles(dir: string): { mode: FsIoMode; file: string }[] {
  const files: { mode: FsIoMode; file: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findResultFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'latest.json') {
      const mode = modeFromPath(fullPath);
      if (mode) files.push({ mode, file: fullPath });
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
  const byMode = new Map<FsIoMode, Map<string, any>>();
  let environment: any;
  let config: any;
  let timestamp = new Date().toISOString();

  for (const { mode, file } of files) {
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

    const providers = byMode.get(mode) ?? new Map<string, any>();
    for (const result of data.results) {
      if (result && typeof result.provider === 'string') {
        providers.set(result.provider, result);
      }
    }
    byMode.set(mode, providers);
  }

  if (byMode.size === 0) {
    console.log('No provider results found to merge.');
    return;
  }

  // Per-mode merged files.
  for (const [mode, byProvider] of byMode) {
    const merged = {
      version: '1.0',
      timestamp,
      environment,
      config,
      suite: SUITE_CONFIG.id,
      mode,
      results: sortByScore(Array.from(byProvider.values())),
    };
    const dir = path.join(outputDir, mode);
    fs.mkdirSync(dir, { recursive: true });
    const latestPath = path.join(dir, 'latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(merged, null, 2));
    artifactPaths.push(latestPath);
    console.log(`Merged ${byProvider.size} provider(s) into ${latestPath}`);
  }

  // Combined file: concatenate each provider's per-mode records and rescore
  // across all mode groups so the run-wide composite prices every mode.
  const combined = new Map<string, FsIoBenchmarkResult>();
  for (const byProvider of byMode.values()) {
    for (const r of byProvider.values()) {
      const existing = combined.get(r.provider);
      const iterations = (r.iterations ?? []) as FsIoWorkloadResult[];
      if (!existing) {
        combined.set(r.provider, {
          provider: r.provider,
          suite: SUITE_CONFIG.id,
          mode: r.mode,
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
    r.summary = computeFsIoStats(r.iterations);
    r.compositeScore = r.summary.compositeScore;
    if (r.iterations.length === 0) {
      r.skipped = true;
      r.skipReason = r.skipReason ?? 'no records';
    }
  }
  const combinedResults = sortByScore(
    Array.from(combined.values()),
  ) as FsIoBenchmarkResult[];
  fs.mkdirSync(outputDir, { recursive: true });
  await writeFsIoResultsJson(
    combinedResults,
    path.join(outputDir, 'latest.json'),
    'combined',
  );
  console.log(`Combined ${combinedResults.length} provider(s) into ${path.join(outputDir, 'latest.json')}`);
  recordResultArtifacts([...artifactPaths, path.join(outputDir, 'latest.json')]);
}

merge();
