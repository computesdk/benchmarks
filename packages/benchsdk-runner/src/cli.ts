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
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { run as runPlatformCli, resolveAuth } from '@benchsdk/cli';
import type { CliAuth } from '@benchsdk/cli';
import { createBenchmarkClient, type BenchmarkClient, type BenchmarkClientConfig } from '@benchsdk/api';
import { filterParticipantsByEnv, selectParticipants } from '@benchsdk/worker';
import { parseCliArgs, runBenchmark, type CliArgs } from './runner.js';
import { NoAvailableParticipantsError } from './no-available-participants.js';
import { validateBenchmarkConfig, BenchmarkConfigError, type BenchmarkConfig as TypedBenchmarkConfig } from './bench-config.js';
import { scoringConfigToSpec, validateScoringSpec, lowerIsBetter, higherIsBetter } from './scoring.js';
import type { BaseParticipant } from '@benchsdk/worker';
import type { BenchmarkConfig, BenchmarkTask } from './bench-config.js';

const USAGE =
  'Usage:\n' +
  '  bench run <file.bench.ts> [--shape name] [--provider a,b] [--run-key key]\n' +
  '      [--benchmark slug] [--name "My benchmark"]\n' +
  '      [--iterations N] [--concurrency N] [--stagger-delay-ms N] [--group-by participant|round]\n' +
  '      [--no-ingest | --dry-run] [--check] [--config <file>]\n' +
  '  bench check <file.bench.ts> [--base-url <url>] [--api-key <key>] [--config <file>]';

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

function getFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === prefix) {
      const value = argv[i + 1];
      return value?.startsWith('--') ? undefined : value;
    }
    if (arg.startsWith(`${prefix}=`)) {
      return arg.slice(prefix.length + 1);
    }
  }
  return undefined;
}

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

/** Project-level CLI config defaults. */
export interface BenchSdkConfig {
  baseUrl?: string;
  /** Environment variable name to read the API key from. Project config files should not store secrets. */
  apiKeyEnv?: string;
  providers?: string[];
  iterations?: number;
  concurrency?: number;
  staggerDelayMs?: number;
  groupBy?: 'participant' | 'round';
  shape?: string;
  runKey?: string;
  benchmark?: string;
  name?: string;
  dryRun?: boolean;
}

const DEFAULT_CONFIG_NAMES = ['bench.config.ts', 'bench.config.js', 'bench.config.json', '.benchrc', '.benchrc.js', '.benchrc.json'];

function shiftConfigFlag(argv: string[]): { configPath?: string; argv: string[] } {
  const result: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      configPath = argv[++i];
      if (!configPath) throw new Error(USAGE);
      continue;
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      if (!configPath) throw new Error(USAGE);
      continue;
    }
    result.push(arg);
  }
  return { configPath, argv: result };
}

async function loadConfigFile(fullPath: string): Promise<BenchSdkConfig> {
  if (fullPath.endsWith('.json') || fullPath.endsWith('.benchrc')) {
    const raw = await readFile(fullPath, 'utf-8');
    return JSON.parse(raw) as BenchSdkConfig;
  }
  const mod = (await import(pathToFileURL(fullPath).href)) as { default?: BenchSdkConfig; config?: BenchSdkConfig };
  return (mod.default ?? mod.config ?? {}) as BenchSdkConfig;
}

function validateBenchSdkConfig(value: unknown, path?: string): string[] {
  const prefix = path ? `${path}: ` : '';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${prefix}config must be an object`];
  }
  const config = value as Record<string, unknown>;
  const issues: string[] = [];
  const checkString = (key: string) => {
    if (config[key] !== undefined && typeof config[key] !== 'string') issues.push(`${prefix}${key} must be a string`);
  };
  const checkPositiveInt = (key: string) => {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || (config[key] as number) < 1)) {
      issues.push(`${prefix}${key} must be a positive integer`);
    }
  };
  const checkNonNegativeInt = (key: string) => {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || (config[key] as number) < 0)) {
      issues.push(`${prefix}${key} must be a non-negative integer`);
    }
  };

  checkString('baseUrl');
  checkString('apiKeyEnv');
  if (config.providers !== undefined) {
    if (!Array.isArray(config.providers) || !config.providers.every((p) => typeof p === 'string')) {
      issues.push(`${prefix}providers must be an array of strings`);
    }
  }
  checkPositiveInt('iterations');
  checkPositiveInt('concurrency');
  checkNonNegativeInt('staggerDelayMs');
  if (config.groupBy !== undefined && config.groupBy !== 'participant' && config.groupBy !== 'round') {
    issues.push(`${prefix}groupBy must be 'participant' or 'round'`);
  }
  checkString('shape');
  checkString('runKey');
  checkString('benchmark');
  checkString('name');
  if (config.dryRun !== undefined && typeof config.dryRun !== 'boolean') {
    issues.push(`${prefix}dryRun must be a boolean`);
  }
  return issues;
}

async function resolveProjectConfig(argv: string[], cwd: string): Promise<{ config: BenchSdkConfig; configPath?: string; argv: string[] }> {
  const { configPath, argv: cleanArgv } = shiftConfigFlag(argv);
  if (configPath) {
    const full = resolve(cwd, configPath);
    const config = await loadConfigFile(full);
    const issues = validateBenchSdkConfig(config, full);
    if (issues.length > 0) throw new Error(`Invalid bench config:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    return { config, configPath: full, argv: cleanArgv };
  }
  for (const name of DEFAULT_CONFIG_NAMES) {
    const full = resolve(cwd, name);
    if (existsSync(full)) {
      const config = await loadConfigFile(full);
      const issues = validateBenchSdkConfig(config, full);
      if (issues.length > 0) throw new Error(`Invalid bench config:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
      return { config, configPath: full, argv: cleanArgv };
    }
  }
  return { config: {}, argv: cleanArgv };
}

function cliDefaultsFromConfig(config: BenchSdkConfig): Partial<CliArgs> {
  const defaults: Partial<CliArgs> = {};
  if (config.iterations !== undefined) defaults.iterations = config.iterations;
  if (config.concurrency !== undefined) defaults.concurrency = config.concurrency;
  if (config.staggerDelayMs !== undefined) defaults.staggerDelayMs = config.staggerDelayMs;
  if (config.groupBy !== undefined) defaults.groupBy = config.groupBy;
  if (config.shape !== undefined) defaults.shape = config.shape;
  if (config.runKey !== undefined) defaults.runKey = config.runKey;
  if (config.benchmark !== undefined) defaults.benchmark = config.benchmark;
  if (config.name !== undefined) defaults.name = config.name;
  if (config.providers !== undefined) defaults.providers = config.providers;
  if (config.dryRun !== undefined) defaults.noIngest = config.dryRun;
  return defaults;
}

function resolveApiKey(config: BenchSdkConfig): string | undefined {
  return config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
}

/**
 * Validates environment, API connectivity, participant availability, and scoring
 * weights for a `*.bench.ts` module without executing any tasks.
 */
export async function runCheck(argv: string[]): Promise<void> {
  const { config: projectConfig, argv: cleanArgv } = await resolveProjectConfig(argv, process.cwd());
  const [command, ...rest] = cleanArgv;
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

  const parsed = parseCliArgs(flags, [...(cfg.customCliFlags ?? []), '--base-url', '--api-key'], cliDefaultsFromConfig(projectConfig));
  const dryRun = parsed.noIngest ?? projectConfig.dryRun ?? false;

  let client: BenchmarkClient | undefined;
  let apiOk = dryRun;
  let auth: CliAuth | null = null;
  if (!dryRun) {
    try {
      auth = await resolveAuth({
        baseUrl: getFlag(flags, 'base-url') ?? projectConfig.baseUrl,
        apiKey: getFlag(flags, 'api-key') ?? resolveApiKey(projectConfig),
      });
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
  const { config: projectConfig, configPath, argv: cleanArgv } = await resolveProjectConfig(argv, process.cwd());
  const [command, ...rest] = cleanArgv;
  const [file, ...flags] = rest;
  if (command !== 'run' || !file || file.startsWith('-')) throw new Error(USAGE);

  const check = flags.includes('--check') || flags.includes('--validate');
  if (check) {
    const checkFlags = flags.filter((f) => f !== '--check' && f !== '--validate');
    return runCheck(['check', file, ...(configPath ? ['--config', configPath] : []), ...checkFlags]);
  }

  const { value: baseUrl, argv: flagsWithoutBaseUrl } = shiftFlag(flags, 'base-url');
  const { value: apiKey, argv: flagsWithoutApiKey } = shiftFlag(flagsWithoutBaseUrl, 'api-key');
  const runnerFlags = flagsWithoutApiKey.filter((f) => f !== '--check' && f !== '--validate' && !f.startsWith('--config'));

  const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)) as BenchmarkModule;
  const config = mod.config;
  const task = mod.task ?? mod.default;

  if (!isBenchmarkConfig(config)) {
    throw new Error(`${file} must export a \`config\` created with defineBenchmarkConfig (with participants).`);
  }
  if (typeof task !== 'function') {
    throw new Error(`${file} must export a \`task\` created with defineTask.`);
  }

  await runBenchmark(
    config as BenchmarkConfig<BaseParticipant>,
    task as BenchmarkTask<BaseParticipant>,
    runnerFlags,
    { baseUrl: baseUrl ?? projectConfig.baseUrl, apiKey: apiKey ?? resolveApiKey(projectConfig), cliArgs: cliDefaultsFromConfig(projectConfig) },
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
