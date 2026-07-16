import fs from 'fs';
import os from 'os';
import type { ProviderConfig, Stats } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';

export interface FilesystemTimingResult {
  totalMs: number;
  largeFileBytes?: number;
  largeWriteMs?: number;
  largeReadMs?: number;
  largeWriteMbps?: number;
  largeReadMbps?: number;
  smallFileCount?: number;
  smallFileBytes?: number;
  smallFileCreateMs?: number;
  smallFileReadMs?: number;
  smallFileDeleteMs?: number;
  error?: string;
}

export interface FilesystemBenchmarkResult {
  provider: string;
  mode: 'sandbox-filesystem';
  iterations: FilesystemTimingResult[];
  summary: {
    totalMs: Stats;
    largeWriteMs: Stats;
    largeReadMs: Stats;
    largeWriteMbps: Stats;
    largeReadMbps: Stats;
    smallFileCreateMs: Stats;
    smallFileReadMs: Stats;
    smallFileDeleteMs: Stats;
  };
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export async function runFilesystemBenchmark(config: ProviderConfig): Promise<FilesystemBenchmarkResult> {
  const { name, iterations = 10, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'sandbox-filesystem',
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: FilesystemTimingResult[] = [];

  console.log(`\n--- Filesystem Benchmark: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    let sandbox: any = null;

    try {
      sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
      const result = await runFilesystemIteration(sandbox, timeout);
      results.push(result);
      console.log(`    Total: ${(result.totalMs / 1000).toFixed(2)}s | write ${result.largeWriteMbps?.toFixed(1)} Mbps | read ${result.largeReadMbps?.toFixed(1)} Mbps`);
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
    mode: 'sandbox-filesystem',
    iterations: results,
    summary: successful.length > 0 ? summarize(successful) : emptySummary(),
    successRate: results.length > 0 ? successful.length / results.length : 0,
  };
}

async function runFilesystemIteration(sandbox: any, timeout: number): Promise<FilesystemTimingResult> {
  const script = String.raw`
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-fs-bench-'));
const largeFileBytes = 64 * 1024 * 1024;
const smallFileCount = 1000;
const smallFileBytes = 4096;
const largePath = path.join(root, 'large.bin');
const smallDir = path.join(root, 'small');
fs.mkdirSync(smallDir);

function elapsed(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const start = performance.now();
const chunk = Buffer.alloc(1024 * 1024, 7);
const largeWriteMs = elapsed(() => {
  const fd = fs.openSync(largePath, 'w');
  try {
    for (let written = 0; written < largeFileBytes; written += chunk.length) {
      fs.writeSync(fd, chunk, 0, Math.min(chunk.length, largeFileBytes - written));
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
});

const largeReadMs = elapsed(() => {
  const fd = fs.openSync(largePath, 'r');
  const readBuffer = Buffer.alloc(1024 * 1024);
  try {
    while (fs.readSync(fd, readBuffer, 0, readBuffer.length, null) > 0) {}
  } finally {
    fs.closeSync(fd);
  }
});

const smallBuffer = Buffer.alloc(smallFileBytes, 3);
const smallFileCreateMs = elapsed(() => {
  for (let i = 0; i < smallFileCount; i++) {
    fs.writeFileSync(path.join(smallDir, i + '.bin'), smallBuffer);
  }
});

const smallFileReadMs = elapsed(() => {
  for (let i = 0; i < smallFileCount; i++) {
    fs.readFileSync(path.join(smallDir, i + '.bin'));
  }
});

const smallFileDeleteMs = elapsed(() => {
  fs.rmSync(smallDir, { recursive: true, force: true });
  fs.rmSync(largePath, { force: true });
});

fs.rmSync(root, { recursive: true, force: true });
const totalMs = performance.now() - start;

console.log(JSON.stringify({
  totalMs,
  largeFileBytes,
  largeWriteMs,
  largeReadMs,
  largeWriteMbps: (largeFileBytes * 8) / largeWriteMs / 1000,
  largeReadMbps: (largeFileBytes * 8) / largeReadMs / 1000,
  smallFileCount,
  smallFileBytes,
  smallFileCreateMs,
  smallFileReadMs,
  smallFileDeleteMs,
}));
`;

  const result = await withTimeout(
    sandbox.runCommand(`node <<'NODE'\n${script}\nNODE`),
    timeout,
    'Filesystem benchmark timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`Filesystem benchmark failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const jsonLine = (result.stdout || '').trim().split('\n').reverse().find(line => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error('Filesystem benchmark did not emit JSON results');
  }

  return JSON.parse(jsonLine) as FilesystemTimingResult;
}

function summarize(results: FilesystemTimingResult[]): FilesystemBenchmarkResult['summary'] {
  return {
    totalMs: computeStats(results.map(r => r.totalMs)),
    largeWriteMs: computeStats(results.map(r => r.largeWriteMs ?? 0)),
    largeReadMs: computeStats(results.map(r => r.largeReadMs ?? 0)),
    largeWriteMbps: computeStats(results.map(r => r.largeWriteMbps ?? 0)),
    largeReadMbps: computeStats(results.map(r => r.largeReadMbps ?? 0)),
    smallFileCreateMs: computeStats(results.map(r => r.smallFileCreateMs ?? 0)),
    smallFileReadMs: computeStats(results.map(r => r.smallFileReadMs ?? 0)),
    smallFileDeleteMs: computeStats(results.map(r => r.smallFileDeleteMs ?? 0)),
  };
}

function emptySummary(): FilesystemBenchmarkResult['summary'] {
  const empty = { median: 0, p95: 0, p99: 0 };
  return {
    totalMs: empty,
    largeWriteMs: empty,
    largeReadMs: empty,
    largeWriteMbps: empty,
    largeReadMbps: empty,
    smallFileCreateMs: empty,
    smallFileReadMs: empty,
    smallFileDeleteMs: empty,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function writeFilesystemResultsJson(results: FilesystemBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      totalMs: round(i.totalMs),
      ...(i.largeFileBytes !== undefined ? { largeFileBytes: i.largeFileBytes } : {}),
      ...(i.largeWriteMs !== undefined ? { largeWriteMs: round(i.largeWriteMs) } : {}),
      ...(i.largeReadMs !== undefined ? { largeReadMs: round(i.largeReadMs) } : {}),
      ...(i.largeWriteMbps !== undefined ? { largeWriteMbps: round(i.largeWriteMbps) } : {}),
      ...(i.largeReadMbps !== undefined ? { largeReadMbps: round(i.largeReadMbps) } : {}),
      ...(i.smallFileCount !== undefined ? { smallFileCount: i.smallFileCount } : {}),
      ...(i.smallFileBytes !== undefined ? { smallFileBytes: i.smallFileBytes } : {}),
      ...(i.smallFileCreateMs !== undefined ? { smallFileCreateMs: round(i.smallFileCreateMs) } : {}),
      ...(i.smallFileReadMs !== undefined ? { smallFileReadMs: round(i.smallFileReadMs) } : {}),
      ...(i.smallFileDeleteMs !== undefined ? { smallFileDeleteMs: round(i.smallFileDeleteMs) } : {}),
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
      mode: 'sandbox-filesystem',
      timeoutMs: 120000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
