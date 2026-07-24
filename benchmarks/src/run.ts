// Load .env before any other imports so env vars are available at module evaluation time
import './env.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBenchmark } from '../sandbox/benchmark.js';
import { runConcurrentBenchmark } from '../sandbox/concurrent.js';
import { runStaggeredBenchmark } from '../sandbox/staggered.js';
import { runDaxBenchmark, writeDaxResultsJson } from '../sandbox/dax.js';
import { runStorageBenchmark, writeStorageResultsJson } from '../storage/benchmark.js';
import {
  runSnapshotForkBenchmark,
  writeSnapshotForkResultsJson,
  computeSnapshotForkCompositeScores,
} from '../storage/snapshot-fork-benchmark.js';
import { runBrowserBenchmark, writeBrowserResultsJson } from '../browser/benchmark.js';
import {
  emptySummary,
  navUrlForIteration,
  runThroughputBenchmark,
  runThroughputIteration,
  summarizeIterations,
  writeThroughputResultsJson,
} from '../browser/throughput-benchmark.js';
import { runAIGatewayBenchmarks, writeAIGatewayResultsJson } from '../ai-gateway/benchmark.js';
import { printResultsTable, writeResultsJson } from '../sandbox/table.js';
import { providers } from '../sandbox/providers.js';
import { storageProviders } from '../storage/providers.js';
import { browserProviders } from '../browser/providers.js';
import { throughputProviders } from '../browser/throughput-providers.js';
import { providers as aiGatewayProviders } from '../ai-gateway/providers.js';
import { computeCompositeScores } from '../sandbox/scoring.js';
import { computeStorageCompositeScores } from '../storage/scoring.js';
import { computeBrowserCompositeScores } from '../browser/scoring.js';
import { computeThroughputCompositeScores } from '../browser/throughput-scoring.js';
import { computeAIGatewayCompositeScores } from '../ai-gateway/scoring.js';
import type { BenchmarkResult, BenchmarkMode } from '../sandbox/types.js';
import type { StorageBenchmarkResult } from '../storage/types.js';
import type { SnapshotForkBenchmarkResult } from '../storage/snapshot-fork-types.js';
import type { DatasetPreset } from '../storage/snapshot-fork-types.js';
import type { BrowserBenchmarkResult } from '../browser/types.js';
import { ACTIONS_PER_SESSION } from '../browser/throughput-types.js';
import type { ThroughputBenchmarkResult, ThroughputTimingResult } from '../browser/throughput-types.js';
import type { AIGatewayBenchmarkResult } from '../ai-gateway/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);
const providerFilter = getArgValue(args, '--provider');
const iterationsArg = getArgValue(args, '--iterations');
const iterations = parseInt(iterationsArg || '100', 10);
const rawMode = getArgValue(args, '--mode');
const concurrency = parseInt(getArgValue(args, '--concurrency') || '100', 10);
const storageConcurrency = parseInt(getArgValue(args, '--storage-concurrency') || '1', 10);
const staggerDelay = parseInt(getArgValue(args, '--stagger-delay') || '200', 10);
const fileSizeArg = getArgValue(args, '--file-size') || '10MB';
const datasetArg = getArgValue(args, '--dataset') || 'small';
// Like snapshot-fork/browser-throughput: defaults to a smaller, mode-specific
// count (these hit real paid gateway APIs), but --iterations overrides both
// cold and warm at once if passed. --ai-gateway-iterations-cold/-warm are
// only needed for an asymmetric split. Iterations run round-robin across
// every active gateway (see runAIGatewayBenchmarks) rather than finishing
// one gateway before starting the next — that only makes an observable
// difference when more than one gateway is active at once.
const aiGatewayDefaultIterations = iterationsArg ? iterations : 10;
const aiGatewayIterationsCold = parseInt(getArgValue(args, '--ai-gateway-iterations-cold') || String(aiGatewayDefaultIterations), 10);
const aiGatewayIterationsWarm = parseInt(getArgValue(args, '--ai-gateway-iterations-warm') || String(aiGatewayDefaultIterations), 10);
const AI_GATEWAY_PROMPT = 'Write a two-sentence description of how distributed systems handle partial failures.';
const AI_GATEWAY_MAX_TOKENS = 200;
const AI_GATEWAY_TIMEOUT_MS = 45_000;

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** Resolve which modes to run */
function getModesToRun(): BenchmarkMode[] | ['storage'] | ['snapshot-fork'] | ['browser'] | ['browser-throughput'] | ['sandbox-dax'] | ['ai-gateway'] {
  if (!rawMode) return ['sequential', 'staggered', 'burst'];
  if (rawMode === 'storage') return ['storage'];
  if (rawMode === 'snapshot-fork') return ['snapshot-fork'];
  if (rawMode === 'browser') return ['browser'];
  if (rawMode === 'browser-throughput') return ['browser-throughput'];
  if (rawMode === 'sandbox-dax') return ['sandbox-dax'];
  if (rawMode === 'ai-gateway') return ['ai-gateway'];
  const m = rawMode === 'concurrent' ? 'burst' : rawMode as BenchmarkMode;
  return [m];
}

/** Map mode to results subdirectory name */
function modeToDir(m: BenchmarkMode | 'storage' | 'snapshot-fork' | 'browser-throughput' | 'sandbox-dax' | 'ai-gateway'): string {
  switch (m) {
    case 'sequential': return 'sequential_tti';
    case 'staggered': return 'staggered_tti';
    case 'burst':
    case 'concurrent': return 'burst_tti';
    case 'storage': return 'storage';
    case 'snapshot-fork': return 'snapshot-fork';
    case 'browser-throughput': return 'browser-throughput';
    case 'sandbox-dax': return 'sandbox-dax';
    case 'ai-gateway': return 'ai-gateway';
    default: return `${m}_tti`;
  }
}

async function runMode(mode: BenchmarkMode, toRun: typeof providers): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log(`  MODE: ${mode.toUpperCase()}`);
  if (mode === 'sequential') {
    console.log(`  Iterations per provider: ${iterations}`);
  } else {
    console.log(`  Concurrency: ${concurrency} sandboxes`);
    if (mode === 'staggered') {
      console.log(`  Stagger delay: ${staggerDelay}ms`);
    }
  }
  console.log('='.repeat(70));

  const results: BenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    switch (mode) {
      case 'sequential': {
        const result = await runBenchmark({ ...providerConfig, iterations });
        results.push(result);
        break;
      }
      case 'staggered': {
        const result = await runStaggeredBenchmark({
          ...providerConfig,
          concurrency,
          staggerDelayMs: staggerDelay,
        });
        results.push(result);
        break;
      }
      case 'burst':
      case 'concurrent': {
        const result = await runConcurrentBenchmark({ ...providerConfig, concurrency });
        results.push(result);
        break;
      }
    }
  }

  // Compute composite scores
  computeCompositeScores(results);

  // Print comparison table
  printResultsTable(results);

  // Write JSON results to mode-specific subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir(mode);
  const resultsDir = path.resolve(__dirname, `../../results/${subDir}`);
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runStorage(toRun: typeof storageProviders, fileSizeLabel: string): Promise<void> {
  const { FILE_SIZE_BYTES } = await import('../storage/types.js');
  const validSizes = Object.keys(FILE_SIZE_BYTES);
  if (!(fileSizeLabel in FILE_SIZE_BYTES)) {
    console.error(`Invalid --file-size "${fileSizeLabel}". Valid sizes: ${validSizes.join(', ')}`);
    process.exit(1);
  }
  const fileSizeBytes = FILE_SIZE_BYTES[fileSizeLabel as keyof typeof FILE_SIZE_BYTES];

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: STORAGE');
  console.log(`  File size: ${fileSizeLabel}`);
  console.log(`  Iterations per provider: ${iterations}`);
  console.log(`  Concurrency per provider: ${storageConcurrency}`);
  console.log('='.repeat(70));

  const results: StorageBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    const result = await runStorageBenchmark({ ...providerConfig, iterations, concurrency: storageConcurrency }, fileSizeBytes);
    results.push(result);
  }

  // Compute composite scores
  computeStorageCompositeScores(results);

  // Print comparison table (TODO: add storage-specific table printer)
  console.log('\n--- Storage Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Download: ${(r.summary.downloadMs.median / 1000).toFixed(2)}s (median), ${r.summary.throughputMbps.median.toFixed(2)} Mbps`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to storage subdirectory with file size
  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir('storage');
  const sizeDir = path.resolve(__dirname, `../../results/${subDir}/${fileSizeLabel.toLowerCase()}`);
  fs.mkdirSync(sizeDir, { recursive: true });

  const outPath = path.join(sizeDir, `${timestamp}.json`);
  await writeStorageResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(sizeDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runSnapshotFork(toRun: typeof storageProviders, datasetLabel: string): Promise<void> {
  const { DATASET_PRESETS } = await import('../storage/snapshot-fork-types.js');
  const validDatasets = Object.keys(DATASET_PRESETS);
  if (!(datasetLabel in DATASET_PRESETS)) {
    console.error(`Invalid --dataset "${datasetLabel}". Valid datasets: ${validDatasets.join(', ')}`);
    process.exit(1);
  }
  const dataset = datasetLabel as DatasetPreset;
  const spec = DATASET_PRESETS[dataset];

  // Each iteration seeds real objects and creates real snapshots/forks, so this
  // mode is far more expensive than the upload/download benchmark. Default to a
  // small count unless the user explicitly overrode --iterations.
  const sfIterations = iterationsArg ? iterations : 10;

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: SNAPSHOT-FORK');
  console.log(`  Dataset: ${dataset} (${spec.objectCount} × ${(spec.objectSizeBytes / 1024 / 1024).toFixed(0)}MB)`);
  console.log(`  Iterations per provider: ${sfIterations}`);
  console.log('='.repeat(70));

  const results: SnapshotForkBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    // Some providers need a different bucket/credentials for snapshot-fork than
    // for upload/download (e.g. Tigris's snapshot-enabled bucket); apply it here.
    const { snapshotFork, ...base } = providerConfig;
    const config = snapshotFork ? { ...base, ...snapshotFork } : base;
    const result = await runSnapshotForkBenchmark({ ...config, iterations: sfIterations }, dataset);
    results.push(result);
  }

  computeSnapshotForkCompositeScores(results);

  console.log('\n--- Snapshot/Fork Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error && i.verified).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Snapshot create: ${(r.summary.snapshotCreateMs.median / 1000).toFixed(2)}s (median)`);
    console.log(`  Fork from snapshot: ${(r.summary.forkFromSnapshotMs.median / 1000).toFixed(2)}s (median)`);
    console.log(`  Fork from live: ${(r.summary.forkFromLiveMs.median / 1000).toFixed(2)}s (median)`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir('snapshot-fork');
  const datasetDir = path.resolve(__dirname, `../../results/${subDir}/${dataset}`);
  fs.mkdirSync(datasetDir, { recursive: true });

  const outPath = path.join(datasetDir, `${timestamp}.json`);
  await writeSnapshotForkResultsJson(results, outPath);

  const latestPath = path.join(datasetDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runBrowser(toRun: typeof browserProviders): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('  MODE: BROWSER');
  console.log(`  Iterations per provider: ${iterations}`);
  console.log('='.repeat(70));

  const results: BrowserBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    const result = await runBrowserBenchmark({ ...providerConfig, iterations });
    results.push(result);
  }

  // Compute composite scores
  computeBrowserCompositeScores(results);

  // Print summary
  console.log('\n--- Browser Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Total: ${(r.summary.totalMs.median / 1000).toFixed(2)}s (median) — create ${(r.summary.createMs.median / 1000).toFixed(2)}s + connect ${(r.summary.connectMs.median / 1000).toFixed(2)}s + navigate ${(r.summary.navigateMs.median / 1000).toFixed(2)}s + release ${(r.summary.releaseMs.median / 1000).toFixed(2)}s`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to browser subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, '../../results/browser');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  const timeoutMs = toRun.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
  await writeBrowserResultsJson(results, outPath, { timeoutMs });

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runBrowserThroughput(toRun: typeof throughputProviders): Promise<void> {
  // Only override when --iterations was explicitly passed; otherwise let
  // runThroughputBenchmark apply its own default (100 sessions per provider).
  const throughputIterations = iterationsArg ? iterations : undefined;
  const iterationsToRun = throughputIterations ?? 100;

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: BROWSER THROUGHPUT');
  console.log(`  Iterations per provider: ${iterationsToRun}`);
  console.log('='.repeat(70));

  const results: ThroughputBenchmarkResult[] = [];

  if (providerFilter || toRun.length === 1) {
    for (const providerConfig of toRun) {
      const result = await runThroughputBenchmark(
        throughputIterations !== undefined
          ? { ...providerConfig, iterations: throughputIterations }
          : providerConfig,
      );
      results.push(result);
    }
  } else {
    const resultByProvider = new Map<string, ThroughputBenchmarkResult>();
    const active: Array<{
      name: string;
      provider: any;
      timeout: number;
      sessionCreateOptions: Record<string, unknown>;
      iterations: ThroughputTimingResult[];
    }> = [];

    for (const providerConfig of toRun) {
      const missingVars = providerConfig.requiredEnvVars.filter(v => !process.env[v]);
      if (missingVars.length > 0) {
        resultByProvider.set(providerConfig.name, {
          provider: providerConfig.name,
          mode: 'browser-throughput',
          iterations: [],
          summary: emptySummary(),
          skipped: true,
          skipReason: `Missing: ${missingVars.join(', ')}`,
        });
        continue;
      }

      active.push({
        name: providerConfig.name,
        provider: providerConfig.createBrowserProvider(),
        timeout: providerConfig.timeout ?? 120_000,
        sessionCreateOptions: providerConfig.sessionCreateOptions ?? {},
        iterations: [],
      });
    }

    console.log(`\n--- Interleaved Throughput Benchmark (${iterationsToRun} rounds × ${active.length} providers) ---`);
    console.log('Provider      Sess  Create   Connect  Task     Release  Total    APS    Actions');
    console.log('────────────  ────  ───────  ───────  ───────  ───────  ───────  ─────  ───────');

    for (let i = 0; i < iterationsToRun; i++) {
      // Same URL for every provider in this round; different URL each round.
      const navigateUrl = navUrlForIteration(i);
      for (const state of active) {
        const result = await runThroughputIteration(state.provider, state.timeout, state.sessionCreateOptions, navigateUrl);
        state.iterations.push(result);

        const pad = (n: number) => `${Math.round(n)}ms`.padStart(7);
        const aps = result.actionsPerSecond.toFixed(1).padStart(5);
        const status = `${result.actionsCompleted}/50`;
        const errSuffix = result.error ? `  ✗ ${result.error.slice(0, 50)}` : '';
        console.log(
          `${state.name.padEnd(12)}  ${String(i + 1).padStart(4)}  ${pad(result.createMs)}  ${pad(result.connectMs)}  ${pad(result.taskMs)}  ${pad(result.releaseMs)}  ${pad(result.totalMs)}  ${aps}  ${status}${errSuffix}`,
        );
      }
    }

    for (const state of active) {
      resultByProvider.set(state.name, {
        provider: state.name,
        mode: 'browser-throughput',
        iterations: state.iterations,
        summary: summarizeIterations(state.iterations),
      });
    }

    for (const providerConfig of toRun) {
      const result = resultByProvider.get(providerConfig.name);
      if (result) results.push(result);
    }
  }

  // Compute composite scores
  computeThroughputCompositeScores(results);

  // Print summary
  console.log('\n--- Browser Throughput Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const fullSuccess = r.iterations.filter(i => !i.error && i.actionsCompleted === ACTIONS_PER_SESSION).length;
    const total = r.iterations.length;
    const aps = r.summary.actionsPerSecond.median;
    const taskMed = r.summary.taskMs.median;
    const screenshotMed = r.summary.perActionType.screenshot?.median ?? 0;
    console.log(`${r.provider}:`);
    console.log(`  APS: ${aps.toFixed(2)}/s (median) — task ${(taskMed / 1000).toFixed(2)}s, screenshot ${Math.round(screenshotMed)}ms`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${fullSuccess}/${total} OK)`);
  }

  // Write JSON results to browser-throughput subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, '../../results/browser-throughput');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  const timeoutMs = toRun.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
  await writeThroughputResultsJson(results, outPath, { timeoutMs });

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runSandboxDax(toRun: typeof providers): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('  MODE: SANDBOX DAX');
  console.log(`  Iterations per provider: ${iterations}`);
  console.log('='.repeat(70));

  const results = [];

  for (const providerConfig of toRun) {
    const result = await runDaxBenchmark({ ...providerConfig, iterations });
    results.push(result);
  }

  console.log('\n--- Sandbox Dax Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    const latest = [...r.iterations].reverse().find(i => i.phasesCompleted != null);
    const phaseScore = latest ? `${latest.phasesCompleted}/${latest.phasesTotal}` : '--';
    console.log(`${r.provider}: ${phaseScore} phases | total ${(r.summary.totalMs.median / 1000).toFixed(2)}s | prepare ${(r.summary.prepareMs.median / 1000).toFixed(2)}s | clone ${(r.summary.cloneMs.median / 1000).toFixed(2)}s | install ${(r.summary.installMs.median / 1000).toFixed(2)}s | typecheck ${(r.summary.typecheckMs.median / 1000).toFixed(2)}s (${ok}/${total} OK)`);
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, `../../results/${modeToDir('sandbox-dax')}`);
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeDaxResultsJson(results, outPath);
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runAIGateway(toRun: typeof aiGatewayProviders): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('  MODE: AI GATEWAY');
  console.log(`  Cold iterations: ${aiGatewayIterationsCold}, Warm iterations: ${aiGatewayIterationsWarm} (round-robin across gateways)`);
  console.log('='.repeat(70));

  const results: AIGatewayBenchmarkResult[] = await runAIGatewayBenchmarks(toRun, {
    iterationsCold: aiGatewayIterationsCold,
    iterationsWarm: aiGatewayIterationsWarm,
    prompt: AI_GATEWAY_PROMPT,
    maxTokens: AI_GATEWAY_MAX_TOKENS,
    timeout: AI_GATEWAY_TIMEOUT_MS,
  });

  // Compute composite scores
  computeAIGatewayCompositeScores(results);

  // Print summary
  console.log('\n--- AI Gateway Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Cold E2E TTFT: ${r.summary.coldE2eMs.median.toFixed(0)}ms (median), Warm TTFT: ${r.summary.warmTtftMs.median.toFixed(0)}ms (median), ${r.summary.outputTokensPerSec.median.toFixed(1)} tok/s`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to ai-gateway subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, `../../results/${modeToDir('ai-gateway')}`);
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeAIGatewayResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function main() {
  const modes = getModesToRun();

  // Handle ai-gateway mode separately
  if (modes[0] === 'ai-gateway') {
    console.log('ComputeSDK AI Gateway Benchmarks');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const toRun = providerFilter
      ? aiGatewayProviders.filter(p => p.name === providerFilter)
      : aiGatewayProviders;

    if (toRun.length === 0) {
      console.error(`Unknown AI gateway provider: ${providerFilter}`);
      console.error(`Available: ${aiGatewayProviders.map(p => p.name).join(', ')}`);
      process.exit(1);
    }

    await runAIGateway(toRun);
    console.log('\nAll AI gateway tests complete.');
    return;
  }

  // Handle browser-throughput mode separately
  if (modes[0] === 'browser-throughput') {
    console.log('ComputeSDK Browser Throughput Benchmarks');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const toRun = providerFilter
      ? throughputProviders.filter(p => p.name === providerFilter)
      : throughputProviders;

    if (toRun.length === 0) {
      if (providerFilter) {
        console.error(`Unknown browser-throughput provider: ${providerFilter}`);
        console.error(`Available: ${throughputProviders.map(p => p.name).join(', ')}`);
      } else {
        console.error('No browser-throughput providers configured. Add entries to src/browser/throughput-providers.ts.');
      }
      process.exit(1);
    }

    await runBrowserThroughput(toRun);
    console.log('\nAll browser-throughput tests complete.');
    return;
  }

  // Handle browser mode separately
  if (modes[0] === 'browser') {
    console.log('ComputeSDK Browser Provider Benchmarks');
    console.log(`Date: ${new Date().toISOString()}\n`);

    // Filter browser providers
    const toRun = providerFilter
      ? browserProviders.filter(p => p.name === providerFilter)
      : browserProviders;

    if (toRun.length === 0) {
      if (providerFilter) {
        console.error(`Unknown browser provider: ${providerFilter}`);
        console.error(`Available: ${browserProviders.map(p => p.name).join(', ')}`);
      } else {
        console.error('No browser providers configured. Add entries to src/browser/providers.ts.');
      }
      process.exit(1);
    }

    await runBrowser(toRun);
    console.log('\nAll browser tests complete.');
    return;
  }

  // Handle storage mode separately
  if (modes[0] === 'storage') {
    console.log('ComputeSDK Storage Provider Benchmarks');
    console.log(`File size: ${fileSizeArg}`);
    console.log(`Date: ${new Date().toISOString()}\n`);

    // Filter storage providers
    const toRun = providerFilter
      ? storageProviders.filter(p => p.name === providerFilter)
      : storageProviders;

    if (toRun.length === 0) {
      console.error(`Unknown storage provider: ${providerFilter}`);
      console.error(`Available: ${storageProviders.map(p => p.name).join(', ')}`);
      process.exit(1);
    }

    await runStorage(toRun, fileSizeArg);
    console.log('\nAll storage tests complete.');
    return;
  }

  // Handle snapshot/fork mode separately
  if (modes[0] === 'snapshot-fork') {
    console.log('ComputeSDK Storage Snapshot/Fork Benchmarks');
    console.log(`Dataset: ${datasetArg}`);
    console.log(`Date: ${new Date().toISOString()}\n`);

    const toRun = providerFilter
      ? storageProviders.filter(p => p.name === providerFilter)
      : storageProviders;

    if (toRun.length === 0) {
      console.error(`Unknown storage provider: ${providerFilter}`);
      console.error(`Available: ${storageProviders.map(p => p.name).join(', ')}`);
      process.exit(1);
    }

    await runSnapshotFork(toRun, datasetArg);
    console.log('\nAll snapshot/fork tests complete.');
    return;
  }

  if (modes[0] === 'sandbox-dax') {
    const toRun = providerFilter
      ? providers.filter(p => p.name === providerFilter)
      : providers;

    if (toRun.length === 0) {
      console.error(`Unknown provider: ${providerFilter}`);
      console.error(`Available: ${providers.map(p => p.name).join(', ')}`);
      process.exit(1);
    }

    await runSandboxDax(toRun);
    console.log('\nAll sandbox dax tests complete.');
    return;
  }

  console.log('ComputeSDK Sandbox Provider Benchmarks');
  console.log(`Tests to run: ${modes.join(', ')}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  // Filter sandbox providers
  const toRun = providerFilter
    ? providers.filter(p => p.name === providerFilter)
    : providers;

  if (toRun.length === 0) {
    console.error(`Unknown provider: ${providerFilter}`);
    console.error(`Available: ${providers.map(p => p.name).join(', ')}`);
    process.exit(1);
  }

  for (const mode of modes) {
    await runMode(mode as BenchmarkMode, toRun);
  }

  console.log('\nAll tests complete.');
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
