#!/usr/bin/env node
/**
 * Kill every running Namespace VM for a scale run.
 *
 * `start.ts` tags each VM's `documented_purpose` as `scale <RUN_ID>`, where the
 * per-VM RUN_ID is `<stamp>-<sha8>-<provider>-s<idx>of<count>` (see start.ts).
 * This script lists the *live* instances (ListInstances returns only running
 * VMs, unlike `nsc instance history`), matches them against the run id you pass,
 * and destroys them.
 *
 * The run id you pass is matched as a prefix, so pass whatever scope you want to
 * kill — exactly the ids printed in the launch summary / shard log lines:
 *
 *   # kill the whole burst (every shard sharing this prefix):
 *   tsx src/scale/scripts/kill.ts 20260617T131132Z-4f6cdb0b-e2b
 *   # kill a single shard:
 *   tsx src/scale/scripts/kill.ts 20260617T131132Z-4f6cdb0b-e2b-s999of1000
 *   npm run bench:scale:kill -- 20260617T131132Z-4f6cdb0b-e2b
 *
 * A match is: the instance's purpose run id equals the arg, or starts with the
 * arg followed by `-` (a `-s…`/`-r…` boundary). So the prefix above also catches
 * retried shards (`…-s5of10-r1`) but `…-s9` will NOT spuriously match `…-s90…`.
 *
 * Destroy is idempotent and best-effort per VM, and the script re-lists and
 * re-destroys in rounds until the run shows no live VMs (catching stragglers and
 * VMs still mid-creation). Use --dry-run to preview without destroying.
 *
 * Required env:
 *   NSC_TOKEN (or NSC_TOKEN_FILE)   Namespace API token (same one start.ts uses)
 *
 * Usage:
 *   tsx src/scale/scripts/kill.ts <run-id> [--dry-run] [--yes] [--concurrency n]
 */

import 'dotenv/config';
import { fetchNamespace, getAndValidateCredentials } from '@computesdk/namespace';
import { createInterface } from 'node:readline';

const LIST_INSTANCES = '/namespace.cloud.compute.v1beta.ComputeService/ListInstances';
const DESTROY_INSTANCE = '/namespace.cloud.compute.v1beta.ComputeService/DestroyInstance';

// ListInstances returns at most ~100 live VMs per call (no page token is offered,
// and page_size is ignored), so a large run is drained over many rounds. A list
// at/above this size means there are very likely more VMs not yet visible.
const LIST_PAGE_CAP = 100;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LiveInstance { instanceId: string; runId: string; status: string; }

interface Args {
  runId: string;
  dryRun: boolean;
  yes: boolean;
  concurrency: number;
  rounds: number;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/kill.ts <run-id> [options]',
    '',
    'Destroys every live Namespace VM whose run id matches <run-id> (prefix match).',
    'Pass the prefix from a launch (e.g. 20260617T131132Z-4f6cdb0b-e2b) to kill the',
    'whole burst, or a full per-VM run id (…-s999of1000) to kill one shard.',
    '',
    'Options:',
    '  --dry-run            List the matching VMs but do not destroy them',
    '  --yes, -y            Skip the confirmation prompt (required for non-TTY)',
    '  --concurrency <n>    Parallel destroy calls (default: 32)',
    '  --rounds <n>         Safety cap on re-list/destroy rounds (default: 100).',
    '                       ListInstances returns ~100 VMs per call, so a large run',
    '                       drains over many rounds (~100 VMs each).',
    '  --help, -h           Print this help',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Partial<Args> = { dryRun: false, yes: false, concurrency: 32, rounds: 100 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--concurrency') out.concurrency = parseInt(next(), 10);
    else if (a === '--rounds') out.rounds = parseInt(next(), 10);
    else if (a === '--run' || a === '--run-id') out.runId = next();
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
    else if (out.runId === undefined) out.runId = a;
    else { console.error(`unexpected extra argument: ${a}\n${usage()}`); process.exit(2); }
  }
  // Tolerate a pasted `scale <id>` documented_purpose or a stray leading prefix.
  if (out.runId) out.runId = out.runId.trim().replace(/^scale\s+/, '');
  if (!out.runId) { console.error(`a <run-id> is required\n${usage()}`); process.exit(2); }
  if (!Number.isFinite(out.concurrency) || (out.concurrency as number) <= 0) {
    console.error('--concurrency must be a positive integer'); process.exit(2);
  }
  if (!Number.isFinite(out.rounds) || (out.rounds as number) <= 0) {
    console.error('--rounds must be a positive integer'); process.exit(2);
  }
  return out as Args;
}

/** True if a VM's purpose run id belongs to the requested run (prefix-at-boundary). */
function matchesRun(purposeRunId: string, runId: string): boolean {
  return purposeRunId === runId || purposeRunId.startsWith(`${runId}-`);
}

/** List the live VMs (ListInstances is running-only) belonging to the run. */
async function listMatching(token: string, runId: string): Promise<LiveInstance[]> {
  const resp = await fetchNamespace(token, LIST_INSTANCES, { method: 'POST', body: JSON.stringify({}) });
  const instances: any[] = resp?.instances ?? [];
  const out: LiveInstance[] = [];
  for (const it of instances) {
    const instanceId = String(it?.instanceId ?? it?.metadata?.instanceId ?? '').trim();
    const purposeRunId = String(it?.documentedPurpose ?? it?.documented_purpose ?? '').replace(/^scale\s+/, '').trim();
    if (instanceId && matchesRun(purposeRunId, runId)) {
      out.push({ instanceId, runId: purposeRunId, status: String(it?.status ?? '') });
    }
  }
  return out;
}

/** Destroy one VM. Resolves true on success; logs and resolves false otherwise. */
async function destroyOne(token: string, instanceId: string): Promise<boolean> {
  try {
    await fetchNamespace(token, DESTROY_INSTANCE, {
      method: 'POST',
      body: JSON.stringify({ instance_id: instanceId, reason: 'scale kill' }),
    });
    return true;
  } catch (err) {
    console.log(`  destroy ${instanceId} failed: ${errMsg(err)}`);
    return false;
  }
}

/** Run async tasks over `items` with a bounded number in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<boolean>): Promise<number> {
  let ok = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (await fn(item)) ok++;
    }
  });
  await Promise.all(workers);
  return ok;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!process.env.NSC_TOKEN && !process.env.NSC_TOKEN_FILE) {
    console.error('NSC_TOKEN (or NSC_TOKEN_FILE) not set — needed to reach Namespace (check .env)');
    process.exit(2);
  }
  const { token } = await getAndValidateCredentials({
    token: process.env.NSC_TOKEN,
    tokenFile: process.env.NSC_TOKEN_FILE,
  });

  const rule = '═'.repeat(67);
  console.log(rule);
  console.log(' scale :: kill');
  console.log(rule);
  console.log(`  run-id:   ${args.runId}`);
  console.log(`  mode:     ${args.dryRun ? 'dry-run (no destroy)' : 'destroy'}`);
  console.log('');

  const initial = await listMatching(token, args.runId);
  if (initial.length === 0) {
    console.log(`No live VMs match "${args.runId}" — nothing to kill.`);
    return;
  }

  // Show a small sample so the operator can sanity-check the match before nuking.
  // ListInstances returns at most ~100 VMs per call, so `initial.length` is a
  // floor, not the true total — a large run reveals the rest as we destroy these.
  const capped = initial.length >= LIST_PAGE_CAP;
  console.log(`Found ${initial.length}${capped ? '+' : ''} live VM(s)${capped ? ' (list is capped per call; more may be underneath)' : ''}:`);
  for (const vm of initial.slice(0, 5)) console.log(`  ${vm.instanceId}  ${vm.status}  ${vm.runId}`);
  if (initial.length > 5) console.log(`  … and ${initial.length - 5} more`);
  console.log('');

  if (args.dryRun) {
    console.log('dry-run: not destroying. Re-run without --dry-run to kill.');
    return;
  }

  if (!args.yes) {
    const proceed = await confirm(`Destroy all ${initial.length}${capped ? '+' : ''} VM(s) matching "${args.runId}"? [y/N] `);
    if (!proceed) {
      console.log(process.stdin.isTTY ? 'Aborted.' : 'Refusing to destroy without --yes in a non-interactive shell.');
      process.exit(1);
    }
    console.log('');
  }

  // Re-list and re-destroy in rounds until the run shows no live VMs. Each list
  // only reveals ~100 VMs (LIST_PAGE_CAP), so a 1000-VM run drains over ~10
  // rounds — `remaining` is the still-visible batch, not the true total, so we
  // report cumulative destroys instead. The --rounds cap is a backstop; the
  // no-progress guard (a round where every destroy failed) is what stops a real
  // spin (e.g. a token that can list but not destroy).
  let totalDestroyed = 0;
  let remaining = initial;
  let round = 0;
  while (remaining.length > 0 && round < args.rounds) {
    round++;
    const ok = await pool(remaining.map((v) => v.instanceId), args.concurrency, (id) => destroyOne(token, id));
    totalDestroyed += ok;
    console.log(`round ${round}: destroyed ${ok}/${remaining.length} (${totalDestroyed} total)`);
    if (ok === 0) {
      console.log('no destroys succeeded this round — stopping (check the token has destroy permission).');
      break;
    }
    await sleep(2000);
    remaining = await listMatching(token, args.runId);
  }

  console.log('');
  console.log(rule);
  if (remaining.length === 0) {
    console.log(` done — destroyed ${totalDestroyed} VM(s) over ${round} round(s); run is clear.`);
  } else {
    console.log(` destroyed ${totalDestroyed} VM(s), but ${remaining.length}${remaining.length >= LIST_PAGE_CAP ? '+' : ''} still live after ${round} round(s) — re-run to finish.`);
  }
  console.log(rule);
  if (remaining.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
