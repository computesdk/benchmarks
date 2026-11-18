import fs from 'node:fs';
import { recordResultArtifacts } from '../src/util/results.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, SUITE_CONFIG, writeCpuBurstResultsJson } from '../sandbox/sandbox-cpu-burst.js';
import type { CpuBurstBenchmarkResult, CpuBurstSuiteStats } from '../sandbox/sandbox-cpu-burst.js';
import { printResultsTable } from '../sandbox/sandbox-cpu-burst-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const args = process.argv.slice(2);
function getArgValue(flag: string, fallback?: string): string | undefined {
  let value = fallback;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) value = args[i + 1];
  }
  return value;
}

const inputDir = getArgValue('--input', 'artifacts');

interface ResultFile {
  version: string;
  timestamp: string;
  environment: Record<string, any>;
  config: Record<string, any>;
  results: any[];
}

/**
 * Normalize a parsed result into the runtime CpuBurstBenchmarkResult shape.
 * Accepts either the runtime shape (summary has median/successRate/meta) or
 * the serialized shape (summary.burstHeadroom + top-level successRate/meta).
 */
function asCpuBurstBenchmarkResult(raw: any): CpuBurstBenchmarkResult | undefined {
  if (!raw || typeof raw !== 'object' || raw.suite !== 'cpu-burst') return undefined;

  const meta = raw.meta ?? {};
  const summary = raw.summary ?? {};
  const burstHeadroom = summary.burstHeadroom ?? {};

  const stats: CpuBurstSuiteStats = {
    median: typeof summary.median === 'number' ? summary.median : (burstHeadroom.median ?? 0),
    p95: typeof summary.p95 === 'number' ? summary.p95 : (burstHeadroom.p95 ?? 0),
    p99: typeof summary.p99 === 'number' ? summary.p99 : (burstHeadroom.p99 ?? 0),
    min: typeof summary.min === 'number' ? summary.min : (burstHeadroom.min ?? 0),
    max: typeof summary.max === 'number' ? summary.max : (burstHeadroom.max ?? 0),
    successRate: typeof summary.successRate === 'number' ? summary.successRate : (raw.successRate ?? 0),
    n: typeof summary.n === 'number' ? summary.n : (raw.n ?? 0),
    scoreBeforeReliability:
      typeof summary.scoreBeforeReliability === 'number'
        ? summary.scoreBeforeReliability
        : (raw.scoreBeforeReliability ?? 0),
    compositeScore:
      typeof summary.compositeScore === 'number'
        ? summary.compositeScore
        : (raw.compositeScore ?? 0),
    meta: summary.meta ?? meta,
  };

  return {
    provider: raw.provider,
    suite: raw.suite,
    mode: raw.mode ?? 'cpu-burst',
    iterations: Array.isArray(raw.iterations) ? raw.iterations : [],
    summary: stats,
    wallClockMs: typeof raw.wallClockMs === 'number' ? raw.wallClockMs : 0,
    replicateMs: Array.isArray(raw.replicateMs) ? raw.replicateMs : [],
    compositeScore: typeof raw.compositeScore === 'number' ? raw.compositeScore : 0,
    meta,
    skipped: raw.skipped,
    skipReason: raw.skipReason,
  };
}

async function main() {
  if (!inputDir) {
    console.error('Usage: tsx benchmarks/stealth/scripts/merge-sandbox-cpu-burst-results.ts --input <artifacts-dir>');
    process.exit(1);
  }

  const jsonFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'latest.json') jsonFiles.push(full);
    }
  }
  walk(inputDir);

  if (jsonFiles.length === 0) {
    console.error(`No latest.json files found in ${path.resolve(inputDir)}`);
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} result file(s) in ${path.resolve(inputDir)}`);

  const entries: { result: CpuBurstBenchmarkResult; fromSingleProvider: boolean }[] = [];

  for (const file of jsonFiles) {
    const raw: ResultFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw.results)) continue;

    const fromSingleProvider = raw.results.length === 1;

    for (const item of raw.results) {
      const result = asCpuBurstBenchmarkResult(item);
      if (!result) continue;
      entries.push({ result, fromSingleProvider });
    }
  }

  if (entries.length === 0) {
    console.error('No cpu-burst results found in any latest.json file.');
    process.exit(1);
  }

  const seen = new Map<string, { result: CpuBurstBenchmarkResult; fromSingleProvider: boolean }>();
  for (const entry of entries) {
    const existing = seen.get(entry.result.provider);
    if (!existing || (entry.fromSingleProvider && !existing.fromSingleProvider)) {
      seen.set(entry.result.provider, entry);
    }
  }

  const deduped = Array.from(seen.values()).map((e) => e.result);
  for (const result of deduped) {
    // Historical artifacts have no original status evidence: preserve their
    // saved score. Future artifacts always carry status in every iteration.
    if (result.iterations.length && result.iterations.every(r => typeof r.meta.taskStatus === 'string')) {
      result.summary = computeStats(result.iterations, SUITE_CONFIG);
      result.compositeScore = result.summary.compositeScore;
    }
  }

  if (deduped.length !== entries.length) {
    console.log(`\nMerging ${deduped.length} provider results (deduplicated from ${entries.length})`);
  } else {
    console.log(`\nMerging ${deduped.length} provider results`);
  }

  printResultsTable(deduped);

  const resultsDir = path.resolve(ROOT, 'results/sandbox_cpu_burst');
  fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeCpuBurstResultsJson(deduped, outPath);

  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  recordResultArtifacts([latestPath]);
  console.log(`Copied latest: ${latestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
