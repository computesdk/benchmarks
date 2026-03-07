import fs from 'fs';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBenchmark } from './benchmark.js';
import { runConcurrentBenchmark } from './concurrent.js';
import { runStaggeredBenchmark } from './staggered.js';
import { printResultsTable, writeResultsJson } from './table.js';
import { providers } from './providers.js';
import { computeCompositeScores } from './scoring.js';
import type { BenchmarkResult, BenchmarkMode } from './types.js';

// Load .env from the benchmarking root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

// Parse CLI args
const args = process.argv.slice(2);
const providerFilter = getArgValue(args, '--provider');
const iterations = parseInt(getArgValue(args, '--iterations') || '100', 10);
const rawMode = getArgValue(args, '--mode');
const concurrency = parseInt(getArgValue(args, '--concurrency') || '100', 10);
const staggerDelay = parseInt(getArgValue(args, '--stagger-delay') || '200', 10);

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** Resolve which modes to run */
function getModesToRun(): BenchmarkMode[] {
  if (!rawMode) return ['sequential', 'staggered', 'burst'];
  const m = rawMode === 'concurrent' ? 'burst' : rawMode as BenchmarkMode;
  return [m];
}

/** Map mode to results subdirectory name */
function modeToDir(m: BenchmarkMode): string {
  switch (m) {
    case 'sequential': return 'sequential_tti';
    case 'staggered': return 'staggered_tti';
    case 'burst':
    case 'concurrent': return 'burst_tti';
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const subDir = modeToDir(mode);
  const resultsDir = path.resolve(__dirname, `../results/${subDir}`);
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeResultsJson(results, outPath);

  // Create/update latest.json symlink
  const latestPath = path.join(resultsDir, 'latest.json');
  try { fs.unlinkSync(latestPath); } catch { /* may not exist */ }
  fs.symlinkSync(path.basename(outPath), latestPath);
  console.log(`Symlink updated: ${latestPath} -> ${path.basename(outPath)}`);
}

async function main() {
  const modes = getModesToRun();

  console.log('ComputeSDK Sandbox Provider Benchmarks');
  console.log(`Tests to run: ${modes.join(', ')}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  // Filter providers if --provider flag is set
  const toRun = providerFilter
    ? providers.filter(p => p.name === providerFilter)
    : providers;

  if (toRun.length === 0) {
    console.error(`Unknown provider: ${providerFilter}`);
    console.error(`Available: ${providers.map(p => p.name).join(', ')}`);
    process.exit(1);
  }

  for (const mode of modes) {
    await runMode(mode, toRun);
  }

  console.log('\nAll tests complete.');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
