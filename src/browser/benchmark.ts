import { chromium } from 'playwright-core';
import { withTimeout } from '../util/timeout.js';
import type { BrowserProviderConfig, BrowserBenchmarkResult, BrowserTimingResult } from './types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeBrowserStats(values: number[]): { median: number; p95: number; p99: number } {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

async function runBrowserIteration(
  provider: any,
  timeout: number,
): Promise<BrowserTimingResult> {
  const timings = { createMs: 0, connectMs: 0, navigateMs: 0, releaseMs: 0, totalMs: 0 };
  const totalStart = performance.now();

  try {
    // 1. Create session
    const createStart = performance.now();
    const session = await withTimeout(
      provider.session.create(),
      timeout,
      'Session creation timed out',
    ) as { sessionId: string; connectUrl: string };
    timings.createMs = performance.now() - createStart;

    let browser;
    try {
      // 2. Connect over CDP
      const connectStart = performance.now();
      browser = await withTimeout(
        chromium.connectOverCDP(session.connectUrl),
        30_000,
        'CDP connection timed out',
      );
      const context = await browser.newContext();
      const page = await context.newPage();
      timings.connectMs = performance.now() - connectStart;

      // 3. Navigate
      const navStart = performance.now();
      await withTimeout(
        page.goto('https://www.example.com', { waitUntil: 'load' }),
        30_000,
        'Navigation timed out',
      );
      timings.navigateMs = performance.now() - navStart;
    } finally {
      // 4. Close browser and release session
      if (browser) {
        await browser.close().catch(() => {});
      }
      const releaseStart = performance.now();
      await withTimeout(
        provider.session.destroy(session.sessionId),
        15_000,
        'Session destroy timed out',
      );
      timings.releaseMs = performance.now() - releaseStart;
    }

    timings.totalMs = performance.now() - totalStart;
    return { ...timings };
  } catch (err) {
    timings.totalMs = performance.now() - totalStart;
    const error = err instanceof Error ? err.message : String(err);
    return { ...timings, error };
  }
}

export async function runBrowserBenchmark(config: BrowserProviderConfig): Promise<BrowserBenchmarkResult> {
  const { name, iterations = 25, timeout = 120_000, requiredEnvVars } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'browser',
      iterations: [],
      summary: {
        createMs: { median: 0, p95: 0, p99: 0 },
        connectMs: { median: 0, p95: 0, p99: 0 },
        navigateMs: { median: 0, p95: 0, p99: 0 },
        releaseMs: { median: 0, p95: 0, p99: 0 },
        totalMs: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const provider = config.createBrowserProvider();
  const results: BrowserTimingResult[] = [];

  console.log(`\n--- Browser Benchmarking: ${name} (${iterations} iterations) ---`);
  console.log('Run  Create   Connect  Navigate Release  Total    Status');
  console.log('───  ───────  ───────  ──────── ───────  ───────  ──────');

  for (let i = 0; i < iterations; i++) {
    const result = await runBrowserIteration(provider, timeout);
    results.push(result);

    const pad = (n: number) => `${Math.round(n)}ms`.padStart(7);
    const status = result.error ? `✗ ${result.error.slice(0, 40)}` : '✓';
    console.log(
      `${String(i + 1).padStart(3)}  ${pad(result.createMs)}  ${pad(result.connectMs)}  ${pad(result.navigateMs)}  ${pad(result.releaseMs)}  ${pad(result.totalMs)}  ${status}`
    );
  }

  const successful = results.filter(r => !r.error);

  // If every iteration failed, mark as skipped
  if (successful.length === 0) {
    return {
      provider: name,
      mode: 'browser',
      iterations: results,
      summary: {
        createMs: { median: 0, p95: 0, p99: 0 },
        connectMs: { median: 0, p95: 0, p99: 0 },
        navigateMs: { median: 0, p95: 0, p99: 0 },
        releaseMs: { median: 0, p95: 0, p99: 0 },
        totalMs: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: 'All iterations failed',
    };
  }

  return {
    provider: name,
    mode: 'browser',
    iterations: results,
    summary: {
      createMs: computeBrowserStats(successful.map(r => r.createMs)),
      connectMs: computeBrowserStats(successful.map(r => r.connectMs)),
      navigateMs: computeBrowserStats(successful.map(r => r.navigateMs)),
      releaseMs: computeBrowserStats(successful.map(r => r.releaseMs)),
      totalMs: computeBrowserStats(successful.map(r => r.totalMs)),
    },
  };
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeBrowserResultsJson(results: BrowserBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      createMs: round(i.createMs),
      connectMs: round(i.connectMs),
      navigateMs: round(i.navigateMs),
      releaseMs: round(i.releaseMs),
      totalMs: round(i.totalMs),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      createMs: roundStats(r.summary.createMs),
      connectMs: roundStats(r.summary.connectMs),
      navigateMs: roundStats(r.summary.navigateMs),
      releaseMs: roundStats(r.summary.releaseMs),
      totalMs: roundStats(r.summary.totalMs),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
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
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 120000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
