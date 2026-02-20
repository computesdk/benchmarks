import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBenchmark } from './benchmark.js';
import { printResultsTable, writeResultsJson } from './table.js';
import { providers } from './providers.js';
import type { BenchmarkResult } from './types.js';

// Load .env from the benchmarking root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

// Parse CLI args
const args = process.argv.slice(2);
const providerFilter = getArgValue(args, '--provider');
const iterations = parseInt(getArgValue(args, '--iterations') || '10', 10);

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  console.log('ComputeSDK Sandbox Provider Benchmarks');
  console.log(`Iterations per provider: ${iterations}`);
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

  const results: BenchmarkResult[] = [];

  // Run benchmarks sequentially to avoid resource contention
  for (const providerConfig of toRun) {
    const result = await runBenchmark({ ...providerConfig, iterations });
    results.push(result);
  }

  // Print comparison table
  printResultsTable(results);

  // Write JSON results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.resolve(__dirname, `../results/${timestamp}.json`);
  await writeResultsJson(results, outPath);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
