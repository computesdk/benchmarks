/**
 * sandbox-soak suite: a long-running durability benchmark. A detached writer
 * inside a persistent sandbox appends an iterated SHA-256 chain
 * (H_n = sha256(H_{n-1})) to `<workdir>/soak-chain.log` at ~1 line/sec, and an
 * EXTERNAL checker (this bench) re-reads the new tail every CHECK_INTERVAL_MS
 * to confirm the VM stayed alive and the chain stayed consistent. Scheduled
 * workflow runs are daily ~6h "shifts"; each shift reattaches via
 * `compute.sandbox.getById`, verifies the chain incrementally (including the
 * lines written between shifts), and leaves the sandbox running. A 24-hour
 * (daily) epoch rolls the test over to a fresh sandbox. The soak is bound
 * to a single sandbox: `getById` returning a
 * different sandboxId than persisted (e.g. the provider quietly recreated
 * the box from a snapshot) is a recorded failure, not a continuation.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SuiteSpec } from '../src/util/suite.js';

export const SUITE_CONFIG = {
  id: 'soak' as const,
  slug: 'sandbox-soak',
  name: 'Sandbox Soak',
  resultsDir: 'results/sandbox_soak',
  defaultIterations: 1,
};

// --- Tunables (env-overridable; the workflow passes dispatch inputs) --------

export const DEFAULT_SHIFT_MS = 355 * 60_000; // ~5m short of the 6h cron cadence
export const DEFAULT_EPOCH_MS = 24 * 60 * 60_000; // daily soak
export const DEFAULT_CHECK_INTERVAL_MS = 60_000;

/** A hung sandbox fails the tick instead of the whole shift. */
export const TICK_TIMEOUT_MS = 30_000;
/** Cap on new chain lines consumed per tick (a tick normally sees ~60). */
export const TICK_MAX_LINES = 10_000;

/** Writer line rate used for coverage credit (the writer appends ~1 line/sec). */
export const LINE_RATE_SECONDS = 1;
/** A ts jump larger than this between consecutive verified lines counts as a pause gap. */
export const PAUSE_GAP_S = 5;

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const SOAK_SHIFT_MS = envMs('SOAK_SHIFT_MS', DEFAULT_SHIFT_MS);
export const SOAK_EPOCH_MS = envMs('SOAK_EPOCH_MS', DEFAULT_EPOCH_MS);
export const SOAK_CHECK_INTERVAL_MS = envMs('SOAK_CHECK_INTERVAL_MS', DEFAULT_CHECK_INTERVAL_MS);

/**
 * A chain head lagging more than ~2 tick intervals behind the GUEST clock =
 * stalled writer. Guest-relative on purpose: a box whose clock is skewed
 * from the host's still has an advancing writer; skew is reported apart.
 */
export const TICK_LAG_S = Math.ceil((2 * SOAK_CHECK_INTERVAL_MS) / 1000);

// --- Per-provider box lifetime ----------------------------------------------

/**
 * Longest sandbox lifetime each TTL-bound provider accepts at create, in ms.
 * Without a `timeout` these boxes end at the provider/adapter default (5–15
 * min), so a ~6h shift measures the default TTL instead of durability.
 * Sources: provider docs and live create probes (vercel 24h on Pro, modal
 * 24h, e2b 24h on Pro, isorun timeoutSec <= 86400).
 */
export const SOAK_MAX_LIFETIME_MS: Record<string, number> = {
  // Docs allow 24h on Pro, but the audit saw this account capped at 5h —
  // request what the account grants (shorter than the 5h55m shift).
  vercel: 5 * 3_600_000,
  modal: 24 * 3_600_000,
  e2b: 24 * 3_600_000,
  novita: 24 * 3_600_000,
  promigence: 24 * 3_600_000,
  isorun: 24 * 3_600_000,
  beam: 24 * 3_600_000,
  // Provider-reported cap (Superserve team, Nov 2026): create accepts
  // timeoutSeconds <= 21600 — requesting the shift + headroom (22,200s)
  // would be rejected.
  superserve: 6 * 3_600_000,
};

/** Attach + writer-check run before the shift window opens. */
export const SOAK_LIFETIME_HEADROOM_MS = 15 * 60_000;

/** `compute.sandbox.lifetime` as declared by the SDK (read defensively). */
export interface DeclaredLifetime {
  defaultMs?: number;
  maxMs?: number;
  extendable?: boolean;
}

export function declaredLifetime(compute: unknown): DeclaredLifetime | undefined {
  const l = (compute as { sandbox?: { lifetime?: unknown } } | undefined)?.sandbox?.lifetime;
  return l && typeof l === 'object' ? (l as DeclaredLifetime) : undefined;
}

const posMs = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

export interface SoakLifetime {
  /** Lifetime requested at create: min(provider max, shift + headroom). */
  lifetimeMs: number;
  /** Null when neither the SDK nor the bench table knows the provider's cap. */
  maxLifetimeMs: number | null;
  /** The provider's maximum cannot cover the shift: late ticks fail by design. */
  maxShorterThanShift: boolean;
  /** Where the maximum came from: the SDK's declared lifetime, the bench
   *  table, or none known (the shift is requested as-is). */
  source: 'sdk' | 'table' | 'requested';
  defaultLifetimeMs: number | null;
  extendable: boolean | null;
}

/**
 * Prefers the SDK's declared `lifetime.maxMs`, falling back to the bench
 * table. With no known maximum the shift + headroom is still requested:
 * omitting `timeout` leaves the box on the adapter default (tenki 30 min,
 * namespace 1h, tensorlake 5 min), which measures that default instead of
 * durability. A provider that rejects the request fails create visibly.
 */
export function soakLifetime(
  provider: string,
  shiftMs: number = SOAK_SHIFT_MS,
  declared?: DeclaredLifetime,
): SoakLifetime {
  const sdkMax = posMs(declared?.maxMs);
  const maxLifetimeMs = sdkMax ?? SOAK_MAX_LIFETIME_MS[provider] ?? null;
  const wanted = shiftMs + SOAK_LIFETIME_HEADROOM_MS;
  return {
    lifetimeMs: maxLifetimeMs === null ? wanted : Math.min(maxLifetimeMs, wanted),
    maxLifetimeMs,
    maxShorterThanShift: maxLifetimeMs !== null && maxLifetimeMs < shiftMs,
    source: sdkMax !== undefined ? 'sdk' : maxLifetimeMs !== null ? 'table' : 'requested',
    defaultLifetimeMs: posMs(declared?.defaultMs) ?? null,
    extendable: typeof declared?.extendable === 'boolean' ? declared.extendable : null,
  };
}

export const CHAIN_FILE = 'soak-chain.log';
export const WRITER_SCRIPT = 'soak-writer.sh';
export const WRITER_ERR_LOG = 'soak-writer.err';
/** Seed for chain line 0: `0 <sha256(CHAIN_SEED)>`. */
export const CHAIN_SEED = 'computesdk-soak-v1';

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
export const SEED_HASH = sha256hex(CHAIN_SEED);

// --- In-sandbox writer ------------------------------------------------------

/** True when pid $1 is alive and (where /proc exists) is a soak writer, not a reused pid. */
const IS_WRITER_FN = `is_writer() {
  kill -0 "$1" 2>/dev/null || return 1
  [ -r "/proc/$1/cmdline" ] || return 0
  tr '\\0' ' ' < "/proc/$1/cmdline" | grep -q 'soak-writer'
}`;

/**
 * Shell loop appended once a second. The previous hash is ALWAYS read back
 * from the chain file (never kept in a shell variable), so corruption written
 * mid-file propagates into every later head and the checker's incremental
 * verification catches it. Each line also carries `date +%s` so a paused and
 * resumed VM shows a timestamp gap instead of looking continuous. Writes are
 * line-appends; the file is never truncated by the writer.
 */
export const WRITER_SCRIPT_BODY = `#!/bin/sh
# soak-writer.sh <chain-file>
CHAIN="$1"
SEED='${CHAIN_SEED}'

# Single writer per chain: two concurrent appenders interleave links and
# corrupt the chain. A stale lock (dead or reused pid) is taken over.
${IS_WRITER_FN}
LOCK="$CHAIN.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$old" ] && is_writer "$old"; then exit 0; fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"

h() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.stdin.read().encode()).hexdigest())'
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(require("crypto").createHash("sha256").update(s).digest("hex")))'
  else
    echo 'soak-writer: no sha256 tool on PATH' >&2
    exit 3
  fi
}

while :; do
  if [ ! -s "$CHAIN" ]; then
    printf '0 %s %s\\n' "$(date +%s)" "$(h "$SEED")" >> "$CHAIN"
  else
    prev=$(tail -n 1 "$CHAIN" 2>/dev/null || true)
    pn=\${prev%% *}
    ph=\${prev##* }
    case "$pn" in
      ''|*[!0-9]*) n=-1 ;;
      *) n=$((pn + 1)) ;;
    esac
    printf '%s %s %s\\n' "$n" "$(date +%s)" "$(h "$ph")" >> "$CHAIN"
  fi
  sleep 1
done
`;

// --- Per-provider state -----------------------------------------------------

/**
 * Persisted at results/sandbox_soak/state/<provider>.json — committed to the
 * repo by the collect job (results/ is gitignored; `git add -f`), read back
 * by the next shift. Counters accumulate for the life of an epoch; epoch
 * rollover and a fresh sandbox reset them.
 */
export interface SoakState {
  /** Provider-assigned id the next shift reattaches to via getById. */
  sandboxId: string | null;
  /** Resolved workdir holding the chain + writer script. */
  workdir: string | null;
  epochIndex: number;
  /** ISO timestamp the current epoch began. */
  epochStartedAt: string;
  /** Chain lines consumed + verified so far (file line offset of the next tick). */
  verifiedLines: number;
  /** Stored hash of the last verified line; seeds the next link check. */
  headHash: string;
  /** Unix seconds of the last verified line's ts field (monotonic baseline). */
  headTs: number;
  ticksAttempted: number;
  ticksPassed: number;
  ticksFailed: number;
  /** Ticks where exec succeeded but the new tail had a bad link. */
  corruptTicks: number;
  /** Verified lines whose ts jumped > PAUSE_GAP_S over the previous — pause/resume evidence. */
  pauseGaps: number;
  /** Boxes created mid-epoch (getById miss, dead box, post-rollover create). */
  restarts: number;
  /** Times the chain writer was found dead on a live box and relaunched. */
  writerRestarts: number;
  /**
   * Times getById returned a different sandboxId than persisted — the
   * provider replaced the box (e.g. recreated from a snapshot), breaking the
   * same-sandbox contract. Each also counts in `restarts`.
   */
  sameSandboxViolations: number;
  /** Why the most recent respawn happened (getById miss, dead box, id change, epoch). */
  respawnReason?: string;
  /** Sandbox ids replaced but not confirmed destroyed — reaped by id on the next shift that can reach the provider. */
  orphanedSandboxIds?: string[];
  lastCheckAt: string | null;
  lastSeenAliveAt: string | null;
}

export function freshState(epochIndex = 0): SoakState {
  return {
    sandboxId: null,
    workdir: null,
    epochIndex,
    epochStartedAt: new Date().toISOString(),
    verifiedLines: 0,
    headHash: '',
    headTs: 0,
    ticksAttempted: 0,
    ticksPassed: 0,
    ticksFailed: 0,
    corruptTicks: 0,
    pauseGaps: 0,
    restarts: 0,
    writerRestarts: 0,
    sameSandboxViolations: 0,
    orphanedSandboxIds: [],
    lastCheckAt: null,
    lastSeenAliveAt: null,
  };
}

/** Missing/corrupt/partial state all degrade to a fresh epoch. */
export function readState(file: string): SoakState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return freshState();
    return { ...freshState(), ...parsed } as SoakState;
  } catch {
    return freshState();
  }
}

export function stateFilePath(resultsDir: string, provider: string): string {
  return path.join(resultsDir, 'state', `${provider}.json`);
}

export function writeState(file: string, state: SoakState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// --- Chain verification ------------------------------------------------------

export interface TickVerify {
  /** Lines returned by the tick's tail (0 = no growth). */
  newLines: number;
  /** Lines whose N was non-sequential, whose hash broke the chain, or whose ts went backward/wasn't a number. */
  badLines: number;
  /** Stored hash of the last returned line (advances headHash). */
  lastHash: string;
  /** Max ts seen in the tail (advances headTs; monotonic baseline). */
  lastTs: number;
  /** Writer-coverage seconds earned by verified lines in this tail. */
  coveredSeconds: number;
  /** Verified lines whose ts jumped > PAUSE_GAP_S over the previous. */
  pauseGaps: number;
  /** Guest `date +%s` read by the tick (0 when the tail did not report one). */
  guestNowS: number;
}

export const NO_CHAIN_MARKER = '__SOAK_NO_CHAIN__';
export const GUEST_NOW_MARKER = '__SOAK_GUEST_NOW__';

/**
 * Incrementally verify a tick's new tail. Lines are `N <unix_seconds> <sha256>`:
 * for each new line the checker expects N = its chain position, ts numeric and
 * monotonically non-decreasing (a backward ts is clock tampering or a replayed
 * segment), and hash = sha256(stored hash of the previous line) — the same
 * bytes the writer would have chained on, so a corrupted mid-chain line is
 * flagged at that line and every later link is judged against what was
 * actually stored.
 *
 * Each verified line also earns coverage credit: `min(ts - prevTs,
 * LINE_RATE_SECONDS)` — at most one writer-rate second per line, so a box
 * paused for 3h shows a 3600s ts jump that earns only ~1s. `prevTs` persists
 * across ticks via state.headTs.
 */
export function verifyTail(stdout: string, verifiedLines: number, headHash: string, prevTs: number): TickVerify {
  const lines = stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && l !== NO_CHAIN_MARKER);
  let guestNowS = 0;
  const chainLines = lines.filter((l) => {
    if (!l.startsWith(GUEST_NOW_MARKER)) return true;
    const n = Number(l.slice(GUEST_NOW_MARKER.length).trim());
    if (Number.isFinite(n)) guestNowS = n;
    return false;
  });
  let prevHash = headHash;
  let lastTs = prevTs;
  let badLines = 0;
  let coveredSeconds = 0;
  let pauseGaps = 0;
  chainLines.forEach((line, i) => {
    const expectedN = verifiedLines + i;
    // `N <ts> <hash>` — fields split at the first and second spaces.
    const sp1 = line.indexOf(' ');
    const sp2 = sp1 === -1 ? -1 : line.indexOf(' ', sp1 + 1);
    const nStr = sp1 === -1 ? line : line.slice(0, sp1);
    const tsStr = sp2 === -1 ? '' : line.slice(sp1 + 1, sp2);
    const hStr = sp2 === -1 ? '' : line.slice(sp2 + 1);
    const ts = Number(tsStr);
    const expectedHash = expectedN === 0 ? SEED_HASH : sha256hex(prevHash);
    const bad =
      nStr !== String(expectedN) || hStr !== expectedHash || !Number.isFinite(ts) || ts < lastTs;
    if (!bad) {
      coveredSeconds += Math.min(Math.max(0, ts - lastTs), LINE_RATE_SECONDS);
      if (lastTs > 0 && ts - lastTs > PAUSE_GAP_S) pauseGaps++;
    }
    if (Number.isFinite(ts)) lastTs = Math.max(lastTs, ts);
    // Mirror the writer: chain verification off the stored hash field
    // whatever it holds, so corruption shows up on the corrupted line itself.
    prevHash = hStr;
    if (bad) badLines++;
  });
  return { newLines: chainLines.length, badLines, lastHash: prevHash, lastTs, coveredSeconds, pauseGaps, guestNowS };
}

// --- Shell fragments used by the task ---------------------------------------

/**
 * The writer's lock pid answers first (kill -0 works without procps); the
 * process-list probes only cover writers started before the lock existed.
 * Matches 'soak-writer.sh' without matching the probe's own cmdline.
 */
export function writerAliveCmd(workdir: string): string {
  return `${IS_WRITER_FN}
p=$(cat ${workdir}/${CHAIN_FILE}.lock/pid 2>/dev/null)
if [ -n "$p" ] && is_writer "$p"; then echo writer=alive
elif pgrep -f 'soak-writer\\.sh' >/dev/null 2>&1; then echo writer=alive
elif ps -eo pid,args 2>/dev/null | grep '[s]oak-writer\\.sh' >/dev/null 2>&1; then echo writer=alive
elif ps 2>/dev/null | grep '[s]oak-writer\\.sh' >/dev/null 2>&1; then echo writer=alive
else echo writer=dead; fi`;
}

/**
 * setsid + closed stdin detach the writer from the exec session, so
 * providers that kill the command's session/process group when the exec
 * returns (archil, cloud-run, miosa, sprites: chain never seeded) keep it.
 */
export function launchWriterCmd(workdir: string): string {
  const run = `nohup sh ${workdir}/${WRITER_SCRIPT} ${workdir}/${CHAIN_FILE} < /dev/null >> ${workdir}/${WRITER_ERR_LOG} 2>&1 &`;
  return `if command -v setsid >/dev/null 2>&1; then setsid ${run} else ${run} fi`;
}

export function tailCmd(workdir: string, fromLine: number): string {
  const chain = `${workdir}/${CHAIN_FILE}`;
  return `echo "${GUEST_NOW_MARKER} $(date +%s)"; if [ -f ${chain} ]; then tail -n +${fromLine} ${chain} | head -n ${TICK_MAX_LINES}; else echo '${NO_CHAIN_MARKER}'; fi`;
}

// --- Legacy results spec (results/sandbox_soak/latest.json bridge) ----------

/**
 * Suite spec for the legacy results writer. All stage weights are 0 — the
 * suite scoreMetric is lower-is-better and can't express the soak's
 * higher-is-better percentages, so the soak writer patches compositeScore
 * itself (0.7 * uptimePct + 0.3 * integrityPct).
 */
export const SOAK_STAGE_KEYS = [
  'uptimePct',
  'integrityPct',
  'ticksAttempted',
  'ticksPassed',
  'ticksFailed',
  'corruptTicks',
  'coveragePct',
  'pauseGaps',
  'chainLength',
  'restarts',
  'writerRestarts',
  'sameSandboxViolations',
  'soakAgeHours',
  'epochIndex',
] as const;

export const SOAK_SUITE: SuiteSpec = {
  id: SUITE_CONFIG.id,
  stageMetrics: SOAK_STAGE_KEYS.map((key) => ({ key, ceiling: 100, weight: 0 })),
  pass: (meta) => meta.measured === true,
  flags: (iterations) => ({
    getByIdUnsupported: iterations.some((i) => i.meta?.getByIdSupported === false),
  }),
  configBlock: {
    mode: SUITE_CONFIG.id,
    unit: 'pct',
    higherIsBetter: true,
    shiftMs: SOAK_SHIFT_MS,
    epochMs: SOAK_EPOCH_MS,
    checkIntervalMs: SOAK_CHECK_INTERVAL_MS,
  },
};
