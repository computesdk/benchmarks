import type { ReliabilityCard, RunDayCursor, RunFeedAnalytics, RunFeedFilter, RunFeedItem } from '@benchsdk/api';
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
  const { done, errors, total } = run.progress ?? { done: 0, errors: 0, total: 0 };
  return {
    benchmark: run.benchmarkOwner === 'foreign' ? `~${run.benchmarkOwnerOrgSlug}/${run.benchmarkSlug}` : run.benchmarkSlug,
    run: run.runId,
    status: run.status,
    started: run.startedAt,
    duration: durationLabel(run),
    progress: run.statsPending ? '' : `${done}/${total}${errors ? ` (${errors} errors)` : ''}`,
    ...(run.isArchived ? { archived: true } : {}),
    ...(run.benchmarkMuted ? { muted: true } : {}),
  };
}

function analyticsNote(analytics: RunFeedAnalytics | undefined): void {
  if (analytics === 'unavailable') console.log('Run stats unavailable (analytics: unavailable); progress is a placeholder.');
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
  analyticsNote(feed.analytics);
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
  console.log(`Runs per day (${days.timeZone})`);
  for (const { day, count } of days.days) console.log(`${day}  ${count}`);
}

function cursorLabel(cursor: RunDayCursor): string {
  return `${cursor.createdAt},${cursor.id}`;
}

/** `--cursor <createdAt>,<id>`: a page's `nextCursor` as `bench runs day` prints it. */
function cursorOption(options: SubcommandOptions): RunDayCursor | undefined {
  const value = optionString(options, 'cursor');
  if (value === undefined) return undefined;
  const comma = value.lastIndexOf(',');
  const createdAt = value.slice(0, comma).trim();
  const id = value.slice(comma + 1).trim();
  if (comma < 0 || !createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw new Error('--cursor takes <createdAt>,<id> as printed by the previous page (nextCursor.createdAt and nextCursor.id)');
  }
  return { createdAt, id };
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
  const query = { ...feedFilter(options), timeZone: localTimeZone(options), cursor: cursorOption(options) };
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
  analyticsNote(page.analytics);
  if (page.nextCursor) {
    console.log(`More runs on ${day}: pass --all or --cursor ${cursorLabel(page.nextCursor)}`);
  }
}

function percent(value: number | null): string {
  return value === null ? '' : `${(value * 100).toFixed(2)}%`;
}

function cardRow({ benchmark, card }: ReliabilityCard): Record<string, unknown> {
  const down = card.participants.filter((participant) => participant.status?.state === 'down').length;
  return {
    benchmark: benchmark.owner === 'foreign' ? `~${benchmark.ownerOrgSlug}/${benchmark.slug}` : benchmark.slug,
    uptime: percent(card.uptime),
    checks: card.counted,
    failed: card.failed,
    down: `${down}/${card.participants.length}`,
    lastCheck: card.lastCheckAt ?? '',
    ...(card.paused ? { paused: true } : {}),
    ...(benchmark.muted ? { muted: true } : {}),
  };
}

/** `bench reliability cards`: the dashboard's reliability cards (`GET /benchmarks/reliability-cards`). */
export async function handleReliabilityCards(
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const includeMuted = optionFlag(options, 'include-muted') || undefined;
  const { api } = await createApiClient(overrides);
  const result = await api.getReliabilityCards({ includeMuted });
  if (isJsonOutput(output)) {
    printData(result, output);
    return;
  }
  if (result.cards.length === 0) console.log('No reliability benchmarks.');
  else console.table(result.cards.map(cardRow));
  if (result.mutedCount > 0 && !includeMuted) {
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
  console.log(`Runs per UTC day, last ${activity.days} days${activity.benchmarkSlug ? ` (${activity.benchmarkSlug})` : ''}`);
  for (const { date, runs } of activity.series) console.log(`${date}  ${runs}`);
}
