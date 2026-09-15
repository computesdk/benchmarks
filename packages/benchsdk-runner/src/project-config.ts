/**
 * Project-level defaults for the `bench` CLI, read from `bench.config.ts` in
 * the working directory (or the path given by `--config`). CLI flags always
 * win over config-file values.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CliArgs } from './runner.js';
import { BenchmarkConfigError, type BenchmarkConfigErrorItem } from './bench-config.js';

export const BENCH_CONFIG_FILENAME = 'bench.config.ts';

export interface BenchSdkConfig {
  baseUrl?: string;
  /** Environment variable name to read the API key from; config files never hold secrets. */
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

/** Identity helper so `bench.config.ts` gets autocomplete: `export default defineBenchConfig({...})`. */
export function defineBenchConfig(config: BenchSdkConfig): BenchSdkConfig {
  return config;
}

export function validateBenchSdkConfig(value: unknown): BenchmarkConfigErrorItem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: 'config', message: 'must be an object' }];
  }
  const config = value as Record<string, unknown>;
  const issues: BenchmarkConfigErrorItem[] = [];
  const check = (field: string, ok: (v: unknown) => boolean, message: string) => {
    if (config[field] !== undefined && !ok(config[field])) issues.push({ field, message });
  };
  const isString = (v: unknown) => typeof v === 'string';
  const isPositiveInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;
  const isNonNegativeInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

  check('baseUrl', isString, 'must be a string');
  check('apiKeyEnv', isString, 'must be a string');
  check('providers', (v) => Array.isArray(v) && v.every(isString), 'must be an array of strings');
  check('iterations', isPositiveInt, 'must be a positive integer');
  check('concurrency', isPositiveInt, 'must be a positive integer');
  check('staggerDelayMs', isNonNegativeInt, 'must be a non-negative integer');
  check('groupBy', (v) => v === 'participant' || v === 'round', "must be 'participant' or 'round'");
  check('shape', isString, 'must be a string');
  check('runKey', isString, 'must be a string');
  check('benchmark', isString, 'must be a string');
  check('name', isString, 'must be a string');
  check('dryRun', (v) => typeof v === 'boolean', 'must be a boolean');
  return issues;
}

async function loadConfigFile(fullPath: string): Promise<BenchSdkConfig> {
  const mod = (await import(pathToFileURL(fullPath).href)) as { default?: unknown; config?: unknown };
  const config = mod.default ?? mod.config ?? {};
  const issues = validateBenchSdkConfig(config);
  if (issues.length > 0) {
    throw new BenchmarkConfigError(issues.map((i) => ({ ...i, field: `${fullPath}: ${i.field}` })));
  }
  return config as BenchSdkConfig;
}

export interface ResolvedProjectConfig {
  config: BenchSdkConfig;
  configPath?: string;
}

/**
 * Loads the explicit `configPath` if given, otherwise `bench.config.ts` from
 * `cwd` when present, otherwise an empty config.
 */
export async function resolveProjectConfig(cwd: string, configPath?: string): Promise<ResolvedProjectConfig> {
  const full = resolve(cwd, configPath ?? BENCH_CONFIG_FILENAME);
  if (!configPath && !existsSync(full)) return { config: {} };
  return { config: await loadConfigFile(full), configPath: full };
}

export function cliDefaultsFromConfig(config: BenchSdkConfig): Partial<CliArgs> {
  const { baseUrl: _baseUrl, apiKeyEnv: _apiKeyEnv, dryRun, ...knobs } = config;
  const defaults: Partial<CliArgs> = { ...knobs };
  if (dryRun !== undefined) defaults.noIngest = dryRun;
  return defaults;
}

export function resolveApiKey(config: BenchSdkConfig): string | undefined {
  return config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
}
