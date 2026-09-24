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
import { run as runPlatformCli, resolveAuth } from '@benchsdk/cli';
import type { CliAuth } from '@benchsdk/cli';
import { createBenchmarkClient, type BenchmarkClient } from '@benchsdk/api';
import { filterParticipantsByEnv, selectParticipants } from '@benchsdk/worker';
import { parseCliArgs, resolveShape, runBenchmark } from './runner.js';
import { NoAvailableParticipantsError } from './no-available-participants.js';
import { validateBenchmarkConfig, BenchmarkConfigError, type BenchmarkConfig as TypedBenchmarkConfig } from './bench-config.js';
import { scoringConfigToSpec, validateScoringSpec, lowerIsBetter, higherIsBetter } from './scoring.js';
import type { BaseParticipant } from '@benchsdk/worker';
import type { BenchmarkConfig, BenchmarkTask } from './bench-config.js';

const USAGE =
  'Usage:\n' +
  '  bench run <file.bench.ts> [--shape name] [--provider a,b] [--run-key key] [--worker-pool N]\n' +
  '      [--benchmark slug] [--name "My benchmark"]\n' +
  '      [--iterations N] [--concurrency N] [--stagger-delay-ms N] [--group-by participant|round]\n' +
  '      [--close-after-ms N] [--no-ingest | --dry-run] [--check]\n' +
  '  bench check <file.bench.ts> [--base-url <url>] [--api-key <key>]';

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
 * Extracts `--name value` / `--name=value` from argv, returning the value and
 * the remaining args. Throws usage when the value is missing or looks like
 * another flag.
 */
function shiftFlag(argv: string[], name: string): { value: string | undefined; argv: string[] } {
  const prefix = `--${name}`;
  const prefixEq = `${prefix}=`;
  const result: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === prefix) {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(USAGE);
      value = next;
      continue;
    }
    if (arg.startsWith(prefixEq)) {
      const eqValue = arg.slice(prefixEq.length);
      if (!eqValue) throw new Error(USAGE);
      value = eqValue;
      continue;
    }
    result.push(arg);
  }
  return { value, argv: result };
}

/** Splits `--base-url` / `--api-key` off the flag list shared by `run` and `check`. */
function shiftPlatformFlags(flags: string[]): { baseUrl?: string; apiKey?: string; flags: string[] } {
  const { value: baseUrl, argv: withoutBaseUrl } = shiftFlag(flags, 'base-url');
  const { value: apiKey, argv: rest } = shiftFlag(withoutBaseUrl, 'api-key');
  return { baseUrl, apiKey, flags: rest };
}

/**
 * Validates environment, API connectivity, participant availability, and scoring
 * weights for a `*.bench.ts` module without executing any tasks.
 */
export async function runCheck(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const [file, ...flags] = rest;
  if (command !== 'check' || !file || file.startsWith('-')) throw new Error(USAGE);

  const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)) as BenchmarkModule;
  const config = mod.config;
  const task = mod.task ?? mod.default;
  if (!isBenchmarkConfig(config)) {
    throw new Error(`${file} must export a \`config\` created with defineBenchmarkConfig (with participants).`);
  }
  if (typeof task !== 'function') {
    throw new Error(`${file} must export a \`task\` created with defineTask.`);
  }

  const cfg = config as TypedBenchmarkConfig<BaseParticipant>;
  const configIssues = validateBenchmarkConfig(cfg);
  if (configIssues.length > 0) {
    throw new BenchmarkConfigError(configIssues);
  }

  const { baseUrl, apiKey, flags: runnerFlags } = shiftPlatformFlags(flags);
  const parsed = parseCliArgs(runnerFlags, cfg.customCliFlags ?? []);
  resolveShape(cfg, parsed.shape);
  const dryRun = parsed.noIngest ?? false;

  let client: BenchmarkClient | undefined;
  let apiOk = dryRun;
  let auth: CliAuth | null = null;
  if (!dryRun) {
    try {
      auth = await resolveAuth({ baseUrl, apiKey });
      client = createBenchmarkClient({
        baseUrl: auth.apiBaseUrl,
        apiKey: auth.apiKey,
        token: auth.token,
        orgSlug: auth.orgSlug,
        orgId: auth.orgId,
      });
      await client.listBenchmarks({ limit: 1 });
      apiOk = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[benchsdk] API connectivity check failed: ${message}`);
    }
  }

  const effectiveProviderNames = parsed.providers ?? cfg.defaultProviders;

  let selected: BaseParticipant[];
  try {
    selected = selectParticipants(cfg.participants, effectiveProviderNames);
  } catch (err) {
    throw new Error(`Participant selection failed: ${err instanceof Error ? err.message : err}`);
  }
  const { available, skipped } = filterParticipantsByEnv(selected);

  let scoringOk = true;
  if (cfg.onScore) {
    try {
      const spec = await cfg.onScore(lowerIsBetter, higherIsBetter);
      validateScoringSpec(spec);
    } catch (err) {
      scoringOk = false;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[benchsdk] Scoring validation failed: ${message}`);
    }
  } else if (cfg.scoring) {
    try {
      const spec = scoringConfigToSpec(cfg.scoring, cfg.dimensions);
      validateScoringSpec(spec);
    } catch (err) {
      scoringOk = false;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[benchsdk] Scoring validation failed: ${message}`);
    }
  }

  // Provider requiredEnvVars are reported in participants.skipped; this only
  // tracks the platform API key/token required for a non-dry-run submission.
  const missingPlatformAuth = dryRun
    ? []
    : auth
      ? []
      : [['BENCHMARKS_PLATFORM_API_KEY or BENCHMARKS_PLATFORM_TOKEN', undefined]];

  for (const [name] of missingPlatformAuth) {
    console.warn(`[benchsdk] ${name} is not set`);
  }

  const report = {
    file,
    benchmarkSlug: cfg.benchmarkSlug,
    apiOk,
    envOk: dryRun || missingPlatformAuth.length === 0,
    participants: {
      requested: selected.map((p) => p.name),
      available: available.map((p) => p.name),
      skipped: skipped.map((s) => ({ name: s.name, missing: s.missing })),
    },
    scoringOk: cfg.scoring || cfg.onScore ? scoringOk : undefined,
  };

  console.log(JSON.stringify(report, null, 2));

  const authFailure = !dryRun && missingPlatformAuth.length > 0;
  if (!apiOk || available.length === 0 || scoringOk === false || authFailure) {
    throw new Error('Benchmark check failed. See warnings above for details.');
  }
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

  const check = flags.includes('--check') || flags.includes('--validate');
  if (check) {
    const checkFlags = flags.filter((f) => f !== '--check' && f !== '--validate');
    return runCheck(['check', file, ...checkFlags]);
  }

  const { baseUrl, apiKey, flags: runnerFlags } = shiftPlatformFlags(flags);

  const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)) as BenchmarkModule;
  const config = mod.config;
  const task = mod.task ?? mod.default;

  if (!isBenchmarkConfig(config)) {
    throw new Error(`${file} must export a \`config\` created with defineBenchmarkConfig (with participants).`);
  }
  if (typeof task !== 'function') {
    throw new Error(`${file} must export a \`task\` created with defineTask.`);
  }

  const envFlags: string[] = [];
  if (process.env.BENCHMARK_SLUG) {
    envFlags.push('--benchmark', process.env.BENCHMARK_SLUG);
  }
  if (process.env.BENCHMARK_NAME) {
    envFlags.push('--name', process.env.BENCHMARK_NAME);
  }

  await runBenchmark(
    config as BenchmarkConfig<BaseParticipant>,
    task as BenchmarkTask<BaseParticipant>,
    [...envFlags, ...runnerFlags],
    { baseUrl, apiKey },
  );
}

/** Executable entry: dispatches to benchmark execution or platform data commands. */
export async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  try {
    if (command === 'run') {
      await runBenchmarkFile(argv);
    } else if (command === 'check') {
      await runCheck(argv);
    } else {
      return runPlatformCli(argv);
    }
    // Provider SDKs can leave sockets/timers open; exit explicitly so a
    // finished run doesn't hang.
    process.exit(0);
  } catch (err) {
    if (err instanceof NoAvailableParticipantsError) {
      console.log(err.message);
      process.exit(0);
    }
    console.error('Benchmark failed:', String(err));
    process.exit(1);
  }
}
