/**
 * Provider Weekly Composite — a meta-benchmark. It never provisions a sandbox.
 *
 * Each participant is a provider identity (e2b, vercel, modal, …). Its task
 * reads that provider's daily composite scores from the benchmarks-platform
 * v1 API across every benchmark in ONE category (env `BENCHMARK_CATEGORY`,
 * default `sandbox`) over the previous 7 complete UTC days, then averages:
 *
 *   1. per benchmark per day — average compositeScore across ALL of that
 *      benchmark's runs that day (retriggers get folded in, not picked),
 *   2. per group per day — sandbox benches fall into five equally weighted
 *      groups (SANDBOX_BENCH_GROUPS: startup, compute, filesystem, state,
 *      reliability); other categories weight every benchmark equally,
 *   3. per day — average the group scores that have data that day,
 *   4. per week — average the daily composites across days with data →
 *      `weeklyComposite`, the headline metric; `groupScores` rides alongside.
 *
 * Sandbox: unsupported = 0. A bench that ran that day (a run that finished
 * every task scored someone) counts 0 for a provider with no row; a bench that
 * didn't run, or only has runs cut short (done < total), is excluded for
 * providers without a row — their real scores still count. A day counts toward the week only if the provider has at
 * least one real score that day. Other categories keep skip-missing.
 * A provider outside the leg's category is env-gated out before the run so it
 * contributes no row at all (a `requireData.hasData` failure would still land
 * a score-0 row).
 *
 * Leaderboard: the matrix dataset only lists providers with data on all 7
 * days (MIN_DAYS_TO_RANK), so a new provider can't top it on one good day.
 *
 * Run once per category — each category gets its own platform run and
 * leaderboard via `BENCHMARK_SLUG=provider-weekly-composite-<category>`:
 *   pnpm bench benchmarks/stealth/composite/provider-weekly-composite.bench.ts \
 *     --provider e2b --iterations 1 --no-ingest
 *   BENCHMARK_CATEGORY=browser BENCHMARK_SLUG=provider-weekly-composite-browser ...
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { BenchmarkRunOutcome, JsonObject } from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import {
  PlatformApi,
  windowDays,
  WINDOW_DAYS,
  mapLimit,
  buildMatrixDataset,
  aggregateWeek,
  resolveBenchDay,
  sandboxGroup,
} from './provider-weekly-composite.js';
import type { BenchDay } from './provider-weekly-composite.js';
import { fullPrecisionScoring } from '../src/util/scoring.js';


const CATEGORY: string = process.env.BENCHMARK_CATEGORY ?? 'sandbox';
const CATEGORY_TITLE = CATEGORY.slice(0, 1).toUpperCase() + CATEGORY.slice(1);
// Computed once at load so every leg of the window uses the same day set.
const DAYS = windowDays(WINDOW_DAYS);

// `type: 'index'` + `index` declare the platform's matrix-layout index
// benchmark. The fields land in @benchsdk/runner after 0.6.3, so they're
// spread in rather than written literally — older runners ignore unknown
// top-level config keys and tsc rejects unknown literal keys.
const INDEX_DECLARATION = {
  type: 'index',
  index: {
    layout: 'matrix',
    spec: { cell: { unit: 'score', decimals: 2, direction: 'higher-better' }, highlight: 'best-in-row' },
  },
} as const;

export const config = defineBenchmarkConfig<ProviderConfig>({
  ...INDEX_DECLARATION,
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'provider-weekly-composite',
  benchmarkName: process.env.BENCHMARK_NAME ?? `Provider Weekly Composite - ${CATEGORY_TITLE}`,
  iterations: 1,
  concurrency: 1,
  groupBy: 'participant',
  // Env-gate providers outside this leg's category: filterParticipantsByEnv
  // drops them before the run, so they contribute no result row at all (a
  // skipped or failed task still lands a row — only unavailability doesn't).
  participants: providers.map((p) => ({
    ...p,
    requiredEnvVars:
      CATEGORY === 'all' || p.categories.includes(CATEGORY as (typeof p.categories)[number])
        ? []
        : ['BENCH_PROVIDER_IN_CATEGORY'],
  })),
  display: {
    metrics: [
      { key: 'weeklyComposite', label: 'Weekly composite', unit: 'score', direction: 'higher-better', decimals: 2, order: 0 },
      { key: 'daysWithData', label: 'Days with data', direction: 'higher-better', decimals: 0, order: 1 },
      { key: 'benchmarksContributing', label: 'Benchmarks contributing', direction: 'higher-better', decimals: 0, order: 2 },
    ],
    // Only the per-benchmark steps below are recorded: the By Step table
    // renders one column per step, so keeping the plumbing (list/fetch/
    // aggregate) unstepped leaves a clean benchmark -> composite score table.
    steps: [],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  scoring: fullPrecisionScoring({
    // Only weeklyComposite scores — the rest are display-only coverage stats.
    metrics: [
      {
        key: 'weeklyComposite',
        unit: 'score',
        ceiling: 100,
        higherIsBetter: true,
        weights: { median: 1, p95: 0, p99: 0 },
      },
    ],
    success: {
      // Zero days of data → no successful record, never a zeroed score.
      requireData: { hasData: true },
    },
  }),
  onComplete: uploadMatrixDataset,
});

/**
 * Build the index-layout matrix dataset from the run's participant records
 * and upload it as a run-level artifact. Additive to the standard summary —
 * an upload failure is logged, never thrown. `--no-ingest` runs have no run
 * to attach to, so the payload is printed instead.
 */
async function uploadMatrixDataset(outcome: BenchmarkRunOutcome): Promise<void> {
  const dataset = buildMatrixDataset(
    outcome.participants.map((p) => ({
      name: p.participant,
      data: p.records.find((record) => record.data)?.data,
    })),
  );
  const body = JSON.stringify(dataset);
  if (outcome.runId === 'no-ingest') {
    console.log(`[matrix] no-ingest run — dataset payload (not uploaded):\n${body}`);
    return;
  }
  try {
    await new PlatformApi().uploadRunArtifact(
      config.benchmarkSlug,
      outcome.runId,
      { kind: 'matrix', name: 'matrix', contentType: 'application/json', metadata: {} },
      body,
    );
    console.log(`[matrix] uploaded dataset artifact to run ${outcome.runId}`);
  } catch (error) {
    console.warn(`[matrix] artifact upload failed (standard summary already submitted): ${error}`);
  }
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const provider = ctx.participant.name;
  const api = new PlatformApi();

  const benchmarks = await api.categorizedBenchmarks(CATEGORY);
  ctx.log('categorized benchmarks', {
    level: 'info',
    meta: { provider, category: CATEGORY, count: benchmarks.length, slugs: benchmarks.map((b) => b.slug) },
  });

  const sandbox = CATEGORY === 'sandbox';
  // Fail loudly before any fetch: an ungrouped bench would silently reweight the composite.
  if (sandbox) for (const bench of benchmarks) sandboxGroup(bench.slug);

  // One paged /results read per benchmark covers the whole window — the old
  // day-list + per-run-detail fanout (×36 parallel workers) overloaded the API.
  const weekRuns = await mapLimit(benchmarks, 8, (bench) => api.benchWeekRuns(bench, DAYS));
  const days: BenchDay[][] = [];
  for (const day of DAYS) {
    days.push(
      benchmarks.map((bench, i) => {
        const benchDay = resolveBenchDay(bench.slug, weekRuns[i].get(day) ?? [], provider);
        ctx.log('benchmark day', {
          level: 'info',
          meta: { provider, day, benchmark: bench.slug, score: benchDay.score, ran: benchDay.ran },
        });
        return benchDay;
      }),
    );
  }

  const week = aggregateWeek(days, {
    zeroFill: sandbox,
    groupOf: sandbox ? sandboxGroup : (slug) => slug,
  });

  // One step per contributing benchmark: the run page's By Step table lists
  // each benchmark with the composite it averaged across the window. The same
  // rows go into `data.benchmarkScores` for the onComplete matrix dataset.
  const names = new Map(benchmarks.map((bench) => [bench.slug, bench.name]));
  const benchmarkScores: JsonObject[] = [];
  for (const bench of week.benchmarks) {
    const name = names.get(bench.slug);
    benchmarkScores.push({
      slug: bench.slug,
      ...(name ? { label: name } : {}),
      compositeScore: bench.compositeScore,
      daysWithData: bench.daysWithData,
      daysZeroFilled: bench.daysZeroFilled,
      state: bench.state,
      ...(sandbox ? { group: bench.group } : {}),
    });
    // Zero-filled benches score 0 in the composite but get no step, so the
    // By Step table shows them blank rather than as a measured 0.
    if (bench.state === 'zero-filled') continue;
    await ctx.step(bench.slug, async () => {
      ctx.measure({ compositeScore: bench.compositeScore });
      return bench.compositeScore;
    });
  }

  const aggregate = {
    weeklyComposite: week.weeklyComposite,
    daysWithData: week.daysWithData,
    benchmarksContributing: week.benchmarks.filter((bench) => bench.state === 'data').length,
    benchmarksZeroFilled: week.benchmarks.filter((bench) => bench.state === 'zero-filled').length,
  };

  const hasData = aggregate.weeklyComposite !== null;
  ctx.measure({
    weeklyComposite: aggregate.weeklyComposite ?? 0,
    daysWithData: aggregate.daysWithData,
    benchmarksContributing: aggregate.benchmarksContributing,
    hasData,
  });
  ctx.log('weekly composite', {
    level: 'info',
    meta: { provider, category: CATEGORY, ...aggregate, hasData },
  });

  return {
    data: {
      category: CATEGORY,
      windowStart: DAYS[0],
      windowEnd: DAYS[DAYS.length - 1],
      hasData,
      dailyComposites: week.dailyComposites,
      weeklyComposite: aggregate.weeklyComposite ?? 0,
      daysWithData: aggregate.daysWithData,
      benchmarksContributing: aggregate.benchmarksContributing,
      benchmarksZeroFilled: aggregate.benchmarksZeroFilled,
      ...(sandbox ? { groupScores: week.groupScores } : {}),
      benchmarkScores,
    },
  };
});
