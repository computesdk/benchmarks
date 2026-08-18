/**
 * The author-facing entrypoint. `bench` is verbs-only — the benchmark and its
 * runs are implicit, never nouns you type:
 *
 *   bench run <file.bench.ts> [--flags]     execute a benchmark
 *
 * `run` imports a benchmark module, reads its `config` and `task` exports and
 * drives `runBenchmark`; CLI flags override the config's knobs and
 * `config.onComplete` (if any) fires once the run finishes. The benchmark is
 * declared in the file (`--shape` picks a named variant) and materialized on
 * run; a run is opened as a side effect, shared across sibling processes when
 * they pass the same `--run-key`. There are no imperative `create` commands.
 *
 * The executable wrapper lives in `bin.ts`; this module has no side effects so
 * it can be unit-tested by calling `runBenchmarkFile` directly.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCliArgs, runBenchmark } from './runner.js';
import { NoAvailableParticipantsError } from './no-available-participants.js';
import type { BaseParticipant } from '@benchsdk/client';
import type { BenchmarkConfig, BenchmarkTask } from './bench-config.js';

const USAGE =
  'Usage:\n' +
  '  bench run <file.bench.ts> [--shape name] [--provider a,b] [--run-key key]\n' +
  '      [--benchmark slug] [--name "My benchmark"]\n' +
  '      [--iterations N] [--concurrency N] [--stagger-delay-ms N] [--group-by participant|round]\n' +
  '      [--no-ingest | --dry-run]';

/** A benchmark module is expected to export `config` and `task`. */
interface BenchmarkModule {
  config?: unknown;
  task?: unknown;
  default?: unknown;
}

function isBenchmarkConfig(value: unknown): value is BenchmarkConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { benchmarkSlug?: unknown; participants?: unknown };
  return typeof candidate.benchmarkSlug === 'string' && Array.isArray(candidate.participants);
}

/**
 * Dispatches one CLI invocation. Throws on bad usage / invalid exports and lets
 * `NoAvailableParticipantsError` propagate so the caller can map it to a clean
 * exit. Does not call `process.exit`.
 */
export async function runBenchmarkFile(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  const [file, ...flags] = rest;
  if (command !== 'run' || !file || file.startsWith('-')) throw new Error(USAGE);

  const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)) as BenchmarkModule;
  const config = mod.config;
  const task = mod.task ?? mod.default;

  if (!isBenchmarkConfig(config)) {
    throw new Error(`${file} must export a \`config\` created with defineBenchmarkConfig (with participants).`);
  }
  if (typeof task !== 'function') {
    throw new Error(`${file} must export a \`task\` created with defineTask.`);
  }

  await runBenchmark(config as BenchmarkConfig<BaseParticipant>, task as BenchmarkTask<BaseParticipant>, flags);
}

/** Executable entry: runs the file and maps outcomes to process exit codes. */
export async function run(argv: string[]): Promise<void> {
  try {
    await runBenchmarkFile(argv);
    // Provider SDKs can leave sockets/timers open; exit explicitly so a
    // finished run doesn't hang.
    process.exit(0);
  } catch (err) {
    if (err instanceof NoAvailableParticipantsError) {
      console.log(err.message);
      process.exit(0);
    }
    console.error('Benchmark failed:', err instanceof Error ? err.message : err);
    // A BenchmarkApiError's message carries only the status line; the response
    // body holds the validation reason, so without this a failure reads as a
    // bare "400 Bad Request".
    const body = (err as { body?: unknown } | null)?.body;
    if (typeof body === 'string' && body.trim()) {
      console.error('Response body:', body.slice(0, 2000));
    }
    process.exit(1);
  }
}
