/**
 * Shared helpers for the sandbox-snapshot suite: the ComputeSDK sandbox /
 * snapshot interfaces the benchmarks duck-type against, deterministic
 * filesystem populate/verify routines, and restore-option construction.
 */

import { posix } from 'node:path';

export const CREATE_TIMEOUT_MS = 120_000;
// Populate does an npm install plus several exec roundtrips — inherently
// slower than create, so it gets its own, larger budget.
export const POPULATE_TIMEOUT_MS = 300_000;
export const DESTROY_TIMEOUT_MS = 15_000;
export const DEFAULT_DOWNTIME_MS = 60_000;

export interface SnapshotSandbox {
  sandboxId: string;
  runCommand(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  filesystem: {
    mkdir(path: string): Promise<void>;
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };
  destroy(): Promise<unknown>;
}

export interface Compute {
  sandbox: {
    create(options?: Record<string, any>): Promise<SnapshotSandbox>;
    /** Reattach to a live (or paused/persistent) box by id; null when gone. */
    getById?(sandboxId: string): Promise<SnapshotSandbox | null>;
  };
  snapshot?: {
    create(
      sandboxId: string,
      options?: { name?: string; metadata?: Record<string, string> },
    ): Promise<{ id: string }>;
    list?(options?: { instanceId?: string }): Promise<Array<{ id: string }>>;
    delete(snapshotId: string): Promise<unknown>;
  };
}

export function resolveDowntimeMs(): number {
  const parsed = Number(process.env.BENCH_DOWNTIME_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DOWNTIME_MS;
}

/** Deterministic repeated pattern; avoids generating random strings client-side. */
export function deterministicContent(sizeBytes: number): string {
  const chunk = 'x'.repeat(1024);
  return chunk.repeat(Math.ceil(sizeBytes / chunk.length)).slice(0, sizeBytes);
}

export interface FileExpectation {
  path: string;
  content: string;
}

/** Standard deterministic file set used by every suite for comparability. */
export function buildExpectedFiles(
  baseDir: string,
  fileCount: number,
  fileSizeBytes: number,
  markerFile: string,
  markerContent: string,
): FileExpectation[] {
  const content = deterministicContent(fileSizeBytes);
  return [
    ...Array.from({ length: fileCount }, (_, i) => ({
      path: `${baseDir}/file-${i}.txt`,
      content,
    })),
    { path: markerFile, content: markerContent },
  ];
}

/**
 * Resolve the command working directory via `pwd`. Usually persistent and
 * writable, but not necessarily in the filesystem API's allowed roots;
 * snapshot payloads use resolveSnapshotDir() for configured workspaces.
 */
export async function resolveWorkdir(
  sandbox: Pick<SnapshotSandbox, 'runCommand'>,
  timeoutMs: number = CREATE_TIMEOUT_MS,
): Promise<string> {
  const res = await sandbox.runCommand('pwd', { timeout: timeoutMs });
  const dir = (res.stdout ?? '').trim().split('\n')[0];
  return dir || '/root';
}

export async function populateFilesystem(
  sandbox: SnapshotSandbox,
  baseDir: string,
  expected: FileExpectation[],
): Promise<void> {
  await sandbox.filesystem.mkdir(baseDir);
  await Promise.all(
    expected.map((f) => sandbox.filesystem.writeFile(f.path, f.content)),
  );
}

export interface VerifyOutcome {
  /** Every expected file matched byte-for-byte AND every absent path was absent. */
  allMatched: boolean;
  /** Expected files whose contents matched. */
  filesVerified: number;
  verifiedBytes: number;
  /** Expected paths with wrong or missing content. */
  mismatched: string[];
  /** Paths expected to be absent that were present. */
  unexpectedlyPresent: string[];
}

export async function verifyFiles(
  sandbox: SnapshotSandbox,
  expected: FileExpectation[],
  absentPaths: string[] = [],
): Promise<VerifyOutcome> {
  const reads = await Promise.all(
    expected.map(async (f) => {
      try {
        const content = await sandbox.filesystem.readFile(f.path);
        return { path: f.path, matched: content === f.content, bytes: content.length };
      } catch {
        return { path: f.path, matched: false, bytes: 0 };
      }
    }),
  );

  const presence = await Promise.all(
    absentPaths.map(async (p) => {
      try {
        return { path: p, present: await sandbox.filesystem.exists(p) };
      } catch {
        return { path: p, present: false };
      }
    }),
  );

  const mismatched = reads.filter((r) => !r.matched).map((r) => r.path);
  const unexpectedlyPresent = presence.filter((p) => p.present).map((p) => p.path);
  const filesVerified = reads.length - mismatched.length;
  const verifiedBytes = reads.reduce((sum, r) => sum + (r.matched ? r.bytes : 0), 0);

  return {
    allMatched: mismatched.length === 0 && unexpectedlyPresent.length === 0,
    filesVerified,
    verifiedBytes,
    mismatched,
    unexpectedlyPresent,
  };
}

/**
 * templateId/image select the boot base for a fresh sandbox; the snapshot
 * replaces them on restore (E2B prefers templateId over snapshotId when both
 * are present, which silently boots the base template instead).
 */
export function buildRestoreOptions(
  sandboxOptions: Record<string, any> | undefined,
  snapshotId: string,
): Record<string, any> {
  const restoreOptions: Record<string, any> = { ...sandboxOptions, snapshotId };
  delete restoreOptions.templateId;
  delete restoreOptions.image;
  return restoreOptions;
}

export function newRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- SDK snapshot capability metadata ---------------------------------------

/**
 * What a provider declares its snapshots keep (computesdk
 * `compute.snapshot.capabilities`, added in computesdk#1075). Read
 * defensively: older SDK releases expose nothing and every field may be
 * missing.
 */
export interface SnapshotCapabilities {
  /** `rootfs`: the whole root filesystem. `volume`: only the volume at `path`. */
  scope?: 'rootfs' | 'volume';
  /** Directory whose contents survive a restore. */
  path?: string;
  /** Whether running processes and memory survive a restore. */
  memory?: boolean;
  /** Whether `snapshot.create` stops or destroys the source instance. */
  destroysSource?: boolean;
  /** What `snapshot.create` leaves of the source. */
  source?: 'kept' | 'stopped' | 'destroyed';
  /** Paths inside `scope` that a restore does not keep. */
  excludes?: string[];
  /** Whether one snapshot of a live source restores into many instances. */
  fork?: boolean;
  /** `eventual`: wait on `snapshot.waitUntilReady(id)` before restoring. */
  readiness?: 'immediate' | 'eventual';
  /** Create options the source instance needs for snapshots to work. */
  createOptions?: Record<string, unknown>;
}

export function snapshotCapabilities(compute: unknown): SnapshotCapabilities | undefined {
  const caps = (compute as { snapshot?: { capabilities?: unknown } } | undefined)?.snapshot?.capabilities;
  return caps && typeof caps === 'object' ? (caps as SnapshotCapabilities) : undefined;
}

/** Source create options plus whatever the provider declares snapshots need. */
export function withSnapshotCreateOptions(
  compute: unknown,
  options?: Record<string, any>,
): Record<string, any> | undefined {
  const extra = snapshotCapabilities(compute)?.createOptions;
  return extra ? { ...options, ...extra } : options;
}

/** Cap on `snapshot.waitUntilReady` for eventual-readiness providers. */
export const SNAPSHOT_READY_TIMEOUT_MS = 5 * 60_000;

export type SnapshotSource = 'kept' | 'stopped' | 'destroyed';

/** What `snapshot.create` leaves of the source; undefined when undeclared. */
export function snapshotSource(compute: unknown): SnapshotSource | undefined {
  const caps = snapshotCapabilities(compute);
  if (!caps) return undefined;
  if (caps.source === 'kept' || caps.source === 'stopped' || caps.source === 'destroyed') return caps.source;
  if (typeof caps.destroysSource === 'boolean') return caps.destroysSource ? 'destroyed' : 'kept';
  return undefined;
}

/** Whether the source can still be read or mutated after `snapshot.create`. */
export function sourceKept(compute: unknown): boolean {
  const source = snapshotSource(compute);
  return source === undefined || source === 'kept';
}

function snapshotExcludes(compute: unknown): string[] {
  const ex = snapshotCapabilities(compute)?.excludes;
  return Array.isArray(ex) ? ex.filter((e): e is string => typeof e === 'string' && e.length > 0) : [];
}

function stripSlash(dir: string): string {
  return dir.replace(/\/+$/, '') || '/';
}

/** `dir` is an excluded path or lies under one. */
export function isExcludedDir(dir: string, excludes: string[]): boolean {
  const d = stripSlash(dir);
  return excludes.some((e) => {
    const x = stripSlash(e);
    return x === '/' || d === x || d.startsWith(`${x}/`);
  });
}

export type SnapshotDirSource = 'capability' | 'configured' | 'workdir' | 'home' | 'root' | 'var-tmp';

/**
 * Directory snapshot markers go under: the provider's declared snapshot path
 * when it has one (volume-scoped snapshots only keep that dir), otherwise
 * a configured API-accessible workspace or the `pwd` workdir. A dir under a
 * declared `excludes` path (lost on
 * restore) falls through to `$HOME`, then `/root`, then `/var/tmp`.
 */
export async function resolveSnapshotDir(
  sandbox: Pick<SnapshotSandbox, 'runCommand'>,
  compute: unknown,
  timeoutMs: number = CREATE_TIMEOUT_MS,
  snapshotWorkdir?: string,
): Promise<{ dir: string; source: SnapshotDirSource }> {
  const excludes = snapshotExcludes(compute);
  const ok = (dir: string | undefined): dir is string => !!dir && dir.startsWith('/') && !isExcludedDir(dir, excludes);
  const declared = snapshotCapabilities(compute)?.path;
  if (declared && ok(declared)) return { dir: stripSlash(declared), source: 'capability' };
  if (snapshotWorkdir !== undefined) {
    const dir = posix.normalize(snapshotWorkdir);
    if (!ok(dir)) throw new Error(`Invalid snapshot workdir: ${snapshotWorkdir}`);
    return { dir: stripSlash(dir), source: 'configured' };
  }
  const workdir = await resolveWorkdir(sandbox, timeoutMs);
  if (ok(workdir)) return { dir: workdir, source: 'workdir' };
  const res = await sandbox.runCommand('echo "$HOME"', { timeout: timeoutMs }).catch(() => null);
  const home = (res?.stdout ?? '').trim().split('\n')[0];
  if (ok(home)) return { dir: stripSlash(home), source: 'home' };
  if (ok('/root')) return { dir: '/root', source: 'root' };
  return { dir: '/var/tmp', source: 'var-tmp' };
}

/**
 * Waits for an `eventual`-readiness snapshot to become restorable. Returns
 * the wait in ms, or null when the provider declares immediate readiness
 * (or exposes no wait verb).
 */
export async function waitForSnapshotReady(
  compute: unknown,
  snapshotId: string,
  timeoutMs: number,
): Promise<number | null> {
  if (snapshotCapabilities(compute)?.readiness !== 'eventual') return null;
  const snap = (compute as { snapshot?: { waitUntilReady?: unknown } } | undefined)?.snapshot;
  if (typeof snap?.waitUntilReady !== 'function') return null;
  const start = performance.now();
  await (snap.waitUntilReady as (id: string, o: { timeoutMs: number }) => Promise<unknown>).call(
    snap,
    snapshotId,
    { timeoutMs },
  );
  return performance.now() - start;
}

/** Flat, JSON-safe capability fields for task metadata. */
export function snapshotCapabilityMeta(compute: unknown): Record<string, string | boolean | null> {
  const caps = snapshotCapabilities(compute);
  const excludes = snapshotExcludes(compute);
  return {
    snapshotScope: caps?.scope ?? null,
    snapshotPath: caps?.path ?? null,
    snapshotKeepsMemory: caps?.memory ?? null,
    snapshotDestroysSource: caps?.destroysSource ?? null,
    snapshotSource: snapshotSource(compute) ?? null,
    snapshotExcludes: excludes.length ? excludes.join(',') : null,
    snapshotFork: typeof caps?.fork === 'boolean' ? caps.fork : null,
    snapshotReadiness: caps?.readiness ?? null,
  };
}

/**
 * In-guest source integrity across a snapshot. Declarations (`source`,
 * `destroysSource`) never excuse this check: a snapshot that stops or kills
 * the source (e.g. Vercel's snapshot stops the box; a persistent box
 * auto-resumes on the next call, so `echo alive` would still pass) fails
 * with SOURCE_STOPPED_CODE.
 */
export const SOURCE_STOPPED_CODE = 'source_stopped_by_snapshot';
const HEARTBEAT_SETTLE_MS = 300;
const HEARTBEAT_GROWTH_MS = 500;

interface CommandSandbox {
  sandboxId: string;
  runCommand(cmd: string, opts?: { timeout?: number }): Promise<{ exitCode: number; stdout?: string }>;
}

export interface SourceHeartbeat {
  pid: number;
  file: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Starts a detached guest loop appending a ms timestamp to a file every
 * ~100 ms (seconds*1000 where `date` lacks %N). Returns its guest PID.
 */
export async function startSourceHeartbeat(
  sandbox: CommandSandbox,
  runId: string,
  timeoutMs: number = CREATE_TIMEOUT_MS,
): Promise<SourceHeartbeat> {
  const loop =
    'echo "$$" > "$2"; while :; do t=$(date +%s%3N); case "$t" in *N*) t=$(($(date +%s)*1000));; esac; echo "$t" >> "$1"; sleep 0.1; done';
  const cmd =
    `f="\${TMPDIR:-/tmp}/bench-src-hb-${runId}"; p="$f.pid"; : > "$f"; : > "$p"; ` +
    `S=; command -v setsid >/dev/null 2>&1 && S=setsid; ` +
    `$S nohup sh -c '${loop}' hb "$f" "$p" >/dev/null 2>&1 < /dev/null & ` +
    `i=0; while [ ! -s "$p" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; ` +
    `cat "$p"; rm -f "$p"; echo "$f"`;
  const res = await sandbox.runCommand(cmd, { timeout: timeoutMs });
  const [pidLine, file] = (res.stdout ?? '').trim().split('\n').map((s) => s.trim());
  const pid = Number(pidLine);
  if (res.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0 || !file) {
    throw new Error(`source heartbeat failed to start: ${JSON.stringify(res.stdout ?? '')}`);
  }
  await sleep(HEARTBEAT_SETTLE_MS);
  const check = await sandbox.runCommand(`kill -0 ${pid} && wc -l < "${file}"`, { timeout: timeoutMs });
  if (check.exitCode !== 0 || !(Number((check.stdout ?? '').trim()) > 0)) {
    throw new Error('source heartbeat failed to start: no ticks before snapshot');
  }
  return { pid, file };
}

export interface SourceIntegrity {
  sourceIntact: boolean;
  /** Longest gap between heartbeat ticks spanning the snapshot (guest clock). */
  snapshotFreezeMs: number | null;
  /** getById proved the source no longer exists; nothing to destroy. */
  sourceGone: boolean;
  reason: string | null;
}

function maxTickGap(lines: string[]): number | null {
  const ts = lines.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  let max: number | null = null;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (max === null || gap > max) max = gap;
  }
  return max;
}

/**
 * After the snapshot (and any readiness wait), before teardown: the
 * heartbeat PID must still be alive and its file still growing.
 */
export async function checkSourceIntact(
  compute: unknown,
  sandbox: CommandSandbox,
  hb: SourceHeartbeat,
  timeoutMs: number = CREATE_TIMEOUT_MS,
): Promise<SourceIntegrity> {
  let target: CommandSandbox = sandbox;
  if (snapshotSource(compute) === 'destroyed') {
    const getById = (compute as Compute | undefined)?.sandbox?.getById;
    if (typeof getById === 'function') {
      // Only a resolved null/undefined is proof the source is gone; a
      // rejected lookup (transient API error) falls through to the probes.
      const lookup = await getById.call((compute as Compute).sandbox, sandbox.sandboxId).then(
        (found) => ({ ok: true as const, found }),
        () => ({ ok: false as const, found: null }),
      );
      const found = lookup.found;
      if (lookup.ok && !found) {
        return { sourceIntact: false, snapshotFreezeMs: null, sourceGone: true, reason: 'source destroyed by snapshot (getById found nothing)' };
      }
      if (found) target = found;
    }
  }
  const probe = `kill -0 ${hb.pid} 2>/dev/null && echo alive || echo dead; wc -l < "${hb.file}" 2>/dev/null || echo 0`;
  const parse = (out: string | undefined) => {
    const lines = (out ?? '').trim().split('\n').map((s) => s.trim());
    return { alive: lines[0] === 'alive', count: Number(lines[1]) || 0, ticks: lines.slice(2) };
  };
  let first: ReturnType<typeof parse>;
  let second: ReturnType<typeof parse>;
  try {
    first = parse((await target.runCommand(probe, { timeout: timeoutMs })).stdout);
    await sleep(HEARTBEAT_GROWTH_MS);
    second = parse((await target.runCommand(`${probe}; cat "${hb.file}" 2>/dev/null`, { timeout: timeoutMs })).stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Not proof the source is gone (transient error, or a stopped box that
    // refuses commands): cleanup still makes a best-effort destroy().
    return { sourceIntact: false, snapshotFreezeMs: null, sourceGone: false, reason: `source unreachable after snapshot: ${msg}` };
  }
  const snapshotFreezeMs = maxTickGap(second.ticks);
  const growing = second.count > first.count;
  if (first.alive && second.alive && growing) {
    return { sourceIntact: true, snapshotFreezeMs, sourceGone: false, reason: null };
  }
  const reason = !first.alive || !second.alive
    ? `heartbeat pid ${hb.pid} gone after snapshot`
    : `heartbeat stopped (${first.count} -> ${second.count} ticks in ${HEARTBEAT_GROWTH_MS}ms)`;
  return { sourceIntact: false, snapshotFreezeMs, sourceGone: false, reason };
}
