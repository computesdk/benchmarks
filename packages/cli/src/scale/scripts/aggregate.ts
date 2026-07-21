#!/usr/bin/env node
/**
 * Aggregate a scale run into the meta.json shape the single-VM coordinator
 * writes, sourced entirely from the orchestrator analytics endpoints
 * (@computesdk/bench). No external storage: the report prints to stdout and,
 * with --out, is written to a local JSON file.
 *
 * Provenance (all via the bench client):
 *   - status / latency / first-command         → getRunResults (overall + steps)
 *   - failure-by-error-code                     → getRunTaskResults().failures
 *                                                 (a capped sample, not a full
 *                                                 histogram — see failureLimit)
 *   - throughput + concurrency over time        → getRunTimeline (eventRate +
 *                                                 per-worker concurrency points)
 *   - run/worker/task counts + terminal status  → getRunProgress
 *
 * What the platform rollups do NOT expose, and is therefore null here (it lives
 * only in each shard's per-shard artifacts — raw.jsonl/meta.json/metrics.jsonl —
 * which the SDK cannot currently download):
 *   - the four-state taxonomy (partial / readiness_failed) — collapsed to
 *     success / error / other.
 *   - percentiles beyond min/p50/p95/p99/max (no p10/p25/p75/p90/p999).
 *   - create_failure_class (timeout/http/network).
 *   - tti distribution (no per-task create+exec sum in the rollup).
 *   - submission-segment fairness (no group-by; task-index buckets are a
 *     different axis and are emitted as task_index_buckets instead).
 *   - fleet system-health (mem/event-loop/fds/sockets) — no metric ingestion.
 *
 * Usage:
 *   tsx src/scale/scripts/aggregate.ts --run <RUN_ID>
 *   tsx src/scale/scripts/aggregate.ts --recent
 *   tsx src/scale/scripts/aggregate.ts --run <RUN_ID> --out meta.json
 *   npm run bench:scale:aggregate -- --run <RUN_ID>
 *
 * Exit code:
 *   0 — run found and aggregated
 *   1 — run is non-terminal (still running) and --allow-running was not passed
 *   2 — bad arguments / missing env / no matching run
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import { createBenchmarkClient, BenchmarkApiError } from '@computesdk/bench';
import type {
  BenchmarkResultLatencySummary,
  BenchmarkRunResults,
  BenchmarkRunTaskResults,
  BenchmarkRunTimeline,
  RunProgress,
} from '@computesdk/bench';

const BENCHMARK_SLUG = process.env.BENCHMARK_SLUG ?? 'scale';

interface Args {
  runId?: string;
  recent: boolean;
  slug: string;
  out?: string;
  requireTerminal: boolean;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/aggregate.ts [options]',
    '',
    'One of:',
    '  --run <id>             Aggregate the named platform run',
    '  --recent               Aggregate the most-recently-created run',
    '',
    'Optional:',
    '  --slug <name>          Benchmark slug (default: scale, or BENCHMARK_SLUG)',
    '  --out <file>           Write the aggregate meta.json to <file>',
    '  --allow-running        Aggregate even if the run is still in progress',
    '                         (default: refuse and exit 1)',
    '  --help, -h             Print this help',
    '',
    'Required env:',
    '  COMPUTESDK_API_KEY    Bench API token',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { recent: false, slug: BENCHMARK_SLUG, requireTerminal: true };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--run') out.runId = next();
    else if (a === '--recent') out.recent = true;
    else if (a === '--slug') out.slug = next();
    else if (a === '--out') out.out = next();
    else if (a === '--allow-running') out.requireTerminal = false;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!out.runId && !out.recent) { console.error(`pass --run <id> or --recent\n${usage()}`); process.exit(2); }
  return out;
}

const args = parseArgs();

const client = createBenchmarkClient({
  baseUrl: 'https://platform.computesdk.com/api/v1',
  apiKey: process.env.COMPUTESDK_ADMIN_API_KEY ?? process.env.COMPUTESDK_API_KEY,
});

// Some analytics endpoints lag the run (events still importing) — degrade to a
// fallback rather than failing the whole aggregate on one missing signal.
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

// ─── resolve run ────────────────────────────────────────────────────────────
let runId = args.runId;
if (!runId) {
  const runs = await safe(() => client.listRuns(args.slug), []);
  if (runs.length === 0) { console.error(`no runs found for benchmark "${args.slug}"`); process.exit(2); }
  const sorted = [...runs].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  runId = sorted[sorted.length - 1].id;
  console.log(`[aggregate] --recent → run=${runId}`);
}

const [progress, results, taskResults, timeline] = await Promise.all([
  client.getRunProgress(args.slug, runId).catch((err: unknown) => {
    const msg = err instanceof BenchmarkApiError ? `${err.status} ${err.message}` : String(err);
    console.error(`getRunProgress failed: ${msg}`);
    process.exit(2);
  }) as Promise<RunProgress>,
  safe<BenchmarkRunResults | null>(() => client.getRunResults(args.slug, runId!), null),
  safe<BenchmarkRunTaskResults | null>(() => client.getRunTaskResults(args.slug, runId!, { failureLimit: 5000 }), null),
  safe<BenchmarkRunTimeline | null>(() => client.getRunTimeline(args.slug, runId!, { bucketMs: 1000 }), null),
]);

// Terminal gate. The platform owns run status, so this is authoritative.
if (!progress.summary.completed && progress.summary.status !== 'failed' && args.requireTerminal) {
  console.error(
    `run ${runId} is ${progress.summary.status} (not terminal); pass --allow-running to aggregate anyway`,
  );
  const running = progress.participants.flatMap(p => [
    `  ${p.slug}: ${p.tasks.done}/${p.tasks.total} done, ${p.workers.running} running, ${p.workers.stale} stale`,
  ]);
  if (running.length) { console.error('participants:'); running.forEach(l => console.error(l)); }
  process.exit(1);
}

// ─── derive totals ──────────────────────────────────────────────────────────
const sandboxesAttempted = progress.run.totalTasks;
const overall = results?.overall ?? null;
const succeeded = overall?.successCount ?? null;
const failed = overall?.errorCount ?? null;
const other = overall?.otherCount ?? null;

const stepLatency = (name: string): BenchmarkResultLatencySummary | null =>
  results?.steps.find(s => s.stepName === name)?.latencyMs ?? null;
const createLatency = stepLatency('create') ?? overall?.latencyMs ?? null;
const firstCommandLatency = stepLatency('exec.initial');

// Latency summaries only carry min/avg/p50/p95/p99/max; the richer percentiles
// (p10/p25/p75/p90/p999) the single-run meta.json reports have no platform
// source and stay null.
const distFrom = (d: BenchmarkResultLatencySummary | null) => d == null ? null : {
  count: null as number | null,
  min_ms: d.min,
  p10_ms: null,
  p25_ms: null,
  p50_ms: d.p50,
  p75_ms: null,
  p90_ms: null,
  p95_ms: d.p95,
  p99_ms: d.p99,
  p999_ms: null,
  max_ms: d.max,
  mean_ms: d.avg,
};

// Failure-by-code, aggregated from the (capped) failures sample.
const failureByCode = new Map<string, number>();
for (const f of taskResults?.failures ?? []) {
  const key = f.errorCode ?? 'unknown';
  failureByCode.set(key, (failureByCode.get(key) ?? 0) + 1);
}
const failureBreakdownByCode = [...failureByCode.entries()]
  .map(([key, count]) => ({ key, count }))
  .sort((a, b) => b.count - a.count);
const failuresSampleCapped = (taskResults?.failures.length ?? 0) >= 5000;

// Task-index buckets (replaces submission-segment fairness; different axis).
const taskIndexBuckets = (taskResults?.buckets ?? []).map(b => ({
  participant: b.participantSlug,
  task_index_start: b.bucketStart,
  task_index_end: b.bucketEnd,
  count: b.taskCount,
  success: b.successCount,
  error: b.errorCount,
  p50_ms: b.latencyMs.p50,
  p95_ms: b.latencyMs.p95,
  max_ms: b.latencyMs.max,
}));

const summarizeTimeline = (points: Array<{ t_ms: number; active: number }>): Record<string, number> | null => {
  if (points.length === 0) return null;
  let peak = -Infinity, peakT = 0;
  for (const p of points) if (p.active > peak) { peak = p.active; peakT = p.t_ms; }
  return {
    peak_concurrent: peak,
    peak_t_ms: peakT,
    mean_concurrent: Math.round(points.reduce((s, p) => s + p.active, 0) / points.length),
    total_run_ms: points[points.length - 1].t_ms,
    sample_interval_ms: timeline?.concurrency ? (timeline.eventRate.bucketMs ?? 1000) : 1000,
  };
};

const timelineForStep = (stepName: string): Array<{ t_ms: number; active: number }> => {
  const byT = new Map<number, number>();
  for (const pt of timeline?.concurrency.points ?? []) {
    if (pt.step !== stepName) continue;
    byT.set(pt.tMs, (byT.get(pt.tMs) ?? 0) + pt.active);
  }
  return [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t_ms, active]) => ({ t_ms, active }));
};

// Worker readiness used to be a pre-create barrier; keep historical points
// separate so they are not mistaken for provider create/runtime concurrency.
const workerReadyTimeline = timelineForStep('worker.ready');
const workerReadySummary = summarizeTimeline(workerReadyTimeline);

// Concurrency over time for non-barrier, non-live telemetry steps. Today create
// and exec steps do not report concurrency, so this is often null by design.
const concByT = new Map<number, number>();
for (const pt of timeline?.concurrency.points ?? []) {
  if (pt.step === 'worker.ready' || pt.step === 'sandbox.live') continue;
  concByT.set(pt.tMs, (concByT.get(pt.tMs) ?? 0) + pt.active);
}
const concurrencyTimeline = [...concByT.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([t_ms, active]) => ({ t_ms, active }));
const concurrencySummary = summarizeTimeline(concurrencyTimeline);

// True live ready sandboxes over time, emitted from create start through teardown.
const liveSandboxesTimeline = timelineForStep('sandbox.live');
const liveSandboxesSummary = summarizeTimeline(liveSandboxesTimeline);

// Throughput over time: completed sandboxes per time bucket (summed across
// participants).
const tputByT = new Map<number, number>();
for (const b of timeline?.eventRate.buckets ?? []) {
  tputByT.set(b.tMs, (tputByT.get(b.tMs) ?? 0) + b.completed);
}
const throughputTimeline = [...tputByT.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([t_ms, finalized]) => ({ t_ms, finalized }));

const participantSummaries = progress.participants.map(p => ({
  slug: p.slug,
  provider: p.provider ?? null,
  status: p.status,
  total_tasks: p.totalTasks,
  workers: p.workers,
  tasks: p.tasks,
}));
const provider = progress.participants.map(p => p.provider ?? p.slug).join(',') || 'unknown';

const aggregate = {
  run_id: runId,
  benchmark_slug: args.slug,
  provider,
  status: progress.summary.status,
  sandboxes_attempted: sandboxesAttempted,
  sandboxes_succeeded: succeeded,
  // The 4-state taxonomy collapses: partial/readiness_failed are not separable
  // from the platform rollup (they fold into error/other). The per-shard raw
  // artifacts retain them.
  partials: null,
  readiness_failures: null,
  failures: failed,
  other,
  // create_failure_class has no rollup source.
  timeouts: null,
  http_errors: null,
  network_errors: null,
  create_failure_class: null,
  p50_latency_ms: createLatency?.p50 ?? null,
  p99_latency_ms: createLatency?.p99 ?? null,
  latency_distribution: distFrom(createLatency),
  first_command_distribution: distFrom(firstCommandLatency),
  tti_distribution: null,
  status_histogram: {
    success: succeeded,
    error: failed,
    other,
  },
  failure_breakdown_by_code: failureBreakdownByCode,
  failure_breakdown_capped: failuresSampleCapped,
  task_index_buckets: taskIndexBuckets,
  submission_segments: null,
  worker_ready_summary: workerReadySummary,
  worker_ready_timeline: workerReadyTimeline.length ? workerReadyTimeline : null,
  concurrency_summary: concurrencySummary,
  concurrency_timeline: concurrencyTimeline.length ? concurrencyTimeline : null,
  live_sandboxes_summary: liveSandboxesSummary,
  live_sandboxes_timeline: liveSandboxesTimeline.length ? liveSandboxesTimeline : null,
  throughput_timeline: throughputTimeline.length ? throughputTimeline : null,
  metrics_summary: null,
  participants: participantSummaries,
  workers_total: progress.participants.reduce((s, p) => s + p.workers.total, 0),
  generated_at: progress.generatedAt,
  aggregated_at: new Date().toISOString(),
};

// ─── pretty-print ────────────────────────────────────────────────────────
const rule = '═'.repeat(67);
const num = (n: number | null | undefined): string => (n == null ? '-' : Math.round(n).toLocaleString());
const pct = (n: number | null, d: number): string => (n != null && d > 0 ? `${((n / d) * 100).toFixed(2)}%` : '-');

type Dist = ReturnType<typeof distFrom>;
const distBlock = (title: string, d: Dist): void => {
  if (!d) return;
  console.log(`  ${title}`);
  console.log(`    min=${num(d.min_ms)}  p50=${num(d.p50_ms)}  p95=${num(d.p95_ms)}  ` +
    `p99=${num(d.p99_ms)}  max=${num(d.max_ms)}  mean=${num(d.mean_ms)}  ` +
    `(p10/p25/p75/p90/p999 unavailable in rollup)`);
};

console.log('');
console.log(rule);
console.log(` aggregate :: ${runId}`);
console.log(rule);
console.log(`  provider:         ${provider}`);
console.log(`  status:           ${progress.summary.status}`);
const workersLine = progress.participants
  .map(p => `${p.slug}[${p.workers.completed}✓/${p.workers.failed}✗/${p.workers.stale}∅ of ${p.workers.total}]`)
  .join('  ');
console.log(`  workers:          ${workersLine}`);
console.log(`  attempted:        ${sandboxesAttempted.toLocaleString()}`);
console.log(`  succeeded:        ${num(succeeded)} (${pct(succeeded, sandboxesAttempted)})`);
console.log('');
console.log(`  status:           success=${num(succeeded)}  error=${num(failed)}  other=${num(other)}`);
console.log(`                    (partial/readiness_failed not separable from rollup; see raw artifact)`);

console.log('');
distBlock('allocate latency (ms):', aggregate.latency_distribution);
distBlock('readiness / first-command (ms):', aggregate.first_command_distribution);

if (failureBreakdownByCode.length > 0) {
  console.log('');
  console.log(`  failure by code${failuresSampleCapped ? ' (capped sample)' : ''}:`);
  for (const c of failureBreakdownByCode) console.log(`    ${c.key.padEnd(24)} ${c.count.toLocaleString()}`);
}

if (concurrencySummary) {
  console.log('');
  console.log(`  concurrency:      peak=${concurrencySummary.peak_concurrent}  mean=${concurrencySummary.mean_concurrent}  ` +
    `(over ${(concurrencySummary.total_run_ms / 1000).toFixed(0)}s, summed across workers)`);
}
if (workerReadySummary) {
  console.log('');
  console.log(`  worker ready:     peak=${workerReadySummary.peak_concurrent}  mean=${workerReadySummary.mean_concurrent}  ` +
    `(over ${(workerReadySummary.total_run_ms / 1000).toFixed(0)}s, pre-create readiness)`);
}
if (liveSandboxesSummary) {
  console.log(`  live sandboxes:   peak=${liveSandboxesSummary.peak_concurrent}  mean=${liveSandboxesSummary.mean_concurrent}  ` +
    `(over ${(liveSandboxesSummary.total_run_ms / 1000).toFixed(0)}s, create through teardown)`);
}

console.log('');
console.log(`  source: status/latency from getRunResults; failure-by-code + task buckets`);
console.log(`          from getRunTaskResults; concurrency/throughput from getRunTimeline.`);
console.log(`          Fine percentiles, the 4-state taxonomy, create-failure class and`);
console.log(`          fleet system-health live only in each shard's per-shard artifacts.`);

// ─── output ────────────────────────────────────────────────────────────────
// 100% bench: the report is the stdout above; --out persists the full JSON
// locally. No external storage.
if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify(aggregate, null, 2));
  console.log('');
  console.log(`[aggregate] wrote ${args.out}`);
}

process.exit(0);
