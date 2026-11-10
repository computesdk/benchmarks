import { readFile } from 'node:fs/promises';
import type { BenchmarkListStatus, RunArchivedFilter, UpdateBenchmarkInput } from '@benchsdk/api';
import { createApiClient } from './client.js';
import { confirmWrite } from './confirm.js';
import { rethrowWithHint, type ApiErrorEnvelope } from './errors.js';
import {
  isJsonOutput,
  optionChoice,
  optionFlag,
  optionNumber,
  optionString,
  type SubcommandOptions,
} from './options.js';
import { printData, type OutputOptions } from './output.js';

type Overrides = { baseUrl?: string; apiKey?: string; org?: string };

export const BENCHMARK_LIST_STATUSES: readonly BenchmarkListStatus[] = ['active', 'archived', 'all'];
export const RUN_ARCHIVED_FILTERS: readonly RunArchivedFilter[] = ['exclude', 'include', 'only'];
const MAX_ARCHIVE_RUN_IDS = 100;

// Benchmark and run management writes are admin-only on the platform; a
// member login gets a bare 403, so say what would work instead.
function adminHint(status: number, envelope: ApiErrorEnvelope | null): string | undefined {
  if (status !== 403) return undefined;
  const text = `${envelope?.error ?? ''} ${envelope?.message ?? ''}`;
  if (text.includes('insufficient_scope') || !/owner|admin/i.test(text)) return undefined;
  return 'Changing benchmarks and archiving runs needs an organization owner or admin: sign in as one (`bench auth login`) or use an org API key (--api-key or BENCHMARKS_PLATFORM_API_KEY).';
}

async function adminWrite<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    rethrowWithHint(err, adminHint);
  }
}

function requireSlug(slug: string | undefined, usage: string): string {
  if (!slug) throw new Error(`Benchmark slug required: ${usage}`);
  return slug;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export async function handleBenchmarksList(
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const status = optionChoice(options, 'status', BENCHMARK_LIST_STATUSES);
  const { api } = await createApiClient(overrides);
  const benchmarks = await api.listBenchmarks({
    limit: optionNumber(options, 'limit'),
    offset: optionNumber(options, 'offset'),
    status,
  });
  printData(benchmarks, output);
}

/** `bench benchmarks archive|restore <slug>`. Archiving needs confirmation; restoring does not. */
export async function handleBenchmarkArchive(
  slugArg: string | undefined,
  archived: boolean,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const slug = requireSlug(slugArg, `bench benchmarks ${archived ? 'archive' : 'restore'} <benchmark-slug>`);
  if (archived) {
    await confirmWrite({ yes: optionFlag(options, 'yes'), action: `archive benchmark ${slug} and all of its runs` });
  }
  const { api } = await createApiClient(overrides);
  const { benchmark, archivedRunCount } = await adminWrite(() => api.setBenchmarkArchived(slug, archived));
  if (isJsonOutput(output)) {
    printData({ ...benchmark, ...(archivedRunCount !== undefined ? { archivedRunCount } : {}) }, output);
    return;
  }
  const runs = archivedRunCount !== undefined ? ` (${plural(archivedRunCount, 'run')})` : '';
  console.log(`${archived ? 'Archived' : 'Restored'} benchmark ${slug}${runs}`);
}

/** `bench benchmarks describe <slug>`: tagline and description. */
export async function handleBenchmarkDescribe(
  slugArg: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const slug = requireSlug(slugArg, 'bench benchmarks describe <benchmark-slug> --tagline <text> --description <text>');
  const tagline = optionString(options, 'tagline');
  const clearTagline = optionFlag(options, 'clear-tagline');
  const description = optionString(options, 'description');
  const descriptionFile = optionString(options, 'description-file');
  const clearDescription = optionFlag(options, 'clear-description');

  if (tagline !== undefined && clearTagline) {
    throw new Error('--tagline and --clear-tagline cannot be combined');
  }
  if ([description !== undefined, descriptionFile !== undefined, clearDescription].filter(Boolean).length > 1) {
    throw new Error('Use only one of --description, --description-file and --clear-description');
  }

  const input: UpdateBenchmarkInput = {};
  if (tagline !== undefined) input.tagline = tagline;
  if (clearTagline) input.tagline = null;
  if (description !== undefined) input.description = description;
  if (descriptionFile !== undefined) input.description = await readFile(descriptionFile, 'utf8');
  if (clearDescription) input.description = null;
  if (Object.keys(input).length === 0) {
    throw new Error(
      'Nothing to change: pass --tagline, --description, --description-file, --clear-tagline or --clear-description',
    );
  }

  const { api } = await createApiClient(overrides);
  const benchmark = await adminWrite(() => api.updateBenchmark(slug, input));
  if (isJsonOutput(output)) {
    printData(benchmark, output);
    return;
  }
  const changed = [
    'tagline' in input ? (input.tagline === null ? 'tagline cleared' : 'tagline set') : null,
    'description' in input ? (input.description === null ? 'description cleared' : 'description set') : null,
  ].filter(Boolean);
  console.log(`Updated benchmark ${slug}: ${changed.join(', ')}`);
}

/** `bench benchmarks mute|unmute <slug>`: the org mute that hides a benchmark from shared feeds. */
export async function handleBenchmarkMute(
  slugArg: string | undefined,
  muted: boolean,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const slug = requireSlug(slugArg, `bench benchmarks ${muted ? 'mute' : 'unmute'} <benchmark-slug>`);
  const { api } = await createApiClient(overrides);
  const benchmark = await adminWrite(() => api.updateBenchmark(slug, { muted }));
  if (isJsonOutput(output)) {
    printData(benchmark, output);
    return;
  }
  console.log(`${muted ? 'Muted' : 'Unmuted'} benchmark ${slug}`);
}

function isoOption(options: SubcommandOptions, key: string): string | undefined {
  const value = optionString(options, key);
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`--${key} must be an ISO timestamp, e.g. 2026-11-06T00:00:00Z`);
  return value;
}

/** `bench benchmarks pause|resume <slug>` (reliability benchmarks only). */
export async function handleBenchmarkPause(
  slugArg: string | undefined,
  paused: boolean,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const slug = requireSlug(slugArg, `bench benchmarks ${paused ? 'pause' : 'resume'} <benchmark-slug>`);
  const start = isoOption(options, 'start');
  const end = isoOption(options, 'end');
  const { api } = await createApiClient(overrides);
  const state = await adminWrite(() =>
    paused ? api.pauseBenchmark(slug, { start, end }) : api.resumeBenchmark(slug),
  );
  if (isJsonOutput(output)) {
    printData(state, output);
    return;
  }
  if (!paused) {
    console.log(`Resumed benchmark ${slug}`);
    return;
  }
  const window = state.pauses[state.pauses.length - 1];
  const span = window ? ` from ${window.start}${window.end ? ` until ${window.end}` : ' until resumed'}` : '';
  console.log(`Paused benchmark ${slug}${span}`);
}

/** `bench runs archive|unarchive <runId...>`: both need confirmation. */
export async function handleRunsArchive(
  runIds: string[],
  archived: boolean,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const verb = archived ? 'archive' : 'unarchive';
  if (runIds.length === 0) throw new Error(`Run ids required: bench runs ${verb} <runId...>`);
  if (runIds.length > MAX_ARCHIVE_RUN_IDS) {
    throw new Error(`bench runs ${verb} takes at most ${MAX_ARCHIVE_RUN_IDS} run ids at a time`);
  }
  await confirmWrite({ yes: optionFlag(options, 'yes'), action: `${verb} ${plural(runIds.length, 'run')}` });
  const { api } = await createApiClient(overrides);
  const result = await adminWrite(() => api.archiveRuns(runIds, archived));
  if (isJsonOutput(output)) {
    printData(result, output);
    return;
  }
  console.log(`${archived ? 'Archived' : 'Unarchived'} ${plural(result.count, 'run')}`);
}
