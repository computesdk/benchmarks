import type { ProviderConfig, TimingResult, ConcurrentBenchmarkResult } from './types.js';
import { runIteration } from './benchmark.js';
import { computeStats } from '../util/stats.js';

interface ConcurrentConfig extends ProviderConfig {
  concurrency: number;
}

export async function runConcurrentBenchmark(config: ConcurrentConfig): Promise<ConcurrentBenchmarkResult> {
  const { name, concurrency, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'concurrent',
      concurrency,
      iterations: [],
      summary: { ttiMs: { median: 0, p95: 0, p99: 0 } },
      wallClockMs: 0,
      timeToFirstReadyMs: 0,
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  console.log(`\n--- Concurrent Benchmark: ${name} (${concurrency} sandboxes) ---`);

  const wallStart = performance.now();
  const seenSandboxFingerprints = new Set<string>();

  // Fire all sandbox creations simultaneously — no awaiting between launches
  const promises = Array.from({ length: concurrency }, (_, i) =>
    runIteration(config.createCompute(), timeout, sandboxOptions, destroyTimeoutMs, seenSandboxFingerprints)
      .then(result => {
        console.log(`  Sandbox ${i + 1}/${concurrency}: TTI ${(result.ttiMs / 1000).toFixed(2)}s`);
        return result;
      })
      .catch(err => {
        const error = err instanceof Error ? err.message : String(err);
        console.log(`  Sandbox ${i + 1}/${concurrency}: FAILED — ${error}`);
        return { ttiMs: 0, error } as TimingResult;
      })
  );

  const results = await Promise.all(promises);
  const wallClockMs = performance.now() - wallStart;

  const successful = results.filter(r => !r.error);

  const successfulTimes = successful.map(r => r.ttiMs);
  const timeToFirstReadyMs = successful.length > 0 ? Math.min(...successfulTimes) : 0;

  console.log(`  Wall clock: ${(wallClockMs / 1000).toFixed(2)}s | First ready: ${(timeToFirstReadyMs / 1000).toFixed(2)}s | Success: ${successful.length}/${concurrency}`);

  return {
    provider: name,
    mode: 'concurrent',
    concurrency,
    iterations: results,
    summary: {
      ttiMs: successful.length > 0
        ? computeStats(successfulTimes)
        : { median: 0, p95: 0, p99: 0 },
    },
    wallClockMs,
    timeToFirstReadyMs,
  };
}
