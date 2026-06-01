#!/usr/bin/env node
/**
 * Run the burst-100k coordinator directly on the current machine.
 *
 * This is the no-Namespace-VM path: it defaults to SQLite + local artifact
 * files, sets the run metadata that launch.sh normally injects on a VM, then
 * hands control to src/burst-100k/coordinator.ts.
 *
 * Usage:
 *   npm run bench:burst-100k:direct
 *   npm run bench:burst-100k:direct -- --concurrency 1000
 *   npm run bench:burst-100k:direct -- --provider tensorlake
 */

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getProvider } from '../src/burst-100k/providers.js';

interface Args {
  provider: string;
  concurrency?: string;
  runId?: string;
  sqlitePath?: string;
  outputDir?: string;
  localArtifacts: boolean;
  skipSchema: boolean;
}

function usage(): string {
  return [
    'Usage: tsx scripts/burst-100k-run-direct.ts [options]',
    '',
    'Options:',
    '  --provider <name>, -p      Provider to run (default: tensorlake)',
    '  --concurrency <n>, -c     Override provider concurrency target',
    '  --run-id <id>             Run id (default: timestamp-sha-provider-direct)',
    '  --sqlite <path>           Use SQLite at this path, even if PG_URL is set',
    '  --output-dir <path>       Local artifact directory (default: burst-100k-runs/<run-id>)',
    '  --local-artifacts         Use local artifact files, even if Tigris env vars are set',
    '  --skip-schema             Do not apply Postgres schema when PG_URL is set',
    '  --help, -h                Print this help',
    '',
    'Examples:',
    '  npm run bench:burst-100k:direct',
    '  npm run bench:burst-100k:direct -- --concurrency 1000',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { provider: 'tensorlake', localArtifacts: false, skipSchema: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`missing value for ${a}`);
        process.exit(2);
      }
      return v;
    };
    if (a === '--provider' || a === '-p') {
      out.provider = next();
    } else if (a === '--concurrency' || a === '-c') {
      out.concurrency = next();
    } else if (a === '--run-id') {
      out.runId = next();
    } else if (a === '--sqlite') {
      out.sqlitePath = next();
    } else if (a === '--output-dir') {
      out.outputDir = next();
    } else if (a === '--local-artifacts') {
      out.localArtifacts = true;
    } else if (a === '--skip-schema') {
      out.skipSchema = true;
    } else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}\n${usage()}`);
      process.exit(2);
    }
  }
  if (out.concurrency && !/^\d+$/.test(out.concurrency)) {
    console.error(`--concurrency must be a positive integer (got: ${out.concurrency})`);
    process.exit(2);
  }
  return out;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function gitSha(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout.trim() : 'local';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function applySchema(pgUrl: string): void {
  const result = spawnSync('psql', [pgUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'db/burst-100k.sql'], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`failed to run psql: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function teeCoordinatorLog(logPath: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const file = fs.createWriteStream(logPath, { flags: 'a' });
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
    file.write(chunk, typeof encoding === 'string' ? encoding : undefined);
    return stdoutWrite(chunk, encoding, cb);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, encoding?: any, cb?: any) => {
    file.write(chunk, typeof encoding === 'string' ? encoding : undefined);
    return stderrWrite(chunk, encoding, cb);
  }) as typeof process.stderr.write;
}

const args = parseArgs();
const provider = getProvider(args.provider);

for (const name of provider.requiredEnvVars) required(name);

const sha = process.env.GITHUB_SHA ?? gitSha();
const runId = args.runId ?? `${timestamp()}-${sha.slice(0, 8)}-${args.provider}-direct`;
const instanceId = process.env.INSTANCE_ID ?? `${os.hostname()}-${process.pid}`;
const outputDir = path.resolve(args.outputDir ?? process.env.BURST_100K_OUTPUT_DIR ?? path.join('burst-100k-runs', runId));
const requestedSqlitePath = args.sqlitePath ?? process.env.SQLITE_PATH;
const usePostgres = Boolean(process.env.PG_URL && !requestedSqlitePath);
const sqlitePath = path.resolve(requestedSqlitePath ?? path.join('burst-100k-runs', 'burst-100k.sqlite'));
const logPath = process.env.COORDINATOR_LOG_PATH ?? path.join(outputDir, 'coordinator.log');
const useTigris = hasTigrisEnv() && !args.localArtifacts;

process.env.PROVIDER = args.provider;
process.env.RUN_ID = runId;
process.env.GITHUB_SHA = sha;
process.env.INSTANCE_ID = instanceId;
if (!usePostgres) {
  delete process.env.PG_URL;
  process.env.SQLITE_PATH = sqlitePath;
}
process.env.BURST_100K_OUTPUT_DIR = outputDir;
process.env.COORDINATOR_LOG_PATH = logPath;
if (!useTigris) {
  delete process.env.TIGRIS_STORAGE_ENDPOINT;
  delete process.env.TIGRIS_STORAGE_BUCKET;
  delete process.env.TIGRIS_STORAGE_ACCESS_KEY_ID;
  delete process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY;
}
if (args.concurrency) process.env.CONCURRENCY_TARGET = args.concurrency;

console.log(`[direct] RUN_ID=${runId} PROVIDER=${args.provider} INSTANCE_ID=${instanceId}`);
if (args.concurrency) console.log(`[direct] CONCURRENCY_TARGET override: ${args.concurrency}`);
console.log(usePostgres ? '[direct] run sink: Postgres (PG_URL)' : `[direct] run sink: SQLite (${process.env.SQLITE_PATH})`);
console.log(useTigris ? '[direct] artifact sink: Tigris' : `[direct] artifact sink: local files (${outputDir})`);

if (usePostgres && args.skipSchema) {
  console.log('[direct] skipping Postgres schema (--skip-schema)');
} else if (usePostgres) {
  console.log('[direct] ensuring Postgres schema');
  applySchema(process.env.PG_URL);
}

console.log(`[direct] writing coordinator log to ${logPath}`);
teeCoordinatorLog(logPath);

await import('../src/burst-100k/coordinator.js');

function hasTigrisEnv(): boolean {
  return Boolean(
    process.env.TIGRIS_STORAGE_ENDPOINT &&
    process.env.TIGRIS_STORAGE_BUCKET &&
    process.env.TIGRIS_STORAGE_ACCESS_KEY_ID &&
    process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY,
  );
}
