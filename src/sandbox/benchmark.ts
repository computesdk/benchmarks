import type { ProviderConfig, BenchmarkResult, TimingResult } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';

export async function runBenchmark(config: ProviderConfig): Promise<BenchmarkResult> {
  const { name, iterations = 100, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      iterations: [],
      summary: { ttiMs: { median: 0, p95: 0, p99: 0 } },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: TimingResult[] = [];

  console.log(`\n--- Benchmarking: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);

    try {
      const iterationResult = await runIteration(compute, timeout, sandboxOptions, destroyTimeoutMs);
      results.push(iterationResult);
      console.log(`    TTI: ${(iterationResult.ttiMs / 1000).toFixed(2)}s`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ ttiMs: 0, error });
    }
  }

  const successful = results.filter(r => !r.error);

  // If every iteration failed, mark as skipped so it doesn't show 0.00s
  if (successful.length === 0) {
    return {
      provider: name,
      iterations: results,
      summary: { ttiMs: { median: 0, p95: 0, p99: 0 } },
      skipped: true,
      skipReason: 'All iterations failed',
    };
  }

  return {
    provider: name,
    iterations: results,
    summary: {
      ttiMs: computeStats(successful.map(r => r.ttiMs)),
    },
  };
}

export async function runIteration(compute: any, timeout: number, sandboxOptions?: Record<string, any>, destroyTimeoutMs: number = 15_000): Promise<TimingResult> {
  let sandbox: any = null;

  try {
    const start = performance.now();

    sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');

    const result = await withTimeout(
      sandbox.runCommand('node -v'),
      30_000,
      'First command execution timed out'
    ) as { exitCode: number; stderr?: string };

    if (result.exitCode !== 0) {
      throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
    }

    const ttiMs = performance.now() - start;

    return { ttiMs };
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

