import { promises as fs } from 'node:fs';
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
  sample(): Promise<BenchmarkSystemMetricsSample>;
  stop(): void;
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function readSockstat(): Promise<Record<string, number> | null> {
  const data = await readTextFile('/proc/net/sockstat');
  if (!data) return null;
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
}

async function countOpenFds(): Promise<number | null> {
  try {
    const entries = await fs.readdir('/proc/self/fd');
    return entries.length;
  } catch {
    return null;
  }
}

async function readHostMemInfo(): Promise<{ totalMb: number; availableMb: number } | null> {
  const data = await readTextFile('/proc/meminfo');
  if (!data) return null;
  const total = data.match(/^MemTotal:\s+(\d+)\s*kB/m);
  const available = data.match(/^MemAvailable:\s+(\d+)\s*kB/m);
  if (!total || !available) return null;
  return {
    totalMb: Math.round(Number.parseInt(total[1], 10) / 1024),
    availableMb: Math.round(Number.parseInt(available[1], 10) / 1024),
  };
}

// user nice system idle iowait irq softirq steal [guest guest_nice], in jiffies.
async function readHostCpuJiffies(): Promise<number[] | null> {
  const data = await readTextFile('/proc/stat');
  if (!data) return null;
  const line = data.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  return line.trim().split(/\s+/).slice(1).map((v) => Number.parseInt(v, 10));
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

interface CgroupPaths {
  v2: string;
  controllers: Map<string, string>;
}

// The process's own control files aren't always at the cgroup fs root: under a
// nested cgroup (no namespacing) they live at `<root>/<relative>/...`. Parse
// the relative path per controller from /proc/self/cgroup, defaulting to the
// root so hosts that *do* namespace the cgroup (relative path "/") still work.
// A limit set on any ancestor also constrains us, so callers walk up the tree
// and take the tightest — reading only the leaf would miss a parent's ceiling.
async function cgroupRelativePaths(): Promise<CgroupPaths> {
  const controllers = new Map<string, string>();
  let v2 = '';
  try {
    const data = await fs.readFile('/proc/self/cgroup', 'utf-8');
    for (const line of data.split('\n')) {
      // Format: hierarchy-id:controller-list:relative-path
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const rest = line.slice(idx + 1);
      const sep = rest.indexOf(':');
      if (sep < 0) continue;
      const controllerList = rest.slice(0, sep);
      const relPath = rest.slice(sep + 1);
      if (controllerList === '') {
        // The cgroup v2 unified hierarchy (empty controller field).
        v2 = relPath;
      } else {
        for (const c of controllerList.split(',')) controllers.set(c, relPath);
      }
    }
  } catch {
    // No /proc/self/cgroup (non-Linux) — fall back to the fs root for everything.
  }
  return { v2, controllers };
}

// Every directory from the process's own cgroup up to (and including) the fs
// root. The effective limit is the tightest set anywhere along this ancestry,
// so callers read each level and take the minimum; order doesn't matter.
//
// Known limitation: callers pass the conventional mount points (`/sys/fs/cgroup`
// for v2, `/sys/fs/cgroup/<controller>` for v1) rather than discovering them
// from /proc/self/mountinfo. Relocated, co-mounted, or subtree-mounted
// controllers therefore read as null (unknown) — a safe degrade, never a wrong
// number. Parsing mountinfo would generalize this but risks resolving the wrong
// directory on a parse slip, so it's intentionally left out.
function cgroupDirsToRoot(mountRoot: string, relPath: string): string[] {
  const dirs: string[] = [mountRoot];
  let current = mountRoot;
  for (const seg of relPath.split('/').filter((s) => s.length > 0)) {
    current = `${current}/${seg}`;
    dirs.push(current);
  }
  return dirs;
}

// The tightest (minimum) of a and b, treating null as "no limit at this level".
function tighter(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

async function readCgroupMemLimitMb(paths: CgroupPaths): Promise<number | null> {
  let limit: number | null = null;
  for (const dir of cgroupDirsToRoot('/sys/fs/cgroup', paths.v2)) {
    const raw = await readTextFile(`${dir}/memory.max`);
    if (raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed === 'max') continue; // unlimited here — an ancestor may still cap us.
    const bytes = Number.parseInt(trimmed, 10);
    if (Number.isFinite(bytes)) limit = tighter(limit, Math.round(bytes / 1024 / 1024));
  }
  if (limit !== null) return limit;
  const relPath = paths.controllers.get('memory') ?? '';
  for (const dir of cgroupDirsToRoot('/sys/fs/cgroup/memory', relPath)) {
    const raw = await readTextFile(`${dir}/memory.limit_in_bytes`);
    if (raw === null) continue;
    const bytes = Number.parseInt(raw.trim(), 10);
    // v1 has no "unlimited" string; it reports a near-2^63 sentinel instead.
    if (!Number.isFinite(bytes) || bytes > 1e15) continue;
    limit = tighter(limit, Math.round(bytes / 1024 / 1024));
  }
  return limit;
}

async function readCgroupCpuLimitCores(paths: CgroupPaths): Promise<number | null> {
  let limit: number | null = null;
  for (const dir of cgroupDirsToRoot('/sys/fs/cgroup', paths.v2)) {
    const raw = await readTextFile(`${dir}/cpu.max`);
    if (raw === null) continue;
    const [quotaRaw, periodRaw] = raw.trim().split(/\s+/);
    if (quotaRaw === 'max') continue; // unlimited here — an ancestor may still cap us.
    const quota = Number.parseInt(quotaRaw, 10);
    const period = Number.parseInt(periodRaw, 10);
    if (Number.isFinite(quota) && period > 0) limit = tighter(limit, quota / period);
  }
  if (limit !== null) return limit;
  const relPath = paths.controllers.get('cpu') ?? '';
  for (const dir of cgroupDirsToRoot('/sys/fs/cgroup/cpu', relPath)) {
    const quotaRaw = await readTextFile(`${dir}/cpu.cfs_quota_us`);
    if (quotaRaw === null) continue;
    const quota = Number.parseInt(quotaRaw.trim(), 10);
    if (!Number.isFinite(quota) || quota <= 0) continue; // -1 == unlimited here.
    const periodRaw = await readTextFile(`${dir}/cpu.cfs_period_us`);
    if (periodRaw === null) continue;
    const period = Number.parseInt(periodRaw.trim(), 10);
    if (period > 0) limit = tighter(limit, quota / period);
  }
  return limit;
}

export function createSystemMetricsCollector(): BenchmarkSystemMetricsCollector {
  const startedAt = Date.now();
  const cpuBaseline = process.cpuUsage();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();

  // Capture the host CPU baseline once at creation time so cumulative host
  // CPU usage covers the full collector lifetime, not just from the first sample.
  const hostCpuBaselinePromise: Promise<number[] | null> = readHostCpuJiffies().catch(() => null);
  let cgroupPaths: CgroupPaths | null = null;
  let cachedCgroupMemLimitMb: number | null | undefined;
  let cachedCgroupCpuLimitCores: number | null | undefined;

  return {
    async sample() {
      const cpu = process.cpuUsage(cpuBaseline);
      const memory = process.memoryUsage();
      const loadavg = os.loadavg();

      const [hostMem, hostCpuJiffies, openFds, sockstat, hostCpuBaseline] = await Promise.all([
        readHostMemInfo(),
        readHostCpuJiffies(),
        countOpenFds(),
        readSockstat(),
        hostCpuBaselinePromise,
      ]);

      const hostCpu = hostCpuBaseline && hostCpuJiffies ? hostCpuUsageSince(hostCpuBaseline, hostCpuJiffies) : null;

      if (!cgroupPaths) {
        cgroupPaths = await cgroupRelativePaths();
      }

      if (cachedCgroupMemLimitMb === undefined) {
        cachedCgroupMemLimitMb = await readCgroupMemLimitMb(cgroupPaths);
      }
      if (cachedCgroupCpuLimitCores === undefined) {
        cachedCgroupCpuLimitCores = await readCgroupCpuLimitCores(cgroupPaths);
      }

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
        openFds,
        sockstat,
        hostMemTotalMb: hostMem?.totalMb ?? null,
        hostMemAvailableMb: hostMem?.availableMb ?? null,
        hostCpuUsedUs: hostCpu?.usedUs ?? null,
        hostCpuTotalUs: hostCpu?.totalUs ?? null,
        cgroupMemLimitMb: cachedCgroupMemLimitMb ?? null,
        cgroupCpuLimitCores: cachedCgroupCpuLimitCores ?? null,
      };
      eventLoop.reset();
      return sample;
    },
    stop() {
      eventLoop.disable();
    },
  };
}
