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

  const results: TimingResult[] = [];
  const seenSandboxFingerprints = new Set<string>();

  console.log(`\n--- Benchmarking: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);

    try {
      const iterationResult = await runIteration(
        config.createCompute(),
        timeout,
        sandboxOptions,
        destroyTimeoutMs,
        seenSandboxFingerprints,
      );
      results.push(iterationResult);
      console.log(`    TTI: ${(iterationResult.ttiMs / 1000).toFixed(2)}s`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ ttiMs: 0, error });
    }
  }

  const successful = results.filter(r => !r.error);

  return {
    provider: name,
    iterations: results,
    summary: {
      ttiMs: successful.length > 0
        ? computeStats(successful.map(r => r.ttiMs))
        : { median: 0, p95: 0, p99: 0 },
    },
  };
}

function getSandboxFingerprint(sandbox: any): string | null {
  const candidateKeys = ['id', 'sandboxId', 'containerId', 'instanceId'];
  for (const key of candidateKeys) {
    const value = sandbox?.[key];
    if (typeof value === 'string' && value.trim()) {
      return `sandbox:${value}`;
    }
  }

  return null;
}

export async function runIteration(
  compute: any,
  timeout: number,
  sandboxOptions?: Record<string, any>,
  destroyTimeoutMs: number = 15_000,
  seenSandboxFingerprints?: Set<string>,
): Promise<TimingResult> {
  let sandbox: any = null;

  try {
    const start = performance.now();

    sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');

    const identityResult = await withTimeout(
      sandbox.runCommand("sh -lc 'echo -n $(hostname)'"),
      30_000,
      'Sandbox identity check timed out'
    ) as { exitCode: number; stdout?: string; stderr?: string };

    if (identityResult.exitCode !== 0) {
      throw new Error(`Sandbox identity check failed with exit code ${identityResult.exitCode}: ${identityResult.stderr || 'Unknown error'}`);
    }

    const runtimeIdentity = (identityResult.stdout || '').trim();
    const sandboxFingerprint = getSandboxFingerprint(sandbox);
    const fingerprint = sandboxFingerprint || (runtimeIdentity ? `runtime:${runtimeIdentity}` : null);

    if (seenSandboxFingerprints && fingerprint) {
      if (seenSandboxFingerprints.has(fingerprint)) {
        throw new Error('Sandbox/container reuse detected across benchmark iterations');
      }
      seenSandboxFingerprints.add(fingerprint);
    }

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
