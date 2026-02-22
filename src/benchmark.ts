import type {
  ProviderConfig,
  WorkloadConfig,
  BenchmarkResult,
  TimingResult,
  Stats,
} from './types.js';

function computeStats(values: number[]): Stats {
  if (values.length === 0) return { min: 0, max: 0, median: 0, avg: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    avg: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

export async function runBenchmark(
  config: ProviderConfig,
  workload?: WorkloadConfig
): Promise<BenchmarkResult> {
  const { name, iterations = 10, timeout = 120_000, requiredEnvVars } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      iterations: [],
      summary: { ttiMs: { min: 0, max: 0, median: 0, avg: 0 } },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: TimingResult[] = [];

  console.log(`\n--- Benchmarking: ${name} (${iterations} iterations) ---`);
  if (workload) {
    console.log(`  Workload: ${workload.name}`);
  }

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);

    try {
      const iterationResult = await runIteration(compute, timeout, workload);
      results.push(iterationResult);
      const statusParts = [`TTI: ${(iterationResult.ttiMs / 1000).toFixed(2)}s`];
      if (typeof iterationResult.workloadMs === 'number') {
        statusParts.push(`Workload: ${(iterationResult.workloadMs / 1000).toFixed(2)}s`);
      }
      if (typeof iterationResult.totalMs === 'number') {
        statusParts.push(`Total: ${(iterationResult.totalMs / 1000).toFixed(2)}s`);
      }
      console.log(`    ${statusParts.join(' | ')}`);
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
      summary: { ttiMs: { min: 0, max: 0, median: 0, avg: 0 } },
      skipped: true,
      skipReason: 'All iterations failed',
    };
  }

  const workloadValues = successful
    .map(r => r.workloadMs)
    .filter((value): value is number => typeof value === 'number');
  const totalValues = successful
    .map(r => r.totalMs)
    .filter((value): value is number => typeof value === 'number');

  return {
    provider: name,
    iterations: results,
    summary: {
      ttiMs: computeStats(successful.map(r => r.ttiMs)),
      ...(workloadValues.length > 0 ? { workloadMs: computeStats(workloadValues) } : {}),
      ...(totalValues.length > 0 ? { totalMs: computeStats(totalValues) } : {}),
    },
  };
}

async function runIteration(
  compute: any,
  timeout: number,
  workload?: WorkloadConfig
): Promise<TimingResult> {
  let sandbox: any = null;
  const workloadTimeoutMs = workload?.timeoutMs ?? 300_000;

  try {
    const start = performance.now();

    sandbox = await withTimeout(compute.sandbox.create(), timeout, 'Sandbox creation timed out');

    await withTimeout(
      runCheckedCommand(
        sandbox,
        'echo "benchmark"',
        { timeoutSeconds: 30 },
        'First command execution failed'
      ),
      30_000,
      'First command execution timed out'
    );

    const ttiMs = performance.now() - start;

    if (!workload?.setupCommand && !workload?.command) {
      return { ttiMs };
    }

    const workloadStart = performance.now();
    const timeoutSeconds = msToSeconds(workloadTimeoutMs);

    if (workload.setupCommand) {
      await withTimeout(
        runCheckedCommand(
          sandbox,
          workload.setupCommand,
          { cwd: workload.cwd, timeoutSeconds },
          'Workload setup failed'
        ),
        workloadTimeoutMs,
        'Workload setup timed out'
      );
    }

    if (workload.command) {
      await withTimeout(
        runCheckedCommand(
          sandbox,
          workload.command,
          { cwd: workload.cwd, timeoutSeconds },
          'Workload command failed'
        ),
        workloadTimeoutMs,
        'Workload command timed out'
      );
    }

    const workloadMs = performance.now() - workloadStart;
    const totalMs = performance.now() - start;

    return { ttiMs, workloadMs, totalMs };
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function runCheckedCommand(
  sandbox: any,
  command: string,
  options: { cwd?: string; timeoutSeconds: number },
  failurePrefix: string
): Promise<void> {
  const result = await sandbox.runCommand(command, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    timeout: options.timeoutSeconds,
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const detail = stderr || stdout;
    if (detail) {
      throw new Error(`${failurePrefix} (exit ${result.exitCode}): ${truncate(detail, 220)}`);
    }
    throw new Error(`${failurePrefix} (exit ${result.exitCode})`);
  }
}

function msToSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
