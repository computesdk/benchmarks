import type { ProviderConfig, BenchmarkResult, TimingResult } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';
import { randomUUID } from 'node:crypto';

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
  const runNonce = randomUUID();
  const reuseDetector = {
    runNonce,
    seenSignals: new Map<string, Set<string>>(),
  };

  console.log(`\n--- Benchmarking: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);

    try {
      const iterationResult = await runIteration(
        compute,
        timeout,
        sandboxOptions,
        destroyTimeoutMs,
        reuseDetector,
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

type ReuseDetector = {
  runNonce: string;
  seenSignals: Map<string, Set<string>>;
};

const STRONG_SIGNAL_KEYS = ['ns_mnt', 'ns_pid', 'ns_uts', 'cgroup_hash', 'boot_id', 'pid1'] as const;

function parseKeyValueOutput(stdout: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    parsed[key] = value;
  }
  return parsed;
}

function countStrongSignalMatches(identity: Record<string, string>, detector: ReuseDetector): number {
  let matches = 0;

  for (const key of STRONG_SIGNAL_KEYS) {
    const value = identity[key];
    if (!value || value === 'unknown') continue;
    const seen = detector.seenSignals.get(key);
    if (seen?.has(value)) matches++;
  }

  return matches;
}

function rememberSignals(identity: Record<string, string>, detector: ReuseDetector): void {
  for (const key of STRONG_SIGNAL_KEYS) {
    const value = identity[key];
    if (!value || value === 'unknown') continue;
    if (!detector.seenSignals.has(key)) detector.seenSignals.set(key, new Set<string>());
    detector.seenSignals.get(key)!.add(value);
  }
}

export async function runIteration(
  compute: any,
  timeout: number,
  sandboxOptions?: Record<string, any>,
  destroyTimeoutMs: number = 15_000,
  reuseDetector?: ReuseDetector,
): Promise<TimingResult> {
  let sandbox: any = null;

  try {
    const start = performance.now();

    sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');

    const markerA = '/tmp/.bench_ephemeral_check';
    const markerB = '/var/tmp/.bench_ephemeral_check';
    const probeToken = reuseDetector
      ? `${reuseDetector.runNonce}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
      : `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

    const identityProbeCommand = [
      `marker_a='${markerA}'`,
      `marker_b='${markerB}'`,
      "marker_path=''",
      "for p in \"$marker_a\" \"$marker_b\"; do if [ -f \"$p\" ]; then marker_path=$p; break; fi; done",
      "marker_value='unknown'",
      "if [ -n \"$marker_path\" ]; then marker_value=$(tr -d '\\n' < \"$marker_path\" 2>/dev/null || true); fi",
      "ns_mnt=$(readlink /proc/self/ns/mnt 2>/dev/null || printf unknown)",
      "ns_pid=$(readlink /proc/self/ns/pid 2>/dev/null || printf unknown)",
      "ns_uts=$(readlink /proc/self/ns/uts 2>/dev/null || printf unknown)",
      "cgroup_hash=$(cat /proc/self/cgroup 2>/dev/null | sha256sum 2>/dev/null | cut -d\" \" -f1)",
      "if [ -z \"$cgroup_hash\" ]; then cgroup_hash=unknown; fi",
      "boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)",
      "pid1=$(tr -d '\\0' < /proc/1/cmdline 2>/dev/null || printf unknown)",
      "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null || printf unknown)",
      "printf 'marker_path=%s\\n' \"$marker_path\"",
      "printf 'marker_value=%s\\n' \"$marker_value\"",
      "printf 'ns_mnt=%s\\n' \"$ns_mnt\"",
      "printf 'ns_pid=%s\\n' \"$ns_pid\"",
      "printf 'ns_uts=%s\\n' \"$ns_uts\"",
      "printf 'cgroup_hash=%s\\n' \"$cgroup_hash\"",
      "printf 'boot_id=%s\\n' \"$boot_id\"",
      "printf 'pid1=%s\\n' \"$pid1\"",
      "printf 'uptime=%s\\n' \"$uptime\"",
      `printf '%s' '${probeToken}' > ${markerA}`,
      `printf '%s' '${probeToken}' > ${markerB}`,
    ].join('; ');

    const identityResult = await withTimeout(
      sandbox.runCommand(identityProbeCommand),
      30_000,
      'Sandbox identity check timed out'
    ) as { exitCode: number; stdout?: string; stderr?: string };

    if (identityResult.exitCode !== 0) {
      throw new Error(`Sandbox identity check failed with exit code ${identityResult.exitCode}: ${identityResult.stderr || 'Unknown error'}`);
    }

    const identity = parseKeyValueOutput(identityResult.stdout || '');

    if (reuseDetector) {
      if (identity.marker_path) {
        throw new Error(`Sandbox/container reuse detected: persistent marker at ${identity.marker_path}`);
      }

      const strongMatches = countStrongSignalMatches(identity, reuseDetector);
      if (strongMatches >= 3) {
        const message = `Sandbox/container reuse suspected: ${strongMatches} strong runtime signals repeated`;
        if (process.env.BENCH_STRICT_REUSE_SIGNALS === '1') {
          throw new Error(message);
        }
        console.warn(`    [reuse-check] ${message}`);
      }

      rememberSignals(identity, reuseDetector);
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
