#!/usr/bin/env node
/**
 * Spin up N idle Namespace VMs from a scale image — WITHOUT running the
 * coordinator. Each VM's container command is overridden to `sleep infinity`,
 * so the coordinator never runs and NO sandboxes are created. The VMs sit idle
 * with the image baked in until their `deadline` auto-reaps them (or you kill
 * them early). Intended as a provisioning / capacity "dry run" of the 1000-VM
 * fan-out without doing any benchmark work.
 *
 * This is intentionally separate from start.ts: start.ts requires --provider and
 * runs the coordinator as PID 1.
 *
 * Each VM is tagged `documented_purpose = "scale idle-<stamp>"`, so the kill
 * script cleans the whole batch up:
 *
 *   tsx src/scale/scripts/kill.ts idle-<stamp> --yes
 *
 * Required env:
 *   NSC_TOKEN (or NSC_TOKEN_FILE)   Namespace API token (same one start.ts uses)
 *
 * Usage:
 *   tsx src/scale/scripts/spinup-idle.ts --count 1000 --duration 15m
 *   tsx src/scale/scripts/spinup-idle.ts -n 1000 -i nscr.io/5enq753trme1k/scale:norun
 *   tsx src/scale/scripts/spinup-idle.ts -n 1000 --dry-run
 */

import 'dotenv/config';
import { fetchNamespace, getAndValidateCredentials } from '@computesdk/namespace';

const CREATE_INSTANCE = '/namespace.cloud.compute.v1beta.ComputeService/CreateInstance';

// Override the image command so nothing auto-runs — the VM just idles until its
// deadline reaps it.
const IDLE_ARGS = ['sleep', 'infinity'];

const MACHINE_TYPE_DEFAULT = '1x2';
const DEFAULT_IMAGE =
  `${process.env.SCALE_IMAGE_REPO ?? 'nscr.io/5enq753trme1k/scale'}:${process.env.SCALE_IMAGE_TAG ?? 'norun'}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** "1x2" → 1 vCPU, 2048 MB (matches start.ts). */
function parseMachineType(shape: string): { virtualCpu: number; memoryMegabytes: number } {
  const m = /^(\d+)x(\d+)$/.exec(shape.trim());
  if (!m) { console.error(`--machine-type must be "<cpu>x<memGB>" (e.g. 1x2), got: ${shape}`); process.exit(2); }
  return { virtualCpu: parseInt(m[1], 10), memoryMegabytes: parseInt(m[2], 10) * 1024 };
}

/** "30m", "2h", "1h30m", or bare minutes → minutes (null if unparseable). */
function durationMinutes(dur: string): number | null {
  const t = dur.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i.exec(t);
  if (!m || (!m[1] && !m[2])) return null;
  return (m[1] ? parseInt(m[1], 10) * 60 : 0) + (m[2] ? parseInt(m[2], 10) : 0);
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

interface Args {
  count: number;
  image: string;
  duration: string;
  machineType: string;
  concurrency: number;
  dryRun: boolean;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/spinup-idle.ts [options]',
    '',
    'Spins up N idle Namespace VMs from a scale image (coordinator NOT run, no',
    'sandboxes created). VMs auto-reap at their deadline or via the kill script.',
    '',
    'Options:',
    '  --count <n>,    -n     Number of idle VMs to create (default: 1000)',
    `  --image <ref>,  -i     Container image (default: ${DEFAULT_IMAGE})`,
    '  --duration <dur>       VM deadline / max lifetime (default: 15m)',
    `  --machine-type <type>  Namespace machine type (default: ${MACHINE_TYPE_DEFAULT})`,
    '  --concurrency <n>      Parallel CreateInstance calls in flight (default: 50)',
    '  --dry-run              Print what WOULD be created and exit (no API calls)',
    '  --help, -h             Print this help',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Partial<Args> = { count: 1000, image: DEFAULT_IMAGE, duration: '15m', machineType: MACHINE_TYPE_DEFAULT, concurrency: 50, dryRun: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--count' || a === '-n') out.count = parseInt(next(), 10);
    else if (a === '--image' || a === '-i') out.image = next();
    else if (a === '--duration') out.duration = next();
    else if (a === '--machine-type') out.machineType = next();
    else if (a === '--concurrency') out.concurrency = parseInt(next(), 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!Number.isFinite(out.count) || (out.count as number) <= 0) { console.error(`--count must be a positive integer\n${usage()}`); process.exit(2); }
  if (!Number.isFinite(out.concurrency) || (out.concurrency as number) <= 0) { console.error('--concurrency must be a positive integer'); process.exit(2); }
  if (durationMinutes(out.duration as string) === null) { console.error(`--duration must be like 30m, 2h, 1h30m, or minutes (got: ${out.duration})`); process.exit(2); }
  return out as Args;
}

interface LaunchResult { index: number; instanceId: string; rc: number; }

/** Create one idle VM. Never throws — resolves with rc so siblings survive. */
async function launchOne(token: string, index: number, purpose: string, image: string, machineType: string, deadline: string): Promise<LaunchResult> {
  const { virtualCpu, memoryMegabytes } = parseMachineType(machineType);
  const requestBody = {
    shape: { virtual_cpu: virtualCpu, memory_megabytes: memoryMegabytes, machine_arch: 'amd64', os: 'linux' },
    containers: [{ name: 'main-container', image_ref: image, args: IDLE_ARGS }],
    documented_purpose: purpose,
    deadline,
  };
  try {
    const resp = await fetchNamespace(token, CREATE_INSTANCE, { method: 'POST', body: JSON.stringify(requestBody) });
    const instanceId = String(resp?.metadata?.instanceId ?? '').trim();
    if (!instanceId) { console.log(`  [${index}] ERROR: no instanceId returned`); return { index, instanceId: '', rc: 1 }; }
    return { index, instanceId, rc: 0 };
  } catch (err) {
    console.log(`  [${index}] ERROR: create failed: ${errMsg(err)}`);
    return { index, instanceId: '', rc: 1 };
  }
}

/** Run async tasks over a range with a bounded number in flight (from kill.ts). */
async function pool(count: number, limit: number, fn: (i: number) => Promise<LaunchResult>): Promise<LaunchResult[]> {
  const results: LaunchResult[] = [];
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    while (cursor < count) {
      const i = cursor++;
      results.push(await fn(i));
      if (++done % 100 === 0 || done === count) console.log(`  progress: ${done}/${count} created`);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const stamp = utcStamp();
  const tag = `idle-${stamp}`;
  const purpose = `scale ${tag}`;
  const mins = durationMinutes(args.duration) as number;
  const deadline = new Date(Date.now() + mins * 60 * 1000).toISOString();

  const rule = '═'.repeat(67);
  console.log(rule);
  console.log(` scale :: spin up idle VMs${args.dryRun ? ' (DRY RUN — no API calls)' : ''}`);
  console.log(rule);
  console.log(`  count:      ${args.count}`);
  console.log(`  image:      ${args.image}`);
  console.log(`  command:    ${IDLE_ARGS.join(' ')}  (coordinator NOT run, no sandboxes)`);
  console.log(`  duration:   ${args.duration} (deadline ${deadline})`);
  console.log(`  machine:    ${args.machineType}`);
  console.log(`  purpose:    ${purpose}`);
  console.log(`  concurrency:${args.concurrency}`);
  console.log('');

  if (args.dryRun) {
    console.log(`DRY RUN: would create ${args.count} VM(s) with the above settings. No API calls made.`);
    console.log(`Re-run without --dry-run to actually create them.`);
    return;
  }

  if (!process.env.NSC_TOKEN && !process.env.NSC_TOKEN_FILE) {
    console.error('NSC_TOKEN (or NSC_TOKEN_FILE) not set — needed to create Namespace VMs (check .env)');
    process.exit(2);
  }
  const { token } = await getAndValidateCredentials({ token: process.env.NSC_TOKEN, tokenFile: process.env.NSC_TOKEN_FILE });

  const results = await pool(args.count, args.concurrency, (i) => launchOne(token, i, purpose, args.image, args.machineType, deadline));
  const ok = results.filter((r) => r.rc === 0);
  const failed = results.length - ok.length;

  console.log('');
  console.log(rule);
  console.log(' summary');
  console.log(rule);
  console.log(`  created:   ${ok.length}/${args.count} idle VM(s)`);
  if (failed > 0) console.log(`  failed:    ${failed}`);
  console.log(`  purpose:   ${purpose}`);
  console.log('');
  console.log(`  Kill all:  tsx src/scale/scripts/kill.ts ${tag} --yes`);
  console.log(`  (they also auto-reap at the ${args.duration} deadline)`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
