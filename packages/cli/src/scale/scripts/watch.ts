#!/usr/bin/env node
/**
 * Watch one or more scale runs until they reach a terminal state.
 *
 * Under the orchestrator API the platform owns the run lifecycle, so terminal
 * detection is authoritative (`getRunProgress().summary.{status,completed}`) —
 * no more heartbeat-loss / staleness inference. One platform run spans every VM
 * (each VM is a worker under the provider participant), so a "run" here is the
 * whole logical burst, not a single shard.
 *
 * Counts come from two endpoints:
 *   - getRunProgress  → done / in-flight / total + worker counts (incl. stale),
 *                       live and cheap, polled every interval.
 *   - getRunResults   → success / error / other split + latency p50/p99,
 *                       best-effort (empty until the analytics pipeline catches
 *                       up). The four-state taxonomy (partial/readiness_failed)
 *                       collapses to success/error/other here; the full split
 *                       lives only in the per-shard raw artifacts.
 *
 * Exits when every watched run is terminal. Exit code: 0 if all completed
 * cleanly, 1 if any failed.
 *
 * Usage:
 *   tsx src/scale/scripts/watch.ts <RUN_ID> [<RUN_ID> ...]
 *   tsx src/scale/scripts/watch.ts --recent 5
 *   tsx src/scale/scripts/watch.ts --recent 5 --interval 10
 *   npm run bench:scale:watch -- --recent 5
 */

import 'dotenv/config';
import { createBenchmarkClient, BenchmarkApiError } from '@computesdk/bench';
import type { RunProgress, BenchmarkRunResults } from '@computesdk/bench';

const BENCHMARK_SLUG = process.env.BENCHMARK_SLUG ?? 'scale';

interface Args {
  runIds: string[];
  recent: number | null;
  slug: string;
  intervalMs: number;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/watch.ts [options] [<RUN_ID> ...]',
    '',
    'Options:',
    '  --recent <n>, -n <n>   Watch the latest <n> runs for the benchmark',
    '  --slug <name>          Benchmark slug (default: scale, or BENCHMARK_SLUG)',
    '  --interval <sec>, -i   Poll interval in seconds (default: 15)',
    '  --help, -h             Print this help',
    '',
    'Exit code:',
    '  0 — all watched runs completed cleanly',
    '  1 — at least one run failed',
    '  2 — bad arguments / missing env',
    '',
    'Pass platform RUN_IDs (printed by start.ts) or --recent N.',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { runIds: [], recent: null, slug: BENCHMARK_SLUG, intervalMs: 15_000 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--recent' || a === '-n') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--recent must be a positive integer'); process.exit(2); }
      out.recent = v;
    } else if (a === '--slug') {
      out.slug = next();
    } else if (a === '--interval' || a === '-i') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--interval must be a positive integer'); process.exit(2); }
      out.intervalMs = v * 1000;
    } else if (a === '--help' || a === '-h') {
      console.log(usage()); process.exit(0);
    } else if (a.startsWith('--') || a.startsWith('-')) {
      console.error(`unknown flag: ${a}\n${usage()}`); process.exit(2);
    } else {
      out.runIds.push(a);
    }
  }
  if (out.runIds.length === 0 && out.recent === null) {
    console.error(`error: provide RUN_IDs or --recent N\n\n${usage()}`); process.exit(2);
  }
  return out;
}

const args = parseArgs();

const client = createBenchmarkClient({
  baseUrl: 'https://platform.computesdk.com/api/v1',
  apiKey: process.env.COMPUTESDK_ADMIN_API_KEY ?? process.env.COMPUTESDK_API_KEY,
});

function classifyError(err: unknown): { status: string; detail: string } {
  if (err instanceof BenchmarkApiError) {
    if (err.status === 404) return { status: 'not-found', detail: err.message };
    if (err.status === 401 || err.status === 403) return { status: 'unauthorized', detail: err.message };
  }
  return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
}

async function resolveRunIds(): Promise<string[]> {
  const ids = [...args.runIds];
  if (args.recent !== null) {
    try {
      const runs = await client.listRuns(args.slug);
      // listRuns has no limit param; take the most recent N by createdAt if
      // present, else by list order (assumed newest-last → take the tail).
      const sorted = [...runs].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
      const recent = sorted.slice(-args.recent).map(r => r.id).reverse();
      for (const id of recent) if (!ids.includes(id)) ids.push(id);
    } catch (err) {
      if (ids.length === 0) { console.error(`listRuns failed: ${classifyError(err).detail}`); process.exit(1); }
    }
  }
  if (ids.length === 0) { console.error('no runs to watch'); process.exit(1); }
  return ids;
}

const runIds = await resolveRunIds();

// ─── per-poll state ─────────────────────────────────────────────────────────

interface WatchRow {
  id: string;
  status: string;
  done: number;
  total: number;
  success: number;
  errors: number;
  other: number;
  inFlight: number;
  stale: number;
  p50: number | null;
  p99: number | null;
  ratePerSec: number | null;
  detail?: string;
}

const lastSeen = new Map<string, { done: number; atMs: number }>();

function sumProgress(p: RunProgress): { done: number; inFlight: number; errors: number; stale: number } {
  let done = 0, inFlight = 0, errors = 0, stale = 0;
  for (const part of p.participants) {
    done += part.tasks.done;
    inFlight += part.tasks.inFlight;
    errors += part.tasks.errors;
    stale += part.workers.stale;
  }
  return { done, inFlight, errors, stale };
}

async function fetchRow(id: string, nowMs: number): Promise<WatchRow> {
  let progress: RunProgress;
  try {
    progress = await client.getRunProgress(args.slug, id);
  } catch (err) {
    const { status, detail } = classifyError(err);
    return {
      id, status, done: 0, total: 0, success: 0, errors: 0, other: 0,
      inFlight: 0, stale: 0, p50: null, p99: null, ratePerSec: null, detail,
    };
  }

  // Results are best-effort: empty/unavailable early in a run.
  let results: BenchmarkRunResults | null = null;
  try { results = await client.getRunResults(args.slug, id); } catch { /* not ready */ }

  const { done, inFlight, errors, stale } = sumProgress(progress);
  const total = progress.run.totalTasks;
  const status = progress.summary.status;

  const prev = lastSeen.get(id);
  let ratePerSec: number | null = null;
  if (prev) {
    const dt = (nowMs - prev.atMs) / 1000;
    if (dt > 0) ratePerSec = Math.max(0, (done - prev.done) / dt);
  }
  lastSeen.set(id, { done, atMs: nowMs });

  const overall = results?.overall;
  const detailBits: string[] = [];
  if (stale > 0) detailBits.push(`${stale} worker(s) stale`);
  const failedParticipants = progress.participants.filter(p => p.status === 'failed').map(p => p.slug);
  if (failedParticipants.length > 0) detailBits.push(`failed participant(s): ${failedParticipants.join(', ')}`);

  return {
    id,
    status,
    done,
    total,
    success: overall?.successCount ?? 0,
    errors: overall?.errorCount ?? errors,
    other: overall?.otherCount ?? 0,
    inFlight,
    stale,
    p50: overall?.latencyMs.p50 ?? null,
    p99: overall?.latencyMs.p99 ?? null,
    ratePerSec,
    detail: detailBits.length > 0 ? detailBits.join(' | ') : undefined,
  };
}

async function fetchRows(): Promise<WatchRow[]> {
  const now = Date.now();
  return Promise.all(runIds.map(id => fetchRow(id, now)));
}

// ─── table ──────────────────────────────────────────────────────────────────

function pad(s: string | number | null, n: number, align: 'l' | 'r' = 'l'): string {
  const v = s == null ? '-' : String(s);
  return align === 'l' ? v.padEnd(n) : v.padStart(n);
}

const TERMINAL = new Set(['completed', 'failed', 'not-found', 'unauthorized', 'error']);
const ID_COL_WIDTH = Math.max(24, ...runIds.map(id => id.length));

function pctOf(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-';
}

function printTable(rows: WatchRow[], pollNum: number): void {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}]  poll ${pollNum}`);
  console.log(
    '  ' + pad('RUN', ID_COL_WIDTH) +
    '  ' + pad('status', 12) +
    '  ' + pad('done/total', 20, 'r') +
    '  ' + pad('ok', 7, 'r') +
    '  ' + pad('err', 6, 'r') +
    '  ' + pad('other', 6, 'r') +
    '  ' + pad('inFlt', 6, 'r') +
    '  ' + pad('p50/p99 ms', 14, 'r') +
    '  ' + pad('rate/s', 8, 'r'),
  );
  for (const r of rows) {
    const frac = `${r.done.toLocaleString()}/${r.total.toLocaleString()} ${pctOf(r.done, r.total)}`;
    const lat = r.p50 != null || r.p99 != null ? `${r.p50 ?? '-'}/${r.p99 ?? '-'}` : '-';
    console.log(
      '  ' + pad(r.id, ID_COL_WIDTH) +
      '  ' + pad(r.status, 12) +
      '  ' + pad(frac, 20, 'r') +
      '  ' + pad(r.success, 7, 'r') +
      '  ' + pad(r.errors, 6, 'r') +
      '  ' + pad(r.other, 6, 'r') +
      '  ' + pad(r.inFlight, 6, 'r') +
      '  ' + pad(lat, 14, 'r') +
      '  ' + pad(r.ratePerSec == null ? '-' : r.ratePerSec.toFixed(1), 8, 'r'),
    );
  }
  for (const r of rows.filter(r => r.detail)) {
    console.log(`    ! ${r.id}: ${r.detail}`);
  }
}

// ─── poll loop ──────────────────────────────────────────────────────────────

let pollNum = 0;
let finalRows: WatchRow[] = [];
while (true) {
  pollNum++;
  finalRows = await fetchRows();
  printTable(finalRows, pollNum);

  if (finalRows.every(r => TERMINAL.has(r.status))) break;
  await new Promise(res => setTimeout(res, args.intervalMs));
}

const anyFailed = finalRows.some(r => r.status === 'failed');
const anyDegraded = finalRows.some(r => r.status === 'not-found' || r.status === 'unauthorized' || r.status === 'error');
console.log(`\nall watched run(s) reached terminal state` +
  (anyFailed ? ' (some failed)' : anyDegraded ? ' (some degraded)' : ''));
process.exit(anyFailed ? 1 : 0);
