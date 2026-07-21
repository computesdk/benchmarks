#!/usr/bin/env node
/**
 * Launcher for the scale benchmark.
 *
 * Spreads a single logical burst of N sandboxes across K Namespace VMs by
 * creating K instances in parallel — each with CONCURRENCY_TARGET = N/K, tagged
 * with a shared GROUP_ID + per-VM SHARD_INDEX. A single-VM run is just `--vms 1`
 * (the default).
 *
 * Each VM runs the coordinator as its container command (PID 1) via a direct
 * CreateInstance call (the package's exported fetchNamespace), NOT via the
 * package's sandbox.create + runCommand (which forces `sleep infinity`). Running
 * the coordinator as PID 1 means: its stdout is captured natively by
 * `nsc logs <id> --kind containers`, and the instance auto-reaps when it exits —
 * just like the old `nsc run` path, with no log redirect and no self-destruct.
 *
 * Each VM gets its own RUN_ID; combine shards after the fact with:
 *
 *   tsx src/scale/scripts/aggregate.ts --group <GROUP_ID>
 *
 * Usage:
 *   tsx src/scale/scripts/start.ts --provider e2b --total 100000 --vms 20
 *   tsx src/scale/scripts/start.ts -p e2b -t 100000 -v 20 --duration 2h
 *   tsx src/scale/scripts/start.ts -p e2b -t 1000 -v 1   # single VM
 *   npm run bench:scale:start -- --provider e2b --total 100000 --vms 20
 *
 * Required env:
 *   NSC_TOKEN (or NSC_TOKEN_FILE)     Namespace API token used to create the VMs
 *   TIGRIS_STORAGE_ENDPOINT, _BUCKET  Tigris (S3-compat) target for raw results
 *   TIGRIS_STORAGE_ACCESS_KEY_ID
 *   TIGRIS_STORAGE_SECRET_ACCESS_KEY
 *   Provider-specific keys            e.g. E2B_API_KEY (validated by coordinator)
 *
 * Optional env:
 *   GITHUB_SHA                Defaults to `git rev-parse HEAD` or "local"
 *   COMPUTESDK_API_KEY        Bench ingest token (Bearer)
 *   SCALE_IMAGE_REPO          Default image repository when --image is unset
 *                             (default: nscr.io/5enq753trme1k/scale)
 *   SCALE_IMAGE_TAG           Default image tag when --image is unset
 *                             (default: latest)
 */

import 'dotenv/config';
import { execSync } from 'node:child_process';
import { fetchNamespace, getAndValidateCredentials } from '@computesdk/namespace';
import { createBenchmarkClient } from '@computesdk/bench';

// The platform benchmark these runs report under. One logical burst = one
// platform run; each VM claims one planned worker for the provider participant.
const BENCHMARK_SLUG = 'scale';
const BENCH_TIMEOUT_MS = 120_000;

// The container command — the coordinator bundle baked into the scale image
// (see src/scale/Dockerfile: CMD ["node", "/app/coordinator.cjs"]). We run it
// as the container's PID 1 (not via runCommand), so its stdout is captured
// natively by `nsc logs <id> --kind containers` and the instance auto-reaps
// when it exits — exactly like the old `nsc run` path.
const COORDINATOR_ARGS = ['node', '/app/coordinator.cjs'];

// Namespace Compute API endpoints. The package's own create/describe use these
// via its exported fetchNamespace; we call CreateInstance directly so we can set
// the container command (the package's sandbox.create hardcodes
// `args: ['sleep','infinity']`, which forces a runCommand child).
const CREATE_INSTANCE = '/namespace.cloud.compute.v1beta.ComputeService/CreateInstance';
const DESCRIBE_INSTANCE = '/namespace.cloud.compute.v1beta.ComputeService/DescribeInstance';

// Provider-specific credentials forwarded to the VM. The coordinator's
// `requiredEnvVars` check fails fast if its provider's vars are missing, so we
// just forward whatever is present in this process's env.
const PROVIDER_SECRET_VARS = [
  'E2B_API_KEY', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'DAYTONA_API_KEY',
  'CSB_API_KEY', 'RUNLOOP_API_KEY', 'TENSORLAKE_API_KEY', 'DECLAW_API_KEY',
  'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'NORTHFLANK_TOKEN', 'NORTHFLANK_PROJECT_ID',
  'ISORUN_API_KEY'
];

const MACHINE_TYPE_DEFAULT = '1x2';
const DEFAULT_SCALE_IMAGE_REPO = process.env.SCALE_IMAGE_REPO ?? 'nscr.io/5enq753trme1k/scale';
const DEFAULT_SCALE_IMAGE_TAG = process.env.SCALE_IMAGE_TAG ?? 'latest';
const DEFAULT_SCALE_IMAGE = `${DEFAULT_SCALE_IMAGE_REPO}:${DEFAULT_SCALE_IMAGE_TAG}`;

// ----- helpers --------------------------------------------------------------

type Logger = (line: string) => void;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Parse an nsc-style machine-type shape ("CPUxGB", e.g. "1x2") into the numeric
 * fields the `@computesdk/namespace` package wants. "1x2" → 1 vCPU, 2048 MB.
 */
function parseMachineType(shape: string): { virtualCpu: number; memoryMegabytes: number } {
  const m = /^(\d+)x(\d+)$/.exec(shape.trim());
  if (!m) {
    console.error(`--machine-type must be "<cpu>x<memGB>" (e.g. 1x2), got: ${shape}`);
    process.exit(2);
  }
  return { virtualCpu: parseInt(m[1], 10), memoryMegabytes: parseInt(m[2], 10) * 1024 };
}

/**
 * Parse a duration string into minutes. Accepts "1h", "30m", "1h30m", or a bare
 * integer (interpreted as minutes, e.g. "5" → 5). Returns null if unparseable.
 */
function durationMinutes(dur: string): number | null {
  const t = dur.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i.exec(t);
  if (!m || (!m[1] && !m[2])) return null;
  return (m[1] ? parseInt(m[1], 10) * 60 : 0) + (m[2] ? parseInt(m[2], 10) : 0);
}

/**
 * Duration string → milliseconds for the instance deadline. Assumes the value
 * was validated in parseArgs; falls back to 1h defensively.
 */
function durationToMs(dur: string): number {
  const mins = durationMinutes(dur);
  return (mins && mins > 0 ? mins : 60) * 60 * 1000;
}

function shortSha(): string {
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'local'; }
}
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ----- CLI ------------------------------------------------------------------

interface Args {
  provider: string;
  image?: string;
  total: number;
  vms: number;
  duration: string;
  machineType: string;
  groupId?: string;
  label?: string;
  retries: number;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/start.ts [options]',
    '',
    'Required:',
    '  --provider <name>, -p  Provider name (e2b, modal, runloop, ...)',
    '  --image <ref>,  -i     Container image for the Namespace sandbox VM',
    '  --total <n>,    -t     Total concurrent sandboxes across all VMs',
    '',
    'Optional:',
    '  --vms <n>,      -v     Number of Namespace VMs to spread across',
    '                         (must divide --total evenly; default: 1)',
    `  --duration <dur>       Namespace VM deadline / max lifetime (default: 1h,`,
    `                         e.g. 30m, 2h, 1h30m, or N for N minutes). VM also`,
    `                         auto-reaps on finish.`,
    `  --machine-type <type>  Namespace machine type (default: ${MACHINE_TYPE_DEFAULT})`,
    '  --group-id <id>        Override the generated GROUP_ID',
    '  --label <name>         Override the bench run label (default: scale.<provider>)',
    '  --retries <n>          Re-launch failed shards up to n extra times (default: 0)',
    '  --help, -h             Print this help',
    '',
    'Examples:',
    `                         (default: ${DEFAULT_SCALE_IMAGE})`,
    '  npm run bench:scale:start -- --provider e2b --total 100000 --vms 20',
    '  tsx src/scale/scripts/start.ts -p e2b -t 1000 -v 1 --duration 30m',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Partial<Args> = { vms: 1, duration: '1h', machineType: MACHINE_TYPE_DEFAULT, retries: 0 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--provider' || a === '-p') out.provider = next();
    else if (a === '--image' || a === '-i') out.image = next();
    else if (a === '--total' || a === '-t') out.total = parseInt(next(), 10);
    else if (a === '--vms' || a === '-v') out.vms = parseInt(next(), 10);
    else if (a === '--duration') out.duration = next();
    else if (a === '--machine-type') out.machineType = next();
    else if (a === '--group-id') out.groupId = next();
    else if (a === '--label') out.label = next();
    else if (a === '--retries') out.retries = parseInt(next(), 10);
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!out.provider) { console.error(`--provider is required\n${usage()}`); process.exit(2); }
  if (!Number.isFinite(out.total) || (out.total as number) <= 0) {
    console.error(`--total must be a positive integer\n${usage()}`); process.exit(2);
  }
  if (!Number.isFinite(out.vms) || (out.vms as number) <= 0) {
    console.error(`--vms must be a positive integer\n${usage()}`); process.exit(2);
  }
  if ((out.total as number) % (out.vms as number) !== 0) {
    console.error(`--total (${out.total}) must be evenly divisible by --vms (${out.vms})`);
    process.exit(2);
  }
  if (!Number.isFinite(out.retries) || (out.retries as number) < 0) {
    console.error(`--retries must be a non-negative integer\n${usage()}`); process.exit(2);
  }
  if (durationMinutes(out.duration as string) === null) {
    console.error(`--duration must be like 30m, 2h, 1h30m, or a number of minutes (got: ${out.duration})`);
    process.exit(2);
  }
  return out as Args;
}

// ----- per-VM launch --------------------------------------------------------

interface ShardOpts {
  provider: string;
  image: string;
  runId: string;
  concurrencyTarget: number;
  duration: string;
  machineType: string;
  githubSha: string;
  label?: string;
  // Sharded metadata; undefined for single-VM runs.
  groupId?: string;
  shardIndex?: number;
  shardCount?: number;
  // Platform orchestration target; undefined when bench reporting is disabled
  // (no COMPUTESDK_API_KEY, or run creation failed). The coordinator then runs
  // Tigris-only.
  benchmarkRunId?: string;
  participantSlug?: string;
}

interface ShardResult { shard: number; runId: string; rc: number; }

/**
 * Build the container environment forwarded to the coordinator, mirroring the
 * `--env` set the nsc CLI used to pass.
 */
function buildEnv(opts: ShardOpts): Record<string, string> {
  const env: Record<string, string> = {
    RUN_ID: opts.runId,
    PROVIDER: opts.provider,
    GITHUB_SHA: opts.githubSha,
    TIGRIS_STORAGE_ENDPOINT: process.env.TIGRIS_STORAGE_ENDPOINT!,
    TIGRIS_STORAGE_BUCKET: process.env.TIGRIS_STORAGE_BUCKET!,
    TIGRIS_STORAGE_ACCESS_KEY_ID: process.env.TIGRIS_STORAGE_ACCESS_KEY_ID!,
    TIGRIS_STORAGE_SECRET_ACCESS_KEY: process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY!,
    CONCURRENCY_TARGET: String(opts.concurrencyTarget),
    // Have the bench SDK tee the coordinator's output to a file in-container,
    // in addition to the logger's in-memory buffer uploaded as coordinator.log.
    COORDINATOR_LOG_PATH: '/tmp/coordinator.log',
  };
  if (process.env.COMPUTESDK_API_KEY) env.COMPUTESDK_API_KEY = process.env.COMPUTESDK_API_KEY;
  if (process.env.COMPUTESDK_ADMIN_API_KEY) env.COMPUTESDK_ADMIN_API_KEY = process.env.COMPUTESDK_ADMIN_API_KEY;
  if (opts.label !== undefined) env.LABEL = opts.label;
  if (opts.groupId !== undefined && opts.shardIndex !== undefined && opts.shardCount !== undefined) {
    env.GROUP_ID = opts.groupId;
    env.SHARD_INDEX = String(opts.shardIndex);
    env.SHARD_COUNT = String(opts.shardCount);
  }
  // Platform run/worker target. The coordinator claims one planned worker for
  // (BENCHMARK_SLUG, BENCHMARK_RUN_ID, PARTICIPANT_SLUG). RUN_ID above stays the
  // per-VM Tigris prefix and is independent of these.
  if (opts.benchmarkRunId !== undefined) {
    env.BENCHMARK_SLUG = BENCHMARK_SLUG;
    env.BENCHMARK_RUN_ID = opts.benchmarkRunId;
    env.PARTICIPANT_SLUG = opts.participantSlug ?? opts.provider;
  }
  for (const v of PROVIDER_SECRET_VARS) {
    const val = process.env[v];
    if (val) env[v] = val;
  }
  return env;
}

/**
 * Start one shard as a Namespace VM running the coordinator as the container's
 * PID 1. We call CreateInstance directly (via the package's exported
 * fetchNamespace) with `args: COORDINATOR_ARGS` instead of using
 * `sandbox.create` (which hardcodes `sleep infinity`). Because the coordinator
 * IS the container command, its stdout is captured natively by
 * `nsc logs --kind containers`, and the instance auto-reaps when it exits — no
 * runCommand, no self-destruct, no log redirect. Never throws — resolves with
 * rc so a failed shard doesn't take down its siblings.
 */
async function launchOne(shard: number, opts: ShardOpts, log: Logger): Promise<ShardResult> {
  const { virtualCpu, memoryMegabytes } = parseMachineType(opts.machineType);
  try {
    log(`creating sandbox (image=${opts.image} cpu=${virtualCpu} mem=${memoryMegabytes}MB duration=${opts.duration})`);
    const { token } = await getAndValidateCredentials({
      token: process.env.NSC_TOKEN,
      tokenFile: process.env.NSC_TOKEN_FILE,
    });

    // 1. create the instance with the coordinator as the container command.
    const requestBody = {
      shape: { virtual_cpu: virtualCpu, memory_megabytes: memoryMegabytes, machine_arch: 'amd64', os: 'linux' },
      containers: [{
        name: 'main-container',
        image_ref: opts.image,
        args: COORDINATOR_ARGS,
        environment: buildEnv(opts),
      }],
      documented_purpose: `scale ${opts.runId}`,
      deadline: new Date(Date.now() + durationToMs(opts.duration)).toISOString(),
    };
    let instanceId = '';
    try {
      const resp = await fetchNamespace(token, CREATE_INSTANCE, { method: 'POST', body: JSON.stringify(requestBody) });
      instanceId = String(resp?.metadata?.instanceId ?? '').trim();
    } catch (err) {
      log(`ERROR: create instance failed: ${errMsg(err)}`);
      return { shard, runId: opts.runId, rc: 1 };
    }
    if (!instanceId) {
      log('ERROR: no instanceId returned from CreateInstance');
      return { shard, runId: opts.runId, rc: 1 };
    }
    log(`instance: ${instanceId}`);

    // 2. confirm the container actually started the coordinator. DescribeInstance
    // reports metadata.status (RUNNING → … → DESTROYED) and, once stopped,
    // shutdownReasons[].errorCode (present only on a non-zero exit). We accept
    // RUNNING (normal) or a clean stop (fast run that already finished), and fail
    // only on a non-zero-exit stop (coordinator crashed on startup).
    let confirmed = false;
    for (let i = 1; i <= 30; i++) {
      try {
        const d = await fetchNamespace(token, DESCRIBE_INSTANCE, { method: 'POST', body: JSON.stringify({ instance_id: instanceId }) });
        const status = String(d?.metadata?.status ?? '');
        const reasons: Array<{ errorCode?: number }> = d?.shutdownReasons ?? [];
        if (status === 'RUNNING') { log(`coordinator confirmed running (after ${i})`); confirmed = true; break; }
        if (reasons.length > 0 || status === 'DESTROYED') {
          const crashed = reasons.some((r) => r.errorCode != null);
          if (crashed) {
            log(`ERROR: coordinator exited non-zero on startup — check: nsc logs ${instanceId} --kind containers`);
            return { shard, runId: opts.runId, rc: 1 };
          }
          log(`coordinator ran to completion (after ${i})`);
          confirmed = true; break;
        }
      } catch {
        // transient API error — retry below
      }
      await sleep(1000);
    }
    if (!confirmed) {
      // Create succeeded but we never saw RUNNING/terminal — most likely a slow
      // image pull or flaky DescribeInstance. The container will still run; don't
      // fail the shard, just flag it so the operator can check.
      log(`WARN: could not confirm status (create OK) — check: nsc logs ${instanceId} --kind containers`);
    }

    log(`OK  run_id=${opts.runId}  instance=${instanceId}`);
    log(`  Tail logs:  nsc logs ${instanceId} --kind containers --follow`);
    log(`  Destroy:    nsc destroy --force ${instanceId}`);
    return { shard, runId: opts.runId, rc: 0 };
  } catch (err) {
    log(`unexpected error: ${errMsg(err)}`);
    return { shard, runId: opts.runId, rc: 1 };
  }
}

/**
 * Create the platform run + plan one worker per VM before launching. Best-effort:
 * if no key is present or the API rejects, returns null and the burst runs
 * Tigris-only (bench reporting is optional). Needs an admin-scoped key for run
 * creation (COMPUTESDK_ADMIN_API_KEY, falling back to COMPUTESDK_API_KEY).
 */
async function createPlatformRun(args: Args, perVm: number): Promise<string | null> {
  const apiKey = process.env.COMPUTESDK_ADMIN_API_KEY ?? process.env.COMPUTESDK_API_KEY;
  if (!apiKey) {
    console.log('  bench:      disabled (no COMPUTESDK_API_KEY) — Tigris-only run\n');
    return null;
  }
  try {
    const client = createBenchmarkClient({ apiKey });
    await client.upsertBenchmark(BENCHMARK_SLUG, {
      name: 'Scale',
      kind: 'scale',
      config: { timeoutMs: BENCH_TIMEOUT_MS },
    });
    const { run } = await client.createRun(BENCHMARK_SLUG, {
      name: args.label ?? `scale.${args.provider}`,
      totalTasks: args.total,
      workerCount: args.vms,
      participants: [args.provider],
      config: { timeoutMs: BENCH_TIMEOUT_MS },
    });
    // Plan exactly args.vms workers for the provider participant; each VM claims
    // one (taskRange.count == perVm by construction).
    await client.planWorkers(BENCHMARK_SLUG, run.id, args.provider, {
      workerCount: args.vms,
      targetConcurrency: perVm,
    });
    console.log(`  bench:      run ${run.id} (${args.vms} worker(s) planned for "${args.provider}")\n`);
    return run.id;
  } catch (err) {
    console.warn(`  bench:      run creation failed (${errMsg(err)}) — continuing Tigris-only\n`);
    return null;
  }
}

// ----- orchestration --------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const perVm = args.total / args.vms;
  const githubSha = process.env.GITHUB_SHA ?? shortSha();
  const sha8 = githubSha.slice(0, 8);
  const stamp = utcStamp();

  // GROUP_ID is shared across shards; suffix on each RUN_ID encodes position.
  const groupId = args.groupId ?? `${stamp}-${sha8}-${args.provider}-g${args.vms}x${perVm}`;
  const shardWidth = String(args.vms - 1).length;
  const pad = (n: number): string => String(n).padStart(shardWidth, '0');
  const runIds = Array.from({ length: args.vms }, (_, i) =>
    `${stamp}-${sha8}-${args.provider}-s${pad(i)}of${args.vms}`,
  );

  const rule = '═'.repeat(67);
  console.log(rule);
  console.log(' scale :: launch');
  console.log(rule);
  console.log(`  provider:   ${args.provider}`);
  const image = args.image ?? DEFAULT_SCALE_IMAGE;
  console.log(`  image:      ${image}`);
  console.log(`  total:      ${args.total.toLocaleString()} sandboxes`);
  console.log(`  vms:        ${args.vms}`);
  console.log(`  per-vm:     ${perVm.toLocaleString()} sandboxes`);
  console.log(`  duration:   ${args.duration}`);
  console.log(`  machine:    ${args.machineType}`);
  console.log(`  group_id:   ${groupId}`);
  console.log(`  label:      ${args.label ?? `scale.${args.provider}`}`);
  console.log('');

  for (const v of ['TIGRIS_STORAGE_ENDPOINT', 'TIGRIS_STORAGE_BUCKET', 'TIGRIS_STORAGE_ACCESS_KEY_ID', 'TIGRIS_STORAGE_SECRET_ACCESS_KEY']) {
    if (!process.env[v]) { console.error(`${v} not set (check .env)`); process.exit(2); }
  }
  if (!process.env.NSC_TOKEN && !process.env.NSC_TOKEN_FILE) {
    console.error('NSC_TOKEN (or NSC_TOKEN_FILE) not set — needed to create Namespace VMs (check .env)');
    process.exit(2);
  }

  const sharded = args.vms > 1;

  // Create the platform run + plan workers up front (best-effort). The returned
  // run id is injected into every VM so each claims one planned worker.
  const benchmarkRunId = await createPlatformRun(args, perVm);

  // Launch a single shard. attempt 0 uses the canonical RUN_ID; retries mint a
  // fresh `-r{attempt}` RUN_ID so the retry's results don't collide with the
  // failed instance's. GROUP_ID + SHARD_INDEX stay fixed, so batch watch and
  // aggregate still see it as the same shard. A retried VM re-claims a still-
  // pending platform worker (one whose VM never claimed); if none remain it runs
  // Tigris-only.
  const launchShard = (i: number, attempt: number): Promise<ShardResult> => {
    const tag = sharded ? `[s${pad(i)}${attempt > 0 ? `r${attempt}` : ''}] ` : '';
    const log: Logger = (line) => console.log(`${tag}${line}`);
    const opts: ShardOpts = {
      provider: args.provider,
      image,
      runId: attempt > 0 ? `${runIds[i]}-r${attempt}` : runIds[i],
      concurrencyTarget: perVm,
      duration: args.duration,
      machineType: args.machineType,
      githubSha,
      label: args.label,
      ...(sharded ? { groupId, shardIndex: i, shardCount: args.vms } : {}),
      ...(benchmarkRunId ? { benchmarkRunId, participantSlug: args.provider } : {}),
    };
    return launchOne(i, opts, log);
  };

  console.log(`spawning ${args.vms} parallel launch(es)…\n`);
  const results = await Promise.all(
    Array.from({ length: args.vms }, (_, i) => launchShard(i, 0)),
  );

  // Re-launch any shards whose launch failed, up to --retries extra rounds.
  // Keyed by shard index so the latest attempt's result replaces the earlier one.
  const byShard = new Map(results.map((r) => [r.shard, r]));
  for (let attempt = 1; attempt <= args.retries; attempt++) {
    const failedShards = [...byShard.values()].filter((r) => r.rc !== 0).map((r) => r.shard).sort((a, b) => a - b);
    if (failedShards.length === 0) break;
    console.log(`\nretry ${attempt}/${args.retries}: re-launching ${failedShards.length} failed shard(s): ${failedShards.map(pad).join(', ')}\n`);
    const retried = await Promise.all(failedShards.map((i) => launchShard(i, attempt)));
    for (const r of retried) byShard.set(r.shard, r);
  }

  const finalResults = [...byShard.values()].sort((a, b) => a.shard - b.shard);

  console.log('');
  console.log(rule);
  console.log(' summary');
  console.log(rule);
  console.log(`  group_id: ${groupId}`);
  console.log('');
  let failed = 0;
  for (const r of finalResults) {
    const tag = r.rc === 0 ? 'OK  ' : 'FAIL';
    console.log(`  shard ${pad(r.shard)}/${args.vms}  ${tag}  rc=${r.rc}  ${r.runId}`);
    if (r.rc !== 0) failed++;
  }
  console.log('');
  // watch/aggregate read the platform run (all VMs report under the one run id
  // created above). When bench is disabled, only the per-shard Tigris output
  // exists, so fall back to --recent.
  if (benchmarkRunId) {
    console.log(`  run_id:    ${benchmarkRunId}`);
    console.log(`  Watch:     npm run bench:scale:watch -- ${benchmarkRunId}`);
    console.log(`  Aggregate: npm run bench:scale:aggregate -- --run ${benchmarkRunId}`);
  } else {
    console.log(`  Watch:     npm run bench:scale:watch -- --recent 1`);
    console.log(`  Aggregate: npm run bench:scale:aggregate -- --recent`);
  }

  if (failed > 0) {
    console.log(`\n${failed}/${finalResults.length} launches failed${args.retries > 0 ? ` after ${args.retries} retr${args.retries === 1 ? 'y' : 'ies'}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
