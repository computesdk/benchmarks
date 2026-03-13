import type { ProviderConfig, BenchmarkResult, TimingResult, Stats } from './types.js';

export function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function computeStats(values: number[]): Stats {
  if (values.length === 0) return { min: 0, max: 0, median: 0, p95: 0, p99: 0, avg: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

export async function runBenchmark(config: ProviderConfig): Promise<BenchmarkResult> {
  const { name, iterations = 100, timeout = 120_000, requiredEnvVars, sandboxOptions } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      iterations: [],
      summary: { ttiMs: { min: 0, max: 0, median: 0, p95: 0, p99: 0, avg: 0 } },
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
      const iterationResult = await runIteration(compute, timeout, sandboxOptions);
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
      summary: { ttiMs: { min: 0, max: 0, median: 0, p95: 0, p99: 0, avg: 0 } },
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

export async function runIteration(compute: any, timeout: number, sandboxOptions?: Record<string, any>): Promise<TimingResult> {
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
      try {
        await Promise.race([
          sandbox.destroy(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), 15_000)),
        ]);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
