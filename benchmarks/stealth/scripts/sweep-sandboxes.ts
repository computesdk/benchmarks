/**
 * Delete leftover sandboxes on a provider, filtered by name prefix.
 *
 * The burst-tti-1k bench tags every box `tti1k-<runTag>-i<idx>` (providers with
 * `supportsCreateNameOption`), so its own post-destroy sweep can only see this
 * run's strays. This script sweeps anything older/other runs left behind.
 *
 * Safety: --name-prefix or --all is required; there is no default. --dry-run
 * lists what would be deleted without deleting.
 *
 * Run (vault creds first):
 *   . ./benchmarks/stealth/scripts/load-vault-secrets.sh '^(CREATEOS_SANDBOX_API_KEY)='
 *   pnpm tsx benchmarks/stealth/scripts/sweep-sandboxes.ts --provider createos --name-prefix tti1k --dry-run
 *   pnpm tsx benchmarks/stealth/scripts/sweep-sandboxes.ts --provider createos --name-prefix tti1k
 *   pnpm tsx benchmarks/stealth/scripts/sweep-sandboxes.ts --provider createos --all
 *
 * Flags:
 *   --provider <name>     provider key from benchmarks/stealth/sandbox/providers.ts (required)
 *   --name-prefix <p>     delete only sandboxes whose name starts with p
 *   --all                 delete every listed sandbox (no prefix filter)
 *   --dry-run             list matches without deleting
 *   --concurrency <n>     parallel deletes (default 32)
 *   --attempt-timeout <ms> per-delete timeout (default 30000)
 *   --attempts <n>        retries per sandbox (default 5)
 */
import '../src/env.js';
import { providers } from '../sandbox/providers.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const providerName = value('--provider');
const prefix = value('--name-prefix');
const all = flag('--all');
const dryRun = flag('--dry-run');
const concurrency = Number(value('--concurrency')) || 32;
const attemptTimeoutMs = Number(value('--attempt-timeout')) || 30_000;
const maxAttempts = Number(value('--attempts')) || 5;

if (!providerName) {
  console.error('usage: --provider <name> (--name-prefix <p> | --all) [--dry-run]');
  process.exit(1);
}
if (!all && prefix === undefined) {
  console.error('refusing to sweep unfiltered: pass --name-prefix <p> or --all');
  process.exit(1);
}

const p = providers.find((x) => x.name === providerName);
if (!p) {
  console.error(`unknown provider "${providerName}"; known: ${providers.map((x) => x.name).join(', ')}`);
  process.exit(1);
}
for (const key of p.requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`missing env var ${key} — load it first (see header comment)`);
    process.exit(1);
  }
}

const compute = p.createCompute();
const manager = compute.sandbox;
if (typeof manager?.list !== 'function') {
  console.error(`${providerName} compute has no sandbox.list() — cannot sweep`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`delete timed out after ${ms}ms`)), ms)),
  ]);

const listed = await manager.list();
const strays = (listed as any[]).filter((e) => {
  if (all) return true;
  const name = e?.instance?.name ?? e?.name;
  return typeof name === 'string' && name.startsWith(prefix!);
});

console.log(
  `${providerName}: ${listed.length} sandbox(es) listed, ${strays.length} match ${all ? '--all' : `"${prefix}*"`}`,
);
for (const e of strays) {
  const inst = e?.instance ?? e;
  console.log(`  ${e?.instanceId ?? inst?.id ?? '?'}  ${inst?.name ?? ''}  ${inst?.status ?? ''}`);
}
if (dryRun || strays.length === 0) process.exit(0);

let deleted = 0;
let failed = 0;
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, strays.length) }, async () => {
    while (next < strays.length) {
      const e = strays[next++];
      const inst = e?.instance ?? e;
      const id = e?.instanceId ?? inst?.id;
      const label = `${inst?.name ?? id ?? '?'}`;
      let ok = false;
      for (let attempt = 1; attempt <= maxAttempts && !ok; attempt++) {
        try {
          if (typeof inst?.destroy === 'function') {
            await withDeadline(inst.destroy(), attemptTimeoutMs);
          } else if (id != null && typeof manager.destroy === 'function') {
            await withDeadline(manager.destroy(id), attemptTimeoutMs);
          } else {
            break;
          }
          ok = true;
        } catch (err) {
          if (attempt === maxAttempts) {
            console.error(`  FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
          } else {
            await sleep(500 + Math.floor(Math.random() * 1500));
          }
        }
      }
      if (ok) deleted += 1;
      else failed += 1;
    }
  }),
);

console.log(`swept ${deleted}, failed ${failed}`);
process.exit(failed > 0 ? 2 : 0);
