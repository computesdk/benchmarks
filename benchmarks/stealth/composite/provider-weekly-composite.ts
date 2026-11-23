/**
 * benchmarks-platform v1 API client for the weekly composite meta-benchmark.
 *
 * Endpoints used (all authenticated with `Authorization: Bearer <key>`):
 *   GET /api/v1/benchmarks?limit=500&offset=N
 *       → { items: [{ slug, organizationSlug, category? }] }
 *   GET /api/v1/benchmarks/{slug}/results?since&until&timeZone=UTC&limit=100&offset=N
 *       → { items: [{ run: { id, status, createdAt, totalTasks, summary },
 *          participants: [{ taskCount }], analytics }] } — one paged read per
 *         benchmark covers the whole window, then runs are grouped by their
 *         createdAt day locally. This replaced a per-day run-list call plus a
 *         run-detail fetch per run: 36 workers × (140 lists + ~100s of run
 *         fetches) overloaded the API and tasks died on 30s timeouts/500s.
 *   GET /api/v1/benchmarks/~/{sourceOrg}/{slug}/results?...same params
 *       → the foreign-entitled variant used when the own-org route 404s.
 *   run.summary.results[] carries per-provider rows with `compositeScore`.
 *       The run-wide aggregate row is identified via summary.scoring's
 *       groupBy: it's the provider row that omits the groupBy dimension —
 *       run-config dimensions are stamped on every row, so empty-dimensions
 *       is NOT the test.
 */

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 30_000;
const LIST_PAGE_SIZE = 500;
/** Server-enforced max page size on the /results route. */
const RESULTS_PAGE_SIZE = 100;
/** Benchmarks fetched in parallel within one day step. */
const BENCH_CONCURRENCY = 8;

export const WINDOW_DAYS = 7;
/**
 * Days with data a provider needs before it appears in the matrix, so a new
 * provider can't top the leaderboard on one good day.
 */
export const MIN_DAYS_TO_RANK = 7;

/** The previous `n` complete UTC days, oldest first: [YYYY-MM-DD]. */
export function windowDays(n: number): string[] {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: n }, (_, i) => new Date(todayUtc - (n - i) * DAY_MS).toISOString().slice(0, 10));
}

export function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * The five equally weighted sandbox groups. Every categorized sandbox bench
 * must appear here: `sandboxGroup` throws on an unknown slug so a newly
 * categorized bench can't silently skew (or skip) the composite.
 */
export const SANDBOX_GROUPS = ['startup', 'compute', 'filesystem', 'state', 'reliability'] as const;
export type SandboxGroup = (typeof SANDBOX_GROUPS)[number];

export const SANDBOX_BENCH_GROUPS: Readonly<Record<string, SandboxGroup>> = {
  'sandbox-tti-daily': 'startup',
  'oci-tti-stealth': 'startup',
  'sandbox-burst-tti-1k': 'startup',
  'sandbox-cpu-stealth': 'compute',
  'sandbox-cpu-burst-stealth': 'compute',
  'sandbox-dax-daily': 'compute',
  'sandbox-ci-capabilities-stealth': 'compute',
  'sandbox-fs-api-stealth': 'filesystem',
  'sandbox-fs-io-stealth': 'filesystem',
  'sandbox-rootfs-stealth': 'filesystem',
  'sandbox-volumes-stealth': 'filesystem',
  'sandbox-tmp-filesystem-daily': 'filesystem',
  'sandbox-snapshot-stealth': 'state',
  'sandbox-snapshot-fanout-stealth': 'state',
  'filesystem-snapshot-stealth': 'state',
  'sandbox-fidelity-stealth': 'state',
  'sandbox-pause-resume-stealth': 'state',
  'sandbox-soak-stealth': 'reliability',
  'sandbox-burst-survival-stealth': 'reliability',
  'os-capabilities-stealth': 'reliability',
};

export function sandboxGroup(slug: string): SandboxGroup {
  const group = SANDBOX_BENCH_GROUPS[slug];
  if (!group) {
    throw new Error(
      `sandbox bench "${slug}" has no composite group — add it to SANDBOX_BENCH_GROUPS ` +
        `(${SANDBOX_GROUPS.join(' | ')}) in benchmarks/stealth/composite/provider-weekly-composite.ts`,
    );
  }
  return group;
}

/** One benchmark on one day, from one provider's point of view. */
export interface BenchDay {
  slug: string;
  /** Any provider produced a scored row that day — the bench ran. */
  ran: boolean;
  /** This provider's average compositeScore that day, or null when it has no scored row. */
  score: number | null;
}

export interface AggregateOptions {
  /**
   * Score 0 for a bench that ran but has no row for this provider (unsupported
   * or not a participant). A bench that didn't run that day is excluded for
   * everyone.
   */
  zeroFill: boolean;
  /** Equal-weight group a bench averages into; the daily score averages the groups. */
  groupOf: (slug: string) => string;
}

export interface BenchWeekScore {
  slug: string;
  /** Average across counted days the bench ran, zero-filled days included. */
  compositeScore: number;
  /** Days with a real score. */
  daysWithData: number;
  /** Days the bench ran with no row for this provider, scored 0. */
  daysZeroFilled: number;
  /** `zero-filled` = never scored this week, every counted day was a 0-fill. */
  state: 'data' | 'zero-filled';
  group: string;
}

export interface WeeklyAggregate {
  weeklyComposite: number | null;
  dailyComposites: number[];
  daysWithData: number;
  /** Per-group weekly score: average of the group's daily average across counted days. */
  groupScores: Record<string, number>;
  benchmarks: BenchWeekScore[];
}

/**
 * Per provider: bench day score → group average → day average of the groups
 * that have data → week average of counted days. A day counts only when the
 * provider has at least one real score that day (a provider with no rows at
 * all — not onboarded yet, or parked — doesn't get a zeroed day).
 */
export function aggregateWeek(days: BenchDay[][], options: AggregateOptions): WeeklyAggregate {
  const dailyComposites: number[] = [];
  const groupDaily = new Map<string, number[]>();
  const benchValues = new Map<string, { group: string; values: number[]; real: number; filled: number }>();

  for (const day of days) {
    if (!day.some((bench) => bench.score !== null)) continue;
    const groupValues = new Map<string, number[]>();
    for (const bench of day) {
      const group = options.groupOf(bench.slug);
      let value: number;
      if (bench.score !== null) {
        value = bench.score;
      } else if (bench.ran && options.zeroFill) {
        value = 0;
      } else {
        continue;
      }
      const entry = benchValues.get(bench.slug) ?? { group, values: [], real: 0, filled: 0 };
      entry.values.push(value);
      if (bench.score !== null) entry.real++;
      else entry.filled++;
      benchValues.set(bench.slug, entry);
      groupValues.set(group, [...(groupValues.get(group) ?? []), value]);
    }
    const groupAverages: number[] = [];
    for (const [group, values] of groupValues) {
      const avg = average(values);
      groupAverages.push(avg);
      groupDaily.set(group, [...(groupDaily.get(group) ?? []), avg]);
    }
    dailyComposites.push(average(groupAverages));
  }

  const groupScores: Record<string, number> = {};
  for (const [group, values] of [...groupDaily].sort(([a], [b]) => a.localeCompare(b))) {
    groupScores[group] = average(values);
  }

  return {
    weeklyComposite: dailyComposites.length ? average(dailyComposites) : null,
    dailyComposites,
    daysWithData: dailyComposites.length,
    groupScores,
    benchmarks: [...benchValues]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, entry]) => ({
        slug,
        compositeScore: average(entry.values),
        daysWithData: entry.real,
        daysZeroFilled: entry.filled,
        state: entry.real > 0 ? ('data' as const) : ('zero-filled' as const),
        group: entry.group,
      })),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

export interface ListedBenchmark {
  slug: string;
  organizationSlug: string;
  category: string | null;
  /** Display name when the list endpoint returns one. */
  name: string | null;
}

export interface ScoredRun {
  cut: boolean;
  scores: ReadonlyMap<string, number>;
  /** Providers whose aggregate row has no finite score; excluded, never 0-filled. */
  incomplete?: ReadonlySet<string>;
}

/**
 * Fold one bench-day's finished runs for `provider`. The bench "ran" (so a
 * missing row is 0-filled) only when a run that finished every task scored
 * someone; a run cut short can't say who was skipped, but its real scores count.
 * A provider with an incomplete row and no real score that day is excluded.
 */
export function resolveBenchDay(slug: string, runs: ScoredRun[], provider: string): BenchDay {
  const scores = runs.map((run) => run.scores.get(provider)).filter((score): score is number => score !== undefined);
  const incomplete = runs.some((run) => run.incomplete?.has(provider));
  return {
    slug,
    ran: scores.length > 0 || (!incomplete && runs.some((run) => !run.cut && run.scores.size > 0)),
    score: scores.length ? average(scores) : null,
  };
}

/** One row of `data.benchmarkScores` returned by the task: a benchmark's 7-day composite for this provider. */
export interface BenchmarkScoreCell {
  slug: string;
  /** Benchmark display name when the platform list endpoint returned one. */
  label?: string;
  compositeScore: number;
  /** Days in the window where this benchmark produced a score (for cell `detail`). */
  daysWithData: number;
  /** Days the bench ran without a row for this provider, scored 0 (absent on older runs). */
  daysZeroFilled?: number;
  /** `zero-filled`: never scored this week — unsupported/not a participant, counted as 0. */
  state?: 'data' | 'zero-filled';
  group?: string;
}

interface MatrixCell {
  value?: number;
  detail: string;
  state: 'data' | 'missing';
}

/** The `kind: 'matrix'` dataset artifact the platform's index layout renders. */
export interface MatrixDataset {
  version: 1;
  rows: { key: string; label: string }[];
  participants: { key: string; label: string }[];
  cells: Record<string, Record<string, MatrixCell>>;
  cards: Record<
    string,
    { headline?: { label: string; value: number | string }; facts: { label: string; value: string }[] }
  >;
}

/**
 * Assemble the matrix dataset from run participants. Only participants with
 * at least MIN_DAYS_TO_RANK days of data are columns; every benchmark a shown
 * participant scored in is a row, sorted by slug. Cells a participant has no
 * score for are `state: 'missing'` (rendered '—').
 */
export function buildMatrixDataset(
  allProviders: { name: string; data: Record<string, unknown> | undefined }[],
): MatrixDataset {
  const providers = allProviders.filter(
    (provider) => typeof provider.data?.daysWithData === 'number' && provider.data.daysWithData >= MIN_DAYS_TO_RANK,
  );
  const perProvider = providers.map((provider) => {
    const raw = provider.data?.benchmarkScores;
    const scores = (Array.isArray(raw) ? raw : []).filter((s): s is BenchmarkScoreCell => {
      const cell = s as BenchmarkScoreCell;
      return (
        typeof cell === 'object' &&
        cell !== null &&
        typeof cell.slug === 'string' &&
        typeof cell.compositeScore === 'number' &&
        typeof cell.daysWithData === 'number'
      );
    });
    return { provider, scores };
  });

  const labels = new Map<string, string>();
  for (const { scores } of perProvider) {
    for (const score of scores) {
      if (!labels.has(score.slug) || score.label) labels.set(score.slug, score.label ?? score.slug);
    }
  }
  const rowSlugs = [...labels.keys()].sort();

  const cells: MatrixDataset['cells'] = {};
  for (const slug of rowSlugs) {
    const row: Record<string, MatrixCell> = {};
    for (const { provider, scores } of perProvider) {
      const cell = scores.find((s) => s.slug === slug);
      const filled = cell?.daysZeroFilled ?? 0;
      row[provider.name] = !cell
        ? { detail: '0/7 days', state: 'missing' }
        : cell.state === 'zero-filled'
          ? // Rendered '—' so "unsupported" stays distinct from a measured 0; the composite counts it as 0.
            { detail: `not scored — counted as 0 on ${filled}/7 days`, state: 'missing' }
          : {
              value: cell.compositeScore,
              detail: filled ? `${cell.daysWithData}/7 days, ${filled} counted as 0` : `${cell.daysWithData}/7 days`,
              state: 'data',
            };
    }
    cells[slug] = row;
  }

  const cards: MatrixDataset['cards'] = {};
  for (const { provider } of perProvider) {
    const data = provider.data ?? {};
    const weeklyComposite = typeof data.weeklyComposite === 'number' ? data.weeklyComposite : null;
    const daysWithData = typeof data.daysWithData === 'number' ? data.daysWithData : 0;
    const benchmarksContributing =
      typeof data.benchmarksContributing === 'number' ? data.benchmarksContributing : 0;
    cards[provider.name] = {
      ...(weeklyComposite === null ? {} : { headline: { label: 'Weekly composite', value: weeklyComposite } }),
      facts: [
        { label: 'Days with data', value: `${daysWithData}/7` },
        { label: 'Benchmarks contributing', value: String(benchmarksContributing) },
        ...(typeof data.benchmarksZeroFilled === 'number' && data.benchmarksZeroFilled > 0
          ? [{ label: 'Benchmarks counted as 0', value: String(data.benchmarksZeroFilled) }]
          : []),
      ],
    };
  }

  return {
    version: 1,
    rows: rowSlugs.map((slug) => ({ key: slug, label: labels.get(slug) ?? slug })),
    participants: providers.map((provider) => ({ key: provider.name, label: provider.name })),
    cells,
    cards,
  };
}

/**
 * Renamed provider ids, old → new (mirrors PROVIDER_ID_ALIASES in
 * benchmarks-platform lib/providers/provider-aliases.ts). Run summaries keep
 * the id a row was reported under, so old rows are read as the new id.
 */
export const PROVIDER_ID_ALIASES: Readonly<Record<string, string>> = {
  tenki: 'luxor',
  givemeanode: 'sfcompute',
};

/** Raw statuses that mean a run is still in flight on either row shape. */
const IN_FLIGHT = new Set(['pending', 'queued', 'planned', 'running', 'in_progress', 'cancelling']);

/** One item of the `GET …/results` list: a run plus its per-participant stats. */
interface ResultsItem {
  run: {
    id: string;
    status?: unknown;
    createdAt?: unknown;
    totalTasks?: unknown;
    summary?: { results?: Record<string, unknown>[]; scoring?: unknown };
  };
  participants?: { taskCount?: unknown }[];
  analytics?: { status?: unknown };
}

export class PlatformApi {
  private readonly base: string;
  private readonly key: string;
  /** Per-benchmark read path: own day route vs foreign `~/` runs list. */
  private readonly foreignSlugs = new Set<string>();

  constructor() {
    this.base = (process.env.BENCHMARKS_PLATFORM_URL ?? 'https://platform.computesdk.com').replace(/\/+$/, '');
    const key = process.env.BENCHMARKS_PLATFORM_API_KEY;
    if (!key) throw new Error('BENCHMARKS_PLATFORM_API_KEY is required');
    this.key = key;
  }

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${this.base}${path}`, {
          headers: { Authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => null)) as unknown;
        // Retry transient server errors once; 4xx is authoritative.
        if (res.status >= 500 && attempt === 0) continue;
        return { status: res.status, body };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** All benchmarks visible to the org API key, paged via limit/offset. */
  async listBenchmarks(): Promise<ListedBenchmark[]> {
    const items: ListedBenchmark[] = [];
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const { status, body } = await this.get(`/api/v1/benchmarks?limit=${LIST_PAGE_SIZE}&offset=${offset}`);
      if (status !== 200) throw new Error(`GET /api/v1/benchmarks failed: HTTP ${status}`);
      const page = ((body as { items?: unknown[] }).items ?? []) as Record<string, unknown>[];
      for (const item of page) {
        items.push({
          slug: String(item.slug),
          organizationSlug: String(item.organizationSlug ?? ''),
          // `category` ships via a companion PR; a missing field reads as null.
          category: typeof item.category === 'string' ? item.category : null,
          name: typeof item.name === 'string' ? item.name : null,
        });
      }
      if (page.length < LIST_PAGE_SIZE) return items;
    }
  }

  /** Benchmarks in one category. `public` is a visibility flag, not a domain. */
  async categorizedBenchmarks(category: string): Promise<ListedBenchmark[]> {
    const items = await this.listBenchmarks();
    return items.filter(
      (item) =>
        item.category !== null &&
        item.category !== 'public' &&
        item.category === category &&
        // Never read our own runs: if a composite slug gets assigned a
        // category it would fold its own scores back into the average.
        !item.slug.startsWith('provider-weekly-composite'),
    );
  }

  /**
   * Every settled run of `bench` whose createdAt falls in the window `days`
   * (UTC, inclusive), grouped by day — one paged /results read instead of a
   * day-list call plus a run-detail fetch per run. Own benchmarks use the
   * plain route; foreign-entitled ones (it 404s — own-org only) fall back to
   * the `~/` variant.
   */
  async benchWeekRuns(bench: ListedBenchmark, days: string[]): Promise<Map<string, ScoredRun[]>> {
    const query = `since=${days[0]}&until=${days[days.length - 1]}&timeZone=UTC&limit=${RESULTS_PAGE_SIZE}`;
    let items: ResultsItem[];
    if (!this.foreignSlugs.has(bench.slug)) {
      try {
        items = await this.pagedResults(`/api/v1/benchmarks/${encodeURIComponent(bench.slug)}/results?${query}`);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
        this.foreignSlugs.add(bench.slug);
        items = [];
      }
    } else {
      items = [];
    }
    if (this.foreignSlugs.has(bench.slug)) {
      items = await this.pagedResults(
        `/api/v1/benchmarks/~/${encodeURIComponent(bench.organizationSlug)}/${encodeURIComponent(bench.slug)}/results?${query}`,
      );
    }

    const byDay = new Map<string, ScoredRun[]>();
    for (const item of items) {
      if (IN_FLIGHT.has(String(item.run.status ?? ''))) continue;
      const day = String(item.run.createdAt ?? '').slice(0, 10);
      if (!day) continue;
      const scoredRun: ScoredRun = { cut: runCut(item), ...scoresFromSummary(item.run.summary) };
      byDay.set(day, [...(byDay.get(day) ?? []), scoredRun]);
    }
    return byDay;
  }

  private async pagedResults(path: string): Promise<ResultsItem[]> {
    const items: ResultsItem[] = [];
    for (let offset = 0; ; offset += RESULTS_PAGE_SIZE) {
      const { status, body } = await this.get(`${path}&offset=${offset}`);
      if (status !== 200) throw new HttpError(status);
      const page = ((body as { items?: unknown[] }).items ?? []) as ResultsItem[];
      items.push(...page);
      if (page.length < RESULTS_PAGE_SIZE) return items;
    }
  }

  /**
   * Upload a run-level artifact: POST mints a presigned `uploadUrl`, then the
   * bytes go straight to storage with a PUT.
   */
  async uploadRunArtifact(
    benchmarkSlug: string,
    runId: string,
    input: { kind: string; name: string; contentType: string; metadata: Record<string, unknown> },
    body: string,
  ): Promise<void> {
    const res = await fetch(
      `${this.base}/api/v1/benchmarks/${encodeURIComponent(benchmarkSlug)}/runs/${encodeURIComponent(runId)}/artifacts`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new HttpError(res.status);
    const created = (await res.json().catch(() => null)) as { uploadUrl?: string } | null;
    if (!created?.uploadUrl) throw new Error('artifact create returned no uploadUrl');
    const put = await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!put.ok) throw new HttpError(put.status);
  }
}

/**
 * The "cut short" test for a /results item: the run ended before every planned
 * task finished (e.g. a cancelled CI job). `done < total` comes from summing
 * the participants' taskCounts; when they're absent, the analytics row's
 * status answers whether the run's results landed whole.
 */
function runCut(item: ResultsItem): boolean {
  if (Array.isArray(item.participants)) {
    const done = item.participants.reduce((sum, p) => sum + (typeof p?.taskCount === 'number' ? p.taskCount : 0), 0);
    return done < (typeof item.run.totalTasks === 'number' ? item.run.totalTasks : 0);
  }
  return item.analytics?.status !== 'complete';
}

/**
 * Every provider's run-wide compositeScore from a run summary. The aggregate
 * row is the provider row that omits the scoring groupBy dimension. Providers
 * whose aggregate row lacks a finite score are reported as incomplete.
 */
function scoresFromSummary(summary: ResultsItem['run']['summary']): {
  scores: Map<string, number>;
  incomplete: Set<string>;
} {
  const scores = new Map<string, number>();
  const incomplete = new Set<string>();
  // Platform rule (lib/benchmarks/stealth/org-benchmarks.ts): a grouped run emits one
  // row per groupBy dimension value plus a run-wide aggregate that omits it.
  // Run-config dimensions (tasks, file_sizes, iterations, …) are stamped on
  // EVERY row, so "empty dimensions" is not the aggregate test.
  const groupBy = scoringGroupBy(summary?.scoring);
  for (const row of summary?.results ?? []) {
    if (row.skipped === true) continue;
    if (groupBy && (row.dimensions as Record<string, unknown> | undefined)?.[groupBy] !== undefined) continue;
    const reported = String(row.provider);
    const provider = Object.hasOwn(PROVIDER_ID_ALIASES, reported) ? PROVIDER_ID_ALIASES[reported] : reported;
    if (typeof row.compositeScore !== 'number' || !Number.isFinite(row.compositeScore)) {
      incomplete.add(provider);
      continue;
    }
    if (!scores.has(provider)) scores.set(provider, row.compositeScore);
  }
  for (const provider of scores.keys()) incomplete.delete(provider);
  return { scores, incomplete };
}

/**
 * The groupBy dimension key from a stored scoring spec — tolerates both the
 * raw spec `{ metrics, groupBy }` and a config object nesting it under
 * `scoring` (mirrors parseBenchmarkScoringSpec in benchmarks-platform).
 */
function scoringGroupBy(scoring: unknown): string | null {
  if (!scoring || typeof scoring !== 'object') return null;
  let target = scoring as Record<string, unknown>;
  if (!Array.isArray(target.metrics) && target.scoring && typeof target.scoring === 'object') {
    target = target.scoring as Record<string, unknown>;
  }
  return typeof target.groupBy === 'string' && target.groupBy !== '' ? target.groupBy : null;
}

class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export { mapLimit };
