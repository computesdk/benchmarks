import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeStats } from '../src/util/stats.js';

// ---------------------------------------------------------------------------
// Suite configuration
// ---------------------------------------------------------------------------

/**
 * Each task creates one fresh sandbox, uploads `docker-preflight.sh`, runs it,
 * and parses its PASS/WARN/FAIL verdict lines. The script is the source of
 * truth on the guest side; this module is the source of truth on how the
 * printed checks map to named capabilities and scores.
 */
export const SUITE_CONFIG = {
  id: 'os-capabilities' as const,
  label: 'Sandbox OS Capabilities — dockerd/container preflight probe',
  unit: 'score' as const,
  higherIsBetter: true,
  timeoutMs: 300_000,
};

/**
 * Named capabilities extracted from the preflight output. `match` substrings
 * are checked against PASS lines only — a capability is true when any of the
 * alternates passed. FAIL/WARN lines never satisfy a capability.
 */
export interface CapabilityCheck {
  key: string;
  label: string;
  match: string[];
}

export const CAPABILITY_CHECKS: CapabilityCheck[] = [
  { key: 'hwVirt', label: 'Hardware virtualization (vmx/svm)', match: ['cpu exposes hardware virtualization'] },
  { key: 'userns', label: 'User namespaces', match: ['create user ns'] },
  { key: 'mntns', label: 'Mount namespaces', match: ['create mnt ns'] },
  { key: 'utsns', label: 'UTS namespaces', match: ['create uts ns'] },
  { key: 'ipcns', label: 'IPC namespaces', match: ['create ipc ns'] },
  { key: 'netns', label: 'Network namespaces', match: ['create net ns'] },
  { key: 'pidns', label: 'PID namespaces', match: ['create pid ns'] },
  { key: 'cgroupV2', label: 'cgroup v2 (unified)', match: ['cgroup v2 (unified)'] },
  { key: 'cgroupWritable', label: 'cgroup fs writable', match: ['/sys/fs/cgroup is writable'] },
  { key: 'kvm', label: '/dev/kvm usable', match: ['/dev/kvm readable+writable'] },
  { key: 'fuse', label: '/dev/fuse usable', match: ['/dev/fuse accessible'] },
  { key: 'fuseOverlayfs', label: 'fuse-overlayfs mount', match: ['functional fuse-overlayfs mount works'] },
  { key: 'tun', label: '/dev/net/tun', match: ['/dev/net/tun exists'] },
  { key: 'loop', label: 'Loop devices', match: ['loop devices usable'] },
  { key: 'mknod', label: 'mknod (device cgroup)', match: ['mknod works'] },
  { key: 'overlayfs', label: 'overlayfs kernel support', match: ['overlayfs supported by kernel', 'overlayfs loaded via modprobe'] },
  { key: 'overlayMount', label: 'Overlay mount', match: ['functional overlay mount works'] },
  { key: 'tmpfsMount', label: 'tmpfs mount', match: ['tmpfs mount works'] },
  { key: 'veth', label: 'veth pairs', match: ['veth pair creatable'] },
  { key: 'bridge', label: 'bridge devices', match: ['bridge creatable'] },
  { key: 'nat', label: 'NAT chains', match: ['create NAT chain'] },
  { key: 'masquerade', label: 'MASQUERADE egress NAT', match: ['MASQUERADE rule'] },
  { key: 'dnat', label: 'DNAT port publishing', match: ['DNAT rule'] },
  { key: 'dnsRedirect', label: 'Embedded-DNS redirect', match: ['DNS redirect rule'] },
  { key: 'conntrack', label: 'conntrack match', match: ['conntrack match'] },
  { key: 'forwardChain', label: 'filter/FORWARD chain', match: ['filter table + FORWARD chain'] },
  { key: 'brNetfilter', label: 'br_netfilter', match: ['br_netfilter sysctls present', 'br_netfilter module loaded'] },
  { key: 'ipForward', label: 'ip_forward writable', match: ['ip_forward writable', 'can write ip_forward'] },
  { key: 'capSysAdmin', label: 'CAP_SYS_ADMIN', match: ['capability: CAP_SYS_ADMIN'] },
  { key: 'capNetAdmin', label: 'CAP_NET_ADMIN', match: ['capability: CAP_NET_ADMIN'] },
  { key: 'capMknod', label: 'CAP_MKNOD', match: ['capability: CAP_MKNOD'] },
  { key: 'clone3', label: 'clone3 syscall', match: ['clone3 syscall present'] },
  { key: 'root', label: 'running as root', match: ['running as root'] },
  { key: 'dns', label: 'DNS resolution', match: ['DNS resolves'] },
  { key: 'outboundHttps', label: 'Outbound HTTPS (registry)', match: ['outbound HTTPS works'] },
  { key: 'privilegedPort', label: 'bind privileged ports', match: ['can bind privileged port :80'] },
  { key: 'dockerdBinary', label: 'dockerd binary', match: ['found: dockerd'] },
  { key: 'dockerRun', label: 'docker run works', match: ['functional: docker run works'] },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedPreflight {
  passCount: number;
  warnCount: number;
  failCount: number;
  checksTotal: number;
  /** Names of the FAIL lines (check descriptions), in output order. */
  failures: string[];
  /** Script exit code as reported by runCommand. */
  exitCode: number;
  /** Named capability flags extracted from PASS lines. */
  capabilities: Record<string, boolean>;
  /** Keys from CAPABILITY_CHECKS that did not pass. */
  missingCapabilities: string[];
  /** Final verdict line from the script's summary, when present. */
  verdict: string;
}

export interface OsCapabilitiesWorkloadMeta {
  taskIndex?: number;
  provider?: string;
  /** The preflight script ran to completion and produced a parseable verdict. */
  preflightRan?: boolean;
  /** The script exited 0 — no FAIL checks; dockerd should work here. */
  dockerdReady?: boolean;
  preflightExitCode?: number;
  checksTotal?: number;
  passCount?: number;
  warnCount?: number;
  failCount?: number;
  /** 100 * (pass + 0.5*warn) / total — the scored capability axis. */
  capabilityScore?: number;
  preflightMs?: number;
  createMs?: number;
  destroyMs?: number;
  wallClockMs?: number;
  /** '; '-joined FAIL check descriptions (truncated). */
  failures?: string;
  /** Comma-separated CAPABILITY_CHECKS keys that did not pass. */
  missingCaps?: string;
  verdict?: string;
  /** Stage that failed: create | inject | run | destroy. */
  failedStage?: string;
  errorMessage?: string;
  destroyFailed?: boolean;
  destroyError?: string;
  sdkAsyncError?: string;
  sdkAsyncErrorCount?: number;
  [key: string]: number | string | boolean | undefined;
}

export interface OsCapabilitiesWorkloadData {
  ok: true;
  suite: 'os-capabilities';
  metric: { value: number; unit: 'score'; higherIsBetter: true };
  meta: OsCapabilitiesWorkloadMeta;
}

export interface OsCapabilitiesWorkloadFailure {
  ok: false;
  suite: 'os-capabilities';
  reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
  error?: string;
  meta: OsCapabilitiesWorkloadMeta;
}

export type OsCapabilitiesWorkloadResult = OsCapabilitiesWorkloadData | OsCapabilitiesWorkloadFailure;

export interface OsCapabilitiesMetricSummary {
  median: number;
  p95?: number;
  p99?: number;
  min?: number;
  max?: number;
  avg?: number;
}

export interface OsCapabilitiesSuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: OsCapabilitiesWorkloadMeta;
}

export interface OsCapabilitiesBenchmarkResult {
  provider: string;
  suite: 'os-capabilities';
  mode: 'os-capabilities';
  iterations: OsCapabilitiesWorkloadResult[];
  summary: OsCapabilitiesSuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface SerializedOsCapabilitiesBenchmarkResult {
  provider: string;
  suite: 'os-capabilities';
  mode: 'os-capabilities';
  iterations: OsCapabilitiesWorkloadResult[];
  summary: Record<string, OsCapabilitiesMetricSummary>;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  meta: OsCapabilitiesWorkloadMeta;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Parsing & scoring
// ---------------------------------------------------------------------------

/**
 * Parse the preflight script's output. Verdict lines are `PASS <text>`,
 * `WARN <text>`, `FAIL <text>` (colors only print on a tty, which runCommand
 * never is), `.... <info>` and `== <section> ==` decorations are ignored.
 */
export function parsePreflightOutput(output: string, exitCode: number): ParsedPreflight {
  const parsed: ParsedPreflight = {
    passCount: 0,
    warnCount: 0,
    failCount: 0,
    checksTotal: 0,
    failures: [],
    exitCode,
    capabilities: {},
    missingCapabilities: [],
    verdict: '',
  };

  const passLines: string[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('PASS ')) {
      parsed.passCount += 1;
      passLines.push(line.slice(5));
    } else if (line.startsWith('WARN ')) {
      parsed.warnCount += 1;
    } else if (line.startsWith('FAIL ')) {
      parsed.failCount += 1;
      parsed.failures.push(line.slice(5));
    }
  }
  parsed.checksTotal = parsed.passCount + parsed.warnCount + parsed.failCount;

  for (const check of CAPABILITY_CHECKS) {
    parsed.capabilities[check.key] = passLines.some((line) =>
      check.match.some((m) => line.includes(m)),
    );
  }
  parsed.missingCapabilities = CAPABILITY_CHECKS.filter((c) => !parsed.capabilities[c.key]).map((c) => c.key);

  if (output.includes('dockerd will NOT work on this host')) {
    parsed.verdict = 'blocked';
  } else if (output.includes('dockerd should work')) {
    parsed.verdict = 'degraded';
  } else if (output.includes('fully dockerd-capable')) {
    parsed.verdict = 'capable';
  }
  return parsed;
}

/**
 * Weighted capability score: a PASS counts 1, a WARN 0.5 (degraded path),
 * a FAIL 0. 0-100, higher better.
 */
export function capabilityScore(parsed: Pick<ParsedPreflight, 'passCount' | 'warnCount' | 'checksTotal'>): number {
  if (parsed.checksTotal === 0) return 0;
  return round(((parsed.passCount + 0.5 * parsed.warnCount) / parsed.checksTotal) * 100);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function iterationPassed(result: OsCapabilitiesWorkloadResult): boolean {
  if (!result.ok) return false;
  const meta = result.meta as OsCapabilitiesWorkloadMeta;
  return meta.preflightRan === true && meta.destroyFailed !== true;
}

/** Metrics written to the legacy JSON summary — the scored workload only. */
const SUMMARY_METRICS = [
  'capabilityScore',
  'preflightMs',
  'createMs',
  'passCount',
  'warnCount',
  'failCount',
] as const;

/**
 * Provider composite: median capabilityScore over passing probes, discounted
 * by probe success rate — a flaky provider that sometimes can't even run the
 * script lands below a stable lower-capability one.
 */
export function computeOsCapabilitiesStats(
  results: OsCapabilitiesWorkloadResult[],
): OsCapabilitiesSuiteStats {
  const ok = results.filter(iterationPassed);
  const total = results.length;

  if (ok.length === 0) {
    return {
      median: 0, p95: 0, p99: 0, min: 0, max: 0,
      successRate: 0, n: 0, scoreBeforeReliability: 0,
      compositeScore: 0, meta: deriveMeta(results, ok),
    };
  }

  const scores = ok
    .map((r) => (r.meta as OsCapabilitiesWorkloadMeta)?.capabilityScore)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);

  const median = scores.length % 2 === 0
    ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
    : scores[Math.floor(scores.length / 2)];

  const stats = computeStats(scores, 0);
  const successRate = ok.length / total;
  const scoreBeforeReliability = median;

  return {
    median,
    p95: stats.p95,
    p99: stats.p99,
    min: scores[0] ?? 0,
    max: scores[scores.length - 1] ?? 0,
    successRate,
    n: ok.length,
    scoreBeforeReliability,
    compositeScore: scoreBeforeReliability * successRate,
    meta: deriveMeta(results, ok),
  };
}

/**
 * Provider-level summary meta: dockerd readiness across probes, capability
 * keys that never passed, the last passing verdict, and the last failing
 * record's diagnostics for the notes column.
 */
function deriveMeta(
  results: OsCapabilitiesWorkloadResult[],
  ok: OsCapabilitiesWorkloadResult[],
): OsCapabilitiesWorkloadMeta {
  const meta: OsCapabilitiesWorkloadMeta = {};

  const lastOk = [...ok].reverse().find((r) => r.meta);
  if (lastOk) {
    const m = lastOk.meta as OsCapabilitiesWorkloadMeta;
    meta.dockerdReady = ok.every((r) => (r.meta as OsCapabilitiesWorkloadMeta)?.dockerdReady === true);
    if (m.verdict) meta.verdict = m.verdict;
    if (m.checksTotal !== undefined) meta.checksTotal = m.checksTotal;
    meta.passCount = ok.reduce((a, r) => a + (((r.meta as OsCapabilitiesWorkloadMeta)?.passCount as number) ?? 0), 0);
    meta.warnCount = ok.reduce((a, r) => a + (((r.meta as OsCapabilitiesWorkloadMeta)?.warnCount as number) ?? 0), 0);
    meta.failCount = ok.reduce((a, r) => a + (((r.meta as OsCapabilitiesWorkloadMeta)?.failCount as number) ?? 0), 0);
    // Capabilities that never passed on any probe.
    const neverPassed = CAPABILITY_CHECKS
      .filter((c) => !ok.some((r) => (r.meta as OsCapabilitiesWorkloadMeta)?.[`cap_${c.key}`] === true))
      .map((c) => c.key);
    if (neverPassed.length > 0) meta.missingCaps = neverPassed.join(',');
    const lastFailures = [...ok].reverse().find((r) => {
      const fm = r.meta as OsCapabilitiesWorkloadMeta;
      return typeof fm?.failures === 'string' && fm.failures.length > 0;
    });
    if (lastFailures) meta.failures = (lastFailures.meta as OsCapabilitiesWorkloadMeta).failures;
  } else {
    meta.dockerdReady = false;
  }

  const lastFailure = [...results].reverse().find((r) => !iterationPassed(r));
  if (lastFailure) {
    const m = lastFailure.meta as OsCapabilitiesWorkloadMeta;
    if (m?.failedStage) meta.failedStage = m.failedStage;
    if (m?.errorMessage) meta.errorMessage = m.errorMessage;
    if (m?.sdkAsyncError) meta.sdkAsyncError = m.sdkAsyncError;
    if (m?.destroyFailed) meta.destroyFailed = true;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

export async function writeOsCapabilitiesResultsJson(
  results: OsCapabilitiesBenchmarkResult[],
  outPath: string,
): Promise<void> {
  const cleanResults: SerializedOsCapabilitiesBenchmarkResult[] = results.map((r) => ({
    provider: r.provider,
    suite: r.suite,
    mode: r.mode,
    iterations: r.iterations.map((i) => {
      if (i.ok) {
        return {
          ok: true,
          suite: i.suite,
          metric: { value: round(i.metric.value), unit: i.metric.unit, higherIsBetter: i.metric.higherIsBetter },
          meta: i.meta,
        };
      }
      return {
        ok: false,
        suite: i.suite,
        reason: i.reason,
        ...(i.error ? { error: i.error } : {}),
        meta: i.meta,
      };
    }),
    summary: Object.fromEntries(
      SUMMARY_METRICS.map((m) => [m, roundStats(extractMetric(r.iterations, m))]),
    ),
    wallClockMs: round(r.wallClockMs),
    replicateMs: r.replicateMs.map(round),
    compositeScore: round(r.compositeScore),
    successRate: round(r.summary.successRate),
    n: r.summary.n,
    scoreBeforeReliability: round(r.summary.scoreBeforeReliability),
    meta: r.summary.meta ?? lastMeta(r.iterations) ?? {},
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: {
      mode: 'os-capabilities',
      unit: SUITE_CONFIG.unit,
      timeoutMs: SUITE_CONFIG.timeoutMs,
      capabilities: CAPABILITY_CHECKS.map((c) => c.key),
    },
    results: cleanResults,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractMetric(iterations: OsCapabilitiesWorkloadResult[], key: string): number[] {
  const values: number[] = [];
  for (const iteration of iterations) {
    if (!iterationPassed(iteration)) continue;
    const meta = iteration.meta as OsCapabilitiesWorkloadMeta;
    const v = meta?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      values.push(v);
    }
  }
  return values;
}

function roundStats(values: number[]): OsCapabilitiesMetricSummary {
  if (values.length === 0) return { median: 0 };
  const { median, p95, p99 } = computeStats(values);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: round(median),
    p95: round(p95),
    p99: round(p99),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    avg: round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

export function lastMeta(results: OsCapabilitiesWorkloadResult[]): OsCapabilitiesWorkloadMeta | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].meta) return results[i].meta;
  }
  return undefined;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
