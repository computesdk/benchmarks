import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBenchmark } from './benchmark.js';
import { printResultsTable, writeResultsJson } from './table.js';
import { providers } from './providers.js';
import type { BenchmarkResult, WorkloadConfig } from './types.js';

// Load .env from the benchmarking root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

// Parse CLI args
const args = process.argv.slice(2);
const providerFilter = getArgValue(args, '--provider');
const iterations = parsePositiveInt(getArgValue(args, '--iterations') || '10', '--iterations');

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  const workload = await resolveWorkloadConfig(args);

  console.log('ComputeSDK Sandbox Provider Benchmarks');
  console.log(`Iterations per provider: ${iterations}`);
  if (workload) {
    console.log(`Workload: ${workload.name}`);
  }
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
    const result = await runBenchmark({ ...providerConfig, iterations }, workload);
    results.push(result);
  }

  // Print comparison table
  printResultsTable(results);

  // Write JSON results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.resolve(__dirname, `../results/${timestamp}.json`);
  await writeResultsJson(results, outPath, {
    iterations,
    timeoutMs: 120_000,
    ...(providerFilter ? { providerFilter } : {}),
    ...(workload ? { workload } : {}),
  });
}

async function resolveWorkloadConfig(args: string[]): Promise<WorkloadConfig | undefined> {
  const workloadFilePath = getArgValue(args, '--workload-file');
  let fileConfig: Partial<WorkloadConfig> = {};

  if (workloadFilePath) {
    const fs = await import('fs/promises');
    const absolutePath = path.isAbsolute(workloadFilePath)
      ? workloadFilePath
      : path.resolve(__dirname, '..', workloadFilePath);

    const raw = await fs.readFile(absolutePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid workload file: ${workloadFilePath}`);
    }
    fileConfig = parsed as Partial<WorkloadConfig>;
  }

  const setupCommand = getArgValue(args, '--setup-cmd') ?? fileConfig.setupCommand;
  const command = getArgValue(args, '--workload-cmd') ?? fileConfig.command;

  if (!setupCommand && !command) {
    return undefined;
  }

  const timeoutArg = getArgValue(args, '--workload-timeout-ms');
  const timeoutMs = timeoutArg
    ? parsePositiveInt(timeoutArg, '--workload-timeout-ms')
    : fileConfig.timeoutMs;
  if (typeof timeoutMs === 'number' && timeoutMs <= 0) {
    throw new Error('--workload-timeout-ms must be greater than 0');
  }

  const name = getArgValue(args, '--workload-name') ?? fileConfig.name ?? 'custom-workload';
  const cwd = getArgValue(args, '--workload-cwd') ?? fileConfig.cwd;

  return {
    name,
    ...(setupCommand ? { setupCommand } : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  };
}

function parsePositiveInt(value: string, flagName: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
