import fs from 'fs';
import os from 'os';
import type { ProviderConfig, Stats } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';

const GIT_CLONE_REPO_URL = 'https://github.com/computesdk/benchmarks.git';

export interface GitCloneTimingResult {
  totalMs: number;
  cloneMs?: number;
  fileCount?: number;
  checkoutBytes?: number;
  gitVersion?: string;
  headSha?: string;
  repoUrl?: string;
  error?: string;
}

export interface GitCloneBenchmarkResult {
  provider: string;
  mode: 'sandbox-git-clone';
  iterations: GitCloneTimingResult[];
  summary: {
    totalMs: Stats;
    cloneMs: Stats;
    fileCount: Stats;
    checkoutBytes: Stats;
  };
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export async function runGitCloneBenchmark(config: ProviderConfig): Promise<GitCloneBenchmarkResult> {
  const { name, iterations = 10, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'sandbox-git-clone',
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: GitCloneTimingResult[] = [];

  console.log(`\n--- Git Clone Benchmark: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    let sandbox: any = null;

    try {
      sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
      const result = await runGitCloneIteration(sandbox, timeout);
      results.push(result);
      console.log(`    Clone: ${(result.cloneMs! / 1000).toFixed(2)}s | files ${result.fileCount} | size ${formatMiB(result.checkoutBytes || 0)} MiB`);
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
    mode: 'sandbox-git-clone',
    iterations: results,
    summary: successful.length > 0 ? summarize(successful) : emptySummary(),
    successRate: results.length > 0 ? successful.length / results.length : 0,
  };
}

async function runGitCloneIteration(sandbox: any, timeout: number): Promise<GitCloneTimingResult> {
  const script = String.raw`
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

const repoUrl = ${JSON.stringify(GIT_CLONE_REPO_URL)};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-git-bench-'));
const checkoutPath = path.join(root, 'repo');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function walk(dir) {
  let fileCount = 0;
  let bytes = 0;
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
const gitVersion = run('git', ['--version']);
const cloneStart = performance.now();
run('git', ['clone', '--depth', '1', repoUrl, checkoutPath]);
const cloneMs = performance.now() - cloneStart;
const headSha = run('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath });
const checkout = walk(checkoutPath);
fs.rmSync(root, { recursive: true, force: true });
const totalMs = performance.now() - start;

console.log(JSON.stringify({
  totalMs,
  cloneMs,
  fileCount: checkout.fileCount,
  checkoutBytes: checkout.bytes,
  gitVersion,
  headSha,
  repoUrl,
}));
`;

  const result = await withTimeout(
    sandbox.runCommand(`node <<'NODE'\n${script}\nNODE`),
    timeout,
    'Git clone benchmark timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`Git clone benchmark failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const jsonLine = (result.stdout || '').trim().split('\n').reverse().find(line => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error('Git clone benchmark did not emit JSON results');
  }

  return JSON.parse(jsonLine) as GitCloneTimingResult;
}

function summarize(results: GitCloneTimingResult[]): GitCloneBenchmarkResult['summary'] {
  return {
    totalMs: computeStats(results.map(r => r.totalMs)),
    cloneMs: computeStats(results.map(r => r.cloneMs ?? 0)),
    fileCount: computeStats(results.map(r => r.fileCount ?? 0)),
    checkoutBytes: computeStats(results.map(r => r.checkoutBytes ?? 0)),
  };
}

function emptySummary(): GitCloneBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  return {
    totalMs: empty,
    cloneMs: empty,
    fileCount: empty,
    checkoutBytes: empty,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export async function writeGitCloneResultsJson(results: GitCloneBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      totalMs: round(i.totalMs),
      ...(i.cloneMs !== undefined ? { cloneMs: round(i.cloneMs) } : {}),
      ...(i.fileCount !== undefined ? { fileCount: i.fileCount } : {}),
      ...(i.checkoutBytes !== undefined ? { checkoutBytes: i.checkoutBytes } : {}),
      ...(i.gitVersion ? { gitVersion: i.gitVersion } : {}),
      ...(i.headSha ? { headSha: i.headSha } : {}),
      ...(i.repoUrl ? { repoUrl: i.repoUrl } : {}),
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
      mode: 'sandbox-git-clone',
      timeoutMs: 120000,
      repoUrl: GIT_CLONE_REPO_URL,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
