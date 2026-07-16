import fs from 'fs';
import os from 'os';
import type { ProviderConfig, Stats } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';

export interface HeavyBuildTimingResult {
  totalMs: number;
  generateMs?: number;
  buildMs?: number;
  jobs?: number;
  sourceFileCount?: number;
  binaryBytes?: number;
  gccVersion?: string;
  makeVersion?: string;
  error?: string;
}

export interface HeavyBuildBenchmarkResult {
  provider: string;
  mode: 'sandbox-heavy-build';
  iterations: HeavyBuildTimingResult[];
  summary: {
    totalMs: Stats;
    generateMs: Stats;
    buildMs: Stats;
    jobs: Stats;
    binaryBytes: Stats;
  };
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export async function runHeavyBuildBenchmark(config: ProviderConfig): Promise<HeavyBuildBenchmarkResult> {
  const { name, iterations = 3, timeout = 300_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'sandbox-heavy-build',
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: HeavyBuildTimingResult[] = [];

  console.log(`\n--- Heavy Build Benchmark: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    let sandbox: any = null;

    try {
      sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
      const result = await runHeavyBuildIteration(sandbox, timeout);
      results.push(result);
      console.log(`    Build: ${(result.buildMs! / 1000).toFixed(2)}s | jobs ${result.jobs} | binary ${formatMiB(result.binaryBytes || 0)} MiB`);
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
    mode: 'sandbox-heavy-build',
    iterations: results,
    summary: successful.length > 0 ? summarize(successful) : emptySummary(),
    successRate: results.length > 0 ? successful.length / results.length : 0,
  };
}

async function runHeavyBuildIteration(sandbox: any, timeout: number): Promise<HeavyBuildTimingResult> {
  const script = String.raw`
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

const start = performance.now();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-heavy-build-'));
const sourceFileCount = 96;
const functionCount = 64;
const gccVersion = run('gcc', ['--version']).split('\n')[0];
const makeVersion = run('make', ['--version']).split('\n')[0];
const jobs = Math.max(1, Math.min(Number(run('nproc', [])) || 1, 32));

const generateStart = performance.now();
let mainCalls = '';
for (let i = 0; i < sourceFileCount; i++) {
  let source = '#include <stdint.h>\n';
  for (let j = 0; j < functionCount; j++) {
    source += 'uint64_t f_' + i + '_' + j + '(uint64_t x){ for(uint64_t k=0;k<800;k++){ x = x * 1664525u + 1013904223u + ' + (i + j) + '; x ^= x >> 13; } return x; }\n';
    mainCalls += 'extern uint64_t f_' + i + '_' + j + '(uint64_t); r += f_' + i + '_' + j + '(r);\n';
  }
  fs.writeFileSync(path.join(root, 'unit_' + i + '.c'), source);
}
fs.writeFileSync(path.join(root, 'main.c'), '#include <stdint.h>\n#include <stdio.h>\nint main(){ uint64_t r=1; ' + mainCalls + ' printf("%llu\\n", (unsigned long long)r); return 0; }\n');
fs.writeFileSync(path.join(root, 'Makefile'), 'CC=gcc\nCFLAGS=-O2 -pipe\nOBJS=$(patsubst %.c,%.o,$(wildcard *.c))\napp: $(OBJS)\n\t$(CC) $(CFLAGS) -o app $(OBJS)\n%.o: %.c\n\t$(CC) $(CFLAGS) -c $< -o $@\n');
const generateMs = performance.now() - generateStart;

const buildStart = performance.now();
run('make', ['-j' + jobs, 'app'], { cwd: root });
const buildMs = performance.now() - buildStart;
const binaryBytes = fs.statSync(path.join(root, 'app')).size;
fs.rmSync(root, { recursive: true, force: true });
const totalMs = performance.now() - start;

console.log(JSON.stringify({ totalMs, generateMs, buildMs, jobs, sourceFileCount, binaryBytes, gccVersion, makeVersion }));
`;

  const result = await withTimeout(
    sandbox.runCommand(`node <<'NODE'\n${script}\nNODE`),
    timeout,
    'Heavy build benchmark timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`Heavy build benchmark failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const jsonLine = (result.stdout || '').trim().split('\n').reverse().find(line => line.trim().startsWith('{'));
  if (!jsonLine) throw new Error('Heavy build benchmark did not emit JSON results');
  return JSON.parse(jsonLine) as HeavyBuildTimingResult;
}

function summarize(results: HeavyBuildTimingResult[]): HeavyBuildBenchmarkResult['summary'] {
  return {
    totalMs: computeStats(results.map(r => r.totalMs)),
    generateMs: computeStats(results.map(r => r.generateMs ?? 0)),
    buildMs: computeStats(results.map(r => r.buildMs ?? 0)),
    jobs: computeStats(results.map(r => r.jobs ?? 0)),
    binaryBytes: computeStats(results.map(r => r.binaryBytes ?? 0)),
  };
}

function emptySummary(): HeavyBuildBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  return { totalMs: empty, generateMs: empty, buildMs: empty, jobs: empty, binaryBytes: empty };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export async function writeHeavyBuildResultsJson(results: HeavyBuildBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      totalMs: round(i.totalMs),
      ...(i.generateMs !== undefined ? { generateMs: round(i.generateMs) } : {}),
      ...(i.buildMs !== undefined ? { buildMs: round(i.buildMs) } : {}),
      ...(i.jobs !== undefined ? { jobs: i.jobs } : {}),
      ...(i.sourceFileCount !== undefined ? { sourceFileCount: i.sourceFileCount } : {}),
      ...(i.binaryBytes !== undefined ? { binaryBytes: i.binaryBytes } : {}),
      ...(i.gccVersion ? { gccVersion: i.gccVersion } : {}),
      ...(i.makeVersion ? { makeVersion: i.makeVersion } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: Object.fromEntries(Object.entries(r.summary).map(([key, stats]) => [key, {
      median: round(stats.median),
      p95: round(stats.p95),
      p99: round(stats.p99),
    }])),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: { mode: 'sandbox-heavy-build', timeoutMs: 300000 },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
