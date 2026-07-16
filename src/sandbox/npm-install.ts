import fs from 'fs';
import os from 'os';
import type { ProviderConfig, Stats } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';

export interface NpmInstallTimingResult {
  totalMs: number;
  installMs?: number;
  nodeModulesBytes?: number;
  packageCount?: number;
  nodeVersion?: string;
  npmVersion?: string;
  error?: string;
}

export interface NpmInstallBenchmarkResult {
  provider: string;
  mode: 'sandbox-npm-install';
  iterations: NpmInstallTimingResult[];
  summary: {
    totalMs: Stats;
    installMs: Stats;
    nodeModulesBytes: Stats;
    packageCount: Stats;
  };
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export async function runNpmInstallBenchmark(config: ProviderConfig): Promise<NpmInstallBenchmarkResult> {
  const { name, iterations = 10, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'sandbox-npm-install',
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: NpmInstallTimingResult[] = [];

  console.log(`\n--- npm Install Benchmark: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    let sandbox: any = null;

    try {
      sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
      const result = await runNpmInstallIteration(sandbox, timeout);
      results.push(result);
      console.log(`    Install: ${(result.installMs! / 1000).toFixed(2)}s | packages ${result.packageCount} | node_modules ${formatMiB(result.nodeModulesBytes || 0)} MiB`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ totalMs: 0, error });
    } finally {
      if (sandbox) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            sandbox.destroy(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs);
            }),
          ]);
        } catch (err) {
          console.warn(`    [cleanup] destroy failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
  }

  const successful = results.filter(r => !r.error);

  return {
    provider: name,
    mode: 'sandbox-npm-install',
    iterations: results,
    summary: successful.length > 0 ? summarize(successful) : emptySummary(),
    successRate: results.length > 0 ? successful.length / results.length : 0,
  };
}

async function runNpmInstallIteration(sandbox: any, timeout: number): Promise<NpmInstallTimingResult> {
  const script = String.raw`
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-npm-bench-'));
const packageJson = {
  name: 'sandbox-npm-bench-fixture',
  version: '1.0.0',
  private: true,
  type: 'module',
  dependencies: {
    '@types/node': '26.0.1',
    'esbuild': '0.28.1',
    'p-limit': '7.3.0',
    'tsx': '4.22.4',
    'typescript': '6.0.3',
    'zod': '4.2.1'
  }
};

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function walk(dir) {
  let fileCount = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { fileCount, bytes };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = walk(full);
      fileCount += child.fileCount;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      fileCount++;
      bytes += fs.statSync(full).size;
    }
  }
  return { fileCount, bytes };
}

const start = performance.now();
const nodeVersion = run('node', ['--version']);
const npmVersion = run('npm', ['--version']);
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
const installStart = performance.now();
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root });
const installMs = performance.now() - installStart;
const nodeModules = walk(path.join(root, 'node_modules'));
fs.rmSync(root, { recursive: true, force: true });
const totalMs = performance.now() - start;

console.log(JSON.stringify({
  totalMs,
  installMs,
  nodeModulesBytes: nodeModules.bytes,
  packageCount: nodeModules.fileCount,
  nodeVersion,
  npmVersion,
}));
`;

  const result = await withTimeout(
    sandbox.runCommand(`node <<'NODE'\n${script}\nNODE`),
    timeout,
    'npm install benchmark timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`npm install benchmark failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const jsonLine = (result.stdout || '').trim().split('\n').reverse().find(line => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error('npm install benchmark did not emit JSON results');
  }

  return JSON.parse(jsonLine) as NpmInstallTimingResult;
}

function summarize(results: NpmInstallTimingResult[]): NpmInstallBenchmarkResult['summary'] {
  return {
    totalMs: computeStats(results.map(r => r.totalMs)),
    installMs: computeStats(results.map(r => r.installMs ?? 0)),
    nodeModulesBytes: computeStats(results.map(r => r.nodeModulesBytes ?? 0)),
    packageCount: computeStats(results.map(r => r.packageCount ?? 0)),
  };
}

function emptySummary(): NpmInstallBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  return {
    totalMs: empty,
    installMs: empty,
    nodeModulesBytes: empty,
    packageCount: empty,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export async function writeNpmInstallResultsJson(results: NpmInstallBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      totalMs: round(i.totalMs),
      ...(i.installMs !== undefined ? { installMs: round(i.installMs) } : {}),
      ...(i.nodeModulesBytes !== undefined ? { nodeModulesBytes: i.nodeModulesBytes } : {}),
      ...(i.packageCount !== undefined ? { packageCount: i.packageCount } : {}),
      ...(i.nodeVersion ? { nodeVersion: i.nodeVersion } : {}),
      ...(i.npmVersion ? { npmVersion: i.npmVersion } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: Object.fromEntries(
      Object.entries(r.summary).map(([key, stats]) => [key, {
        median: round(stats.median),
        p95: round(stats.p95),
        p99: round(stats.p99),
      }]),
    ),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      mode: 'sandbox-npm-install',
      timeoutMs: 120000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
