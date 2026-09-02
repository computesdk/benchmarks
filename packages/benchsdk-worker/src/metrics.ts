import * as fs from 'node:fs';
import * as os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface BenchmarkSystemMetricsSample {
  ts: string;
  uptimeMs: number;
  cpuUserUs: number;
  cpuSystemUs: number;
  memRssMb: number;
  memHeapUsedMb: number;
  memHeapTotalMb: number;
  memExternalMb: number;
  eventLoopP50Ms: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  loadavg1m: number;
  loadavg5m: number;
  loadavg15m: number;
  openFds: number | null;
  sockstat: Record<string, number> | null;
  /** Whole-VM memory from /proc/meminfo — not this process's slice of it. Null off Linux. */
  hostMemTotalMb: number | null;
  hostMemAvailableMb: number | null;
  /**
   * Whole-VM CPU time from /proc/stat, cumulative since the collector started
   * (same convention as cpuUserUs/cpuSystemUs). usedUs excludes idle/iowait;
   * usedUs / totalUs is host CPU utilization since collector start.
   */
  hostCpuUsedUs: number | null;
  hostCpuTotalUs: number | null;
  /** Static for the run — the container/VM's own ceiling, not the host machine's. Null if unlimited or unreadable. */
  cgroupMemLimitMb: number | null;
  cgroupCpuLimitCores: number | null;
}

export interface BenchmarkSystemMetricsCollector {
  sample(): BenchmarkSystemMetricsSample;
  stop(): void;
}

function readSockstat(): Record<string, number> | null {
  try {
    const data = fs.readFileSync('/proc/net/sockstat', 'utf-8');
    const out: Record<string, number> = {};
    for (const line of data.split('\n')) {
      const index = line.indexOf(':');
      if (index < 0) continue;
      const section = line.slice(0, index).trim().toLowerCase();
      const parts = line.slice(index + 1).trim().split(/\s+/);
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const value = Number.parseInt(parts[i + 1], 10);
        if (!Number.isNaN(value)) out[`${section}_${parts[i]}`] = value;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function countOpenFds(): number | null {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

function readHostMemInfo(): { totalMb: number; availableMb: number } | null {
  try {
    const data = fs.readFileSync('/proc/meminfo', 'utf-8');
    const total = data.match(/^MemTotal:\s+(\d+)\s*kB/m);
    const available = data.match(/^MemAvailable:\s+(\d+)\s*kB/m);
    if (!total || !available) return null;
    return {
      totalMb: Math.round(Number.parseInt(total[1], 10) / 1024),
      availableMb: Math.round(Number.parseInt(available[1], 10) / 1024),
    };
  } catch {
    return null;
  }
}

// user nice system idle iowait irq softirq steal [guest guest_nice], in jiffies.
function readHostCpuJiffies(): number[] | null {
  try {
    const data = fs.readFileSync('/proc/stat', 'utf-8');
    const line = data.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    return line.trim().split(/\s+/).slice(1).map((v) => Number.parseInt(v, 10));
  } catch {
    return null;
  }
}

// ponytail: hardcoded 100Hz — correct on ~every Linux distro/container, wrong
// on the rare kernel built with a different CLK_TCK. Upgrade path: shell out
// to `getconf CLK_TCK` once at collector creation if that ever surfaces.
const CLK_TCK_HZ = 100;
const US_PER_JIFFY = 1_000_000 / CLK_TCK_HZ;

/** Elementwise jiffy delta since a baseline snapshot, converted to microseconds. */
function hostCpuUsageSince(baseline: number[] | null, current: number[] | null): { usedUs: number; totalUs: number } | null {
  if (!baseline || !current || baseline.length !== current.length) return null;
  const deltas = current.map((v, i) => v - baseline[i]);
  const [user, nice, system, , , irq = 0, softirq = 0, steal = 0] = deltas;
  const usedUs = (user + nice + system + irq + softirq + steal) * US_PER_JIFFY;
  const totalUs = deltas.reduce((sum, v) => sum + v, 0) * US_PER_JIFFY;
  return { usedUs: Math.round(usedUs), totalUs: Math.round(totalUs) };
}

function readCgroupMemLimitMb(): number | null {
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim();
    if (raw === 'max') return null;
    const bytes = Number.parseInt(raw, 10);
    return Number.isFinite(bytes) ? Math.round(bytes / 1024 / 1024) : null;
  } catch {
    // Not cgroup v2 (or not in a cgroup at all) — fall through to v1.
  }
  try {
    const bytes = Number.parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8').trim(), 10);
    // v1 has no "unlimited" string; it reports a near-2^63 sentinel instead.
    if (!Number.isFinite(bytes) || bytes > 1e15) return null;
    return Math.round(bytes / 1024 / 1024);
  } catch {
    return null;
  }
}

function readCgroupCpuLimitCores(): number | null {
  try {
    const [quotaRaw, periodRaw] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf-8').trim().split(/\s+/);
    if (quotaRaw === 'max') return null;
    const quota = Number.parseInt(quotaRaw, 10);
    const period = Number.parseInt(periodRaw, 10);
    return Number.isFinite(quota) && period > 0 ? quota / period : null;
  } catch {
    // Not cgroup v2 (or not in a cgroup at all) — fall through to v1.
  }
  try {
    const quota = Number.parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf-8').trim(), 10);
    if (!Number.isFinite(quota) || quota <= 0) return null;
    const period = Number.parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf-8').trim(), 10);
    return period > 0 ? quota / period : null;
  } catch {
    return null;
  }
}

export function createSystemMetricsCollector(): BenchmarkSystemMetricsCollector {
  const startedAt = Date.now();
  const cpuBaseline = process.cpuUsage();
  const hostCpuBaseline = readHostCpuJiffies();
  const cgroupMemLimitMb = readCgroupMemLimitMb();
  const cgroupCpuLimitCores = readCgroupCpuLimitCores();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();

  return {
    sample() {
      const cpu = process.cpuUsage(cpuBaseline);
      const memory = process.memoryUsage();
      const loadavg = os.loadavg();
      const hostMem = readHostMemInfo();
      const hostCpu = hostCpuUsageSince(hostCpuBaseline, readHostCpuJiffies());
      const sample: BenchmarkSystemMetricsSample = {
        ts: new Date().toISOString(),
        uptimeMs: Date.now() - startedAt,
        cpuUserUs: cpu.user,
        cpuSystemUs: cpu.system,
        memRssMb: Math.round(memory.rss / 1024 / 1024),
        memHeapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        memHeapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
        memExternalMb: Math.round(memory.external / 1024 / 1024),
        eventLoopP50Ms: eventLoop.percentile(50) / 1e6,
        eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
        eventLoopMaxMs: eventLoop.max / 1e6,
        loadavg1m: loadavg[0],
        loadavg5m: loadavg[1],
        loadavg15m: loadavg[2],
        openFds: countOpenFds(),
        sockstat: readSockstat(),
        hostMemTotalMb: hostMem?.totalMb ?? null,
        hostMemAvailableMb: hostMem?.availableMb ?? null,
        hostCpuUsedUs: hostCpu?.usedUs ?? null,
        hostCpuTotalUs: hostCpu?.totalUs ?? null,
        cgroupMemLimitMb,
        cgroupCpuLimitCores,
      };
      eventLoop.reset();
      return sample;
    },
    stop() {
      eventLoop.disable();
    },
  };
}
