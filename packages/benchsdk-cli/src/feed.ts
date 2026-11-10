import type { RunDayCursor, RunFeedFilter, RunFeedItem } from '@benchsdk/api';
import { createApiClient } from './client.js';
import { isJsonOutput, optionFlag, optionList, optionNumber, optionString, type SubcommandOptions } from './options.js';
import { printData, type OutputOptions } from './output.js';

type Overrides = { baseUrl?: string; apiKey?: string; org?: string };

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March; a round trip catches it.
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function feedFilter(options: SubcommandOptions): RunFeedFilter {
  return {
    benchmarkSlugs: optionList(options, 'benchmark'),
    includeArchived: optionFlag(options, 'include-archived') || undefined,
    includeMuted: optionFlag(options, 'include-muted') || undefined,
  };
}

function localTimeZone(options: SubcommandOptions): string {
  return optionString(options, 'tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

function integerOption(options: SubcommandOptions, key: string, min: number, max: number): number | undefined {
  const value = optionNumber(options, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${key} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/**
 * A platform that predates `benchmarkSlugs` ignores it and answers with every
 * benchmark; printing that under a filtered-looking command would mislead.
 */
export function assertBenchmarkSlugsHonored(
  runs: readonly { benchmarkSlug?: string }[],
  requested: readonly string[] | undefined,
): void {
  if (!requested?.length) return;
  // `~source/slug` names a foreign benchmark; rows carry the bare slug.
  const wanted = new Set(requested.flatMap((slug) => [slug, slug.replace(/^~[^/]+\//, '')]));
  const stray = runs.find((run) => run.benchmarkSlug !== undefined && !wanted.has(run.benchmarkSlug));
  if (stray) {
    throw new Error(
      `--benchmark was not applied: the platform returned runs of ${stray.benchmarkSlug} — this platform does not support the benchmarkSlugs filter yet`,
    );
  }
}

function durationLabel(run: RunFeedItem): string {
  if (!run.startedAt || !run.completedAt) return '';
  const ms = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

function feedRow(run: RunFeedItem): Record<string, unknown> {
  return {
    benchmark: run.benchmarkSlug,
    run: run.runId,
    status: run.status,
    started: run.startedAt ?? run.createdAt ?? '',
    duration: durationLabel(run),
    ...(run.archivedAt ? { archived: run.archivedAt } : {}),
    ...(run.muted ? { muted: true } : {}),
  };
}

function printRuns(runs: readonly RunFeedItem[]): void {
  if (runs.length === 0) {
    console.log('No runs.');
    return;
  }
  console.table(runs.map(feedRow));
}

/** `bench runs feed`: the org's newest runs across benchmarks (`GET /benchmarks/runs/summary`). */
export async function handleRunsFeed(options: SubcommandOptions, overrides: Overrides, output: OutputOptions): Promise<void> {
  const filter = feedFilter(options);
  const limit = integerOption(options, 'limit', 1, 100);
  const { api } = await createApiClient(overrides);
  const feed = await api.getRunFeed({ ...filter, limit });
  assertBenchmarkSlugsHonored(feed.runs, filter.benchmarkSlugs);
  if (isJsonOutput(output)) {
    printData(feed, output);
    return;
  }
  printRuns(feed.runs);
  if (feed.analytics !== 'ok') console.log(`Run stats unavailable (analytics: ${feed.analytics}).`);
}

/** `bench runs days`: run counts per local day (`GET /benchmarks/runs/days`). */
export async function handleRunDays(options: SubcommandOptions, overrides: Overrides, output: OutputOptions): Promise<void> {
  const filter = feedFilter(options);
  const timeZone = localTimeZone(options);
  const { api } = await createApiClient(overrides);
  const days = await api.listRunDays({ ...filter, timeZone });
  if (isJsonOutput(output)) {
    printData(days, output);
    return;
  }
  if (days.days.length === 0) {
    console.log('No runs.');
    return;
  }
  console.log(`Runs per day (${days.timeZone ?? timeZone})`);
  for (const { day, count } of days.days) console.log(`${day}  ${count}`);
}

function cursorLabel(cursor: RunDayCursor): string {
  return typeof cursor === 'string' ? cursor : `${cursor.createdAt},${cursor.id}`;
}

/**
 * `bench runs day <YYYY-MM-DD>`: one page of a day's runs, or every page with
 * `--all` (printed as one array of runs).
 */
export async function handleRunsDay(
  day: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  if (!day) throw new Error('Day required: bench runs day <YYYY-MM-DD>');
  if (!isCalendarDay(day)) {
    throw new Error(`Day must be a calendar date in YYYY-MM-DD form, got ${day}`);
  }
  const query = { ...feedFilter(options), timeZone: localTimeZone(options), cursor: optionString(options, 'cursor') };
  const { api } = await createApiClient(overrides);

  if (optionFlag(options, 'all')) {
    const runs: RunFeedItem[] = [];
    for await (const page of api.listAllRunsForDay(day, query)) {
      assertBenchmarkSlugsHonored(page.runs, query.benchmarkSlugs);
      runs.push(...page.runs);
    }
    if (isJsonOutput(output)) printData(runs, output);
    else printRuns(runs);
    return;
  }

  const page = await api.listRunsForDay(day, query);
  assertBenchmarkSlugsHonored(page.runs, query.benchmarkSlugs);
  if (isJsonOutput(output)) {
    printData(page, output);
    return;
  }
  printRuns(page.runs);
  if (page.nextCursor !== null && page.nextCursor !== undefined) {
    const next = typeof page.nextCursor === 'string' ? ` or --cursor ${cursorLabel(page.nextCursor)}` : '';
    console.log(`More runs on ${day}: pass --all${next}`);
  }
}

/** `bench reliability cards`: the dashboard's reliability cards (`GET /benchmarks/reliability-cards`). */
export async function handleReliabilityCards(
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const result = await api.getReliabilityCards({ includeMuted: optionFlag(options, 'include-muted') || undefined });
  if (isJsonOutput(output)) {
    printData(result, output);
    return;
  }
  printData(result.cards, output);
  if (result.mutedCount > 0) {
    console.log(`${result.mutedCount} muted reliability benchmark${result.mutedCount === 1 ? '' : 's'} hidden (--include-muted shows them)`);
  }
}

/** `bench activity`: run counts per day for the org (`GET /benchmarks/activity`). */
export async function handleActivity(options: SubcommandOptions, overrides: Overrides, output: OutputOptions): Promise<void> {
  const days = integerOption(options, 'days', 1, 90);
  const benchmarks = optionList(options, 'benchmark');
  if (benchmarks && benchmarks.length > 1) {
    throw new Error('bench activity takes one --benchmark slug');
  }
  const { api } = await createApiClient(overrides);
  const activity = await api.getActivity({ days, benchmarkSlug: benchmarks?.[0] });
  if (isJsonOutput(output)) {
    printData(activity, output);
    return;
  }
  printData(activity.series ?? activity, output);
}
