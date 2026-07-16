import fs from 'fs';
import os from 'os';
import type { ProviderConfig } from './types.js';
import { withTimeout } from '../util/timeout.js';

export interface SandboxResourceObservation {
  totalMs: number;
  os?: {
    platform?: string;
    arch?: string;
    kernel?: string;
    distro?: string;
    user?: string;
  };
  cpu?: {
    nproc?: number;
    model?: string;
    cpuinfoProcessorCount?: number;
    cgroupQuotaUs?: number | null;
    cgroupPeriodUs?: number | null;
    cgroupEffectiveCpus?: number | null;
  };
  memory?: {
    memTotalKb?: number;
    memAvailableKb?: number;
    cgroupMaxBytes?: number | null;
    cgroupCurrentBytes?: number | null;
  };
  disk?: {
    rootTotalBytes?: number;
    rootAvailableBytes?: number;
    tmpTotalBytes?: number;
    tmpAvailableBytes?: number;
  };
  process?: {
    pidCount?: number;
    maxUserProcesses?: string;
    openFilesLimit?: string;
  };
  tools?: Record<string, { available: boolean; version?: string }>;
  error?: string;
}

export interface SandboxResourcesBenchmarkResult {
  provider: string;
  mode: 'sandbox-resources';
  iterations: SandboxResourceObservation[];
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export async function runResourcesBenchmark(config: ProviderConfig): Promise<SandboxResourcesBenchmarkResult> {
  const { name, iterations = 3, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'sandbox-resources',
      iterations: [],
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: SandboxResourceObservation[] = [];

  console.log(`\n--- Resources Benchmark: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    let sandbox: any = null;

    try {
      sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
      const result = await runResourcesIteration(sandbox, timeout);
      results.push(result);
      const memoryBytes = result.memory?.cgroupMaxBytes ?? (result.memory?.memTotalKb ? result.memory.memTotalKb * 1024 : undefined);
      console.log(`    CPU: ${formatCpu(result)} | Memory: ${formatMiB(memoryBytes)} MiB | Disk: ${formatMiB(result.disk?.rootAvailableBytes)} MiB free`);
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
    mode: 'sandbox-resources',
    iterations: results,
    successRate: results.length > 0 ? successful.length / results.length : 0,
  };
}

async function runResourcesIteration(sandbox: any, timeout: number): Promise<SandboxResourceObservation> {
  const script = String.raw`
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

function read(path) {
  try { return fs.readFileSync(path, 'utf8').trim(); } catch { return undefined; }
}

function run(command, args = []) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
}

function numberOrNull(value) {
  if (value === undefined || value === '' || value === 'max') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseMeminfo() {
  const raw = read('/proc/meminfo') || '';
  const mem = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match) mem[match[1]] = Number(match[2]);
  }
  return mem;
}

function parseDf(target) {
  const raw = run('df', ['-Pk', target]);
  if (!raw) return {};
  const line = raw.split('\n')[1];
  if (!line) return {};
  const parts = line.trim().split(/\s+/);
  return {
    totalBytes: Number(parts[1]) * 1024,
    availableBytes: Number(parts[3]) * 1024,
  };
}

function tool(command, args) {
  const version = run(command, args);
  return version ? { available: true, version: version.split('\n')[0] } : { available: false };
}

const start = performance.now();
const cpuinfo = read('/proc/cpuinfo') || '';
const cpuModel = cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1] || cpuinfo.match(/^Hardware\s*:\s*(.+)$/m)?.[1];
const cpuinfoProcessorCount = (cpuinfo.match(/^processor\s*:/gm) || []).length || undefined;
const nprocRaw = run('nproc');
const cpuMax = read('/sys/fs/cgroup/cpu.max');
let cgroupQuotaUs = null;
let cgroupPeriodUs = null;
if (cpuMax) {
  const [quota, period] = cpuMax.split(/\s+/);
  cgroupQuotaUs = numberOrNull(quota);
  cgroupPeriodUs = numberOrNull(period);
} else {
  cgroupQuotaUs = numberOrNull(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  cgroupPeriodUs = numberOrNull(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
}

const meminfo = parseMeminfo();
const rootDf = parseDf('/');
const tmpDf = parseDf('/tmp');
const ulimit = run('sh', ['-lc', 'ulimit -a']) || '';
const processList = run('sh', ['-lc', 'ps -eo pid= 2>/dev/null | wc -l']);

const result = {
  totalMs: performance.now() - start,
  os: {
    platform: os.platform(),
    arch: os.arch(),
    kernel: os.release(),
    distro: read('/etc/os-release'),
    user: run('id', ['-un']),
  },
  cpu: {
    nproc: nprocRaw ? Number(nprocRaw) : undefined,
    model: cpuModel,
    cpuinfoProcessorCount,
    cgroupQuotaUs,
    cgroupPeriodUs,
    cgroupEffectiveCpus: cgroupQuotaUs && cgroupPeriodUs ? cgroupQuotaUs / cgroupPeriodUs : null,
  },
  memory: {
    memTotalKb: meminfo.MemTotal,
    memAvailableKb: meminfo.MemAvailable,
    cgroupMaxBytes: numberOrNull(read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes')),
    cgroupCurrentBytes: numberOrNull(read('/sys/fs/cgroup/memory.current') ?? read('/sys/fs/cgroup/memory/memory.usage_in_bytes')),
  },
  disk: {
    rootTotalBytes: rootDf.totalBytes,
    rootAvailableBytes: rootDf.availableBytes,
    tmpTotalBytes: tmpDf.totalBytes,
    tmpAvailableBytes: tmpDf.availableBytes,
  },
  process: {
    pidCount: processList ? Number(processList.trim()) : undefined,
    maxUserProcesses: ulimit.match(/max user processes\s+\S+\s+(.+)/)?.[1],
    openFilesLimit: ulimit.match(/open files\s+\S+\s+(.+)/)?.[1],
  },
  tools: {
    node: tool('node', ['--version']),
    npm: tool('npm', ['--version']),
    git: tool('git', ['--version']),
    python: tool('python3', ['--version']),
    gcc: tool('gcc', ['--version']),
    make: tool('make', ['--version']),
    curl: tool('curl', ['--version']),
    wget: tool('wget', ['--version']),
  },
};

console.log(JSON.stringify(result));
`;

  const result = await withTimeout(
    sandbox.runCommand(`node <<'NODE'\n${script}\nNODE`),
    timeout,
    'Resources benchmark timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`Resources benchmark failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const jsonLine = (result.stdout || '').trim().split('\n').reverse().find(line => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error('Resources benchmark did not emit JSON results');
  }

  return JSON.parse(jsonLine) as SandboxResourceObservation;
}

function roundValue(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(roundValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, roundValue(val)]));
  }
  return value;
}

function formatCpu(result: SandboxResourceObservation): string {
  const quota = result.cpu?.cgroupEffectiveCpus;
  const nproc = result.cpu?.nproc;
  if (quota) return `${quota.toFixed(2)} effective CPUs (${nproc ?? 'unknown'} visible)`;
  return `${nproc ?? 'unknown'} visible CPUs`;
}

function formatMiB(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return 'unknown';
  return (bytes / 1024 / 1024).toFixed(0);
}

export async function writeResourcesResultsJson(results: SandboxResourcesBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = roundValue(results);
  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      mode: 'sandbox-resources',
      timeoutMs: 120000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
