import assert from 'node:assert/strict';
import {
  SANDBOX_BENCH_GROUPS,
  SANDBOX_GROUPS,
  aggregateWeek,
  resolveBenchDay,
  buildMatrixDataset,
  sandboxGroup,
  PlatformApi,
} from './provider-weekly-composite.js';
import type { BenchDay } from './provider-weekly-composite.js';

const sandbox = { zeroFill: true, groupOf: sandboxGroup };
const day = (...benches: [string, number | null, boolean?][]): BenchDay[] =>
  benches.map(([slug, score, ran]) => ({ slug, score, ran: ran ?? score !== null }));
const close = (actual: number | null, expected: number, msg?: string) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${msg ?? ''} expected ${expected}, got ${actual}`);

// Every mapped bench resolves to one of the five groups, and every group is used.
for (const [slug, group] of Object.entries(SANDBOX_BENCH_GROUPS)) {
  assert.equal(sandboxGroup(slug), group);
  assert.ok((SANDBOX_GROUPS as readonly string[]).includes(group), `${slug} → unknown group ${group}`);
}
assert.deepEqual(new Set(Object.values(SANDBOX_BENCH_GROUPS)), new Set(SANDBOX_GROUPS));

// Every sandbox bench categorized on the platform as of 2026-11-06.
for (const slug of [
  'sandbox-tti-daily', 'oci-tti-stealth', 'sandbox-cpu-stealth', 'sandbox-cpu-burst-stealth', 'sandbox-dax-daily',
  'sandbox-fs-api-stealth', 'sandbox-fs-io-stealth', 'sandbox-rootfs-stealth', 'sandbox-volumes-stealth',
  'sandbox-tmp-filesystem-daily', 'sandbox-ci-capabilities-stealth',
  'sandbox-snapshot-stealth', 'sandbox-snapshot-fanout-stealth', 'filesystem-snapshot-stealth',
  'sandbox-fidelity-stealth', 'sandbox-pause-resume-stealth', 'sandbox-soak-stealth',
  'sandbox-burst-survival-stealth', 'os-capabilities-stealth',
]) {
  assert.doesNotThrow(() => sandboxGroup(slug), slug);
}

assert.equal(sandboxGroup('sandbox-ci-capabilities-stealth'), 'compute');

// An unknown slug fails loudly, naming the slug — in the mapper and in the aggregate.
assert.throws(() => sandboxGroup('sandbox-new-thing'), /sandbox-new-thing.*SANDBOX_BENCH_GROUPS/);
assert.throws(() => aggregateWeek([day(['sandbox-new-thing', 50])], sandbox), /sandbox-new-thing/);

// 0-fill: a bench that ran without a row for this provider counts 0 within its group.
{
  const week = aggregateWeek([day(['sandbox-tti-daily', 80], ['oci-tti-stealth', null, true])], sandbox);
  close(week.weeklyComposite, 40, '0-filled oci-tti halves startup');
  close(week.groupScores.startup, 40);
  const oci = week.benchmarks.find((b) => b.slug === 'oci-tti-stealth')!;
  assert.deepEqual(
    { score: oci.compositeScore, real: oci.daysWithData, filled: oci.daysZeroFilled, state: oci.state },
    { score: 0, real: 0, filled: 1, state: 'zero-filled' },
  );
}

// A real 0 stays `data`, distinct from a 0-fill.
{
  const week = aggregateWeek([day(['sandbox-tti-daily', 0], ['oci-tti-stealth', 60])], sandbox);
  assert.equal(week.benchmarks.find((b) => b.slug === 'sandbox-tti-daily')!.state, 'data');
}

// Bench-not-run exclusion: a bench nobody scored that day is skipped for everyone.
{
  const week = aggregateWeek([day(['sandbox-tti-daily', 80], ['oci-tti-stealth', null, false])], sandbox);
  close(week.weeklyComposite, 80);
  assert.equal(week.benchmarks.find((b) => b.slug === 'oci-tti-stealth'), undefined);
}

// Group weighting: groups weigh equally regardless of bench count; groups with no data that day are skipped.
{
  const week = aggregateWeek(
    [
      day(
        ['sandbox-snapshot-stealth', 100],
        ['sandbox-fidelity-stealth', 100],
        ['sandbox-pause-resume-stealth', 100],
        ['filesystem-snapshot-stealth', 100],
        ['sandbox-tti-daily', 0],
        ['sandbox-soak-stealth', null, false],
      ),
    ],
    sandbox,
  );
  close(week.weeklyComposite, 50, 'state 100 and startup 0 average to 50, not 80');
  assert.deepEqual(Object.keys(week.groupScores).sort(), ['startup', 'state']);
}

// Week = average of counted days; per-group week = average of that group's daily scores.
{
  const week = aggregateWeek(
    [
      day(['sandbox-tti-daily', 90], ['sandbox-cpu-stealth', 30]),
      day(['sandbox-tti-daily', 70], ['sandbox-cpu-stealth', null, false]),
    ],
    sandbox,
  );
  assert.deepEqual(week.dailyComposites, [60, 70]);
  close(week.weeklyComposite, 65);
  close(week.groupScores.startup, 80);
  close(week.groupScores.compute, 30);
}

// A day where the provider has no real score anywhere doesn't count (no zeroed day); no data at all → null.
{
  const week = aggregateWeek(
    [day(['sandbox-tti-daily', 90]), day(['sandbox-tti-daily', null, true], ['sandbox-cpu-stealth', null, true])],
    sandbox,
  );
  assert.equal(week.daysWithData, 1);
  close(week.weeklyComposite, 90);
  const none = aggregateWeek([day(['sandbox-tti-daily', null, true])], sandbox);
  assert.equal(none.weeklyComposite, null);
  assert.equal(none.daysWithData, 0);
}

// In-flight rule: a run cut short (done < total) doesn't 0-fill anyone; its real scores still count.
{
  const cut = { cut: true, scores: new Map([['vercel', 70]]) };
  const full = { cut: false, scores: new Map([['vercel', 50]]) };
  assert.deepEqual(resolveBenchDay('sandbox-cpu-stealth', [cut], 'e2b'), { slug: 'sandbox-cpu-stealth', ran: false, score: null });
  assert.deepEqual(resolveBenchDay('sandbox-cpu-stealth', [cut], 'vercel'), { slug: 'sandbox-cpu-stealth', ran: true, score: 70 });
  assert.deepEqual(resolveBenchDay('sandbox-cpu-stealth', [cut, full], 'e2b'), { slug: 'sandbox-cpu-stealth', ran: true, score: null });
  assert.deepEqual(resolveBenchDay('sandbox-cpu-stealth', [cut, full], 'vercel'), { slug: 'sandbox-cpu-stealth', ran: true, score: 60 });
  const empty = { cut: false, scores: new Map<string, number>() };
  assert.equal(resolveBenchDay('sandbox-cpu-stealth', [empty], 'e2b').ran, false);
  const week = aggregateWeek(
    [[{ slug: 'sandbox-tti-daily', ran: true, score: 80 }, resolveBenchDay('sandbox-cpu-stealth', [cut], 'e2b')]],
    sandbox,
  );
  close(week.weeklyComposite, 80, 'cut run excluded, not 0-filled');
}

// Non-sandbox categories keep the flat skip-missing average.
{
  const flat = aggregateWeek([day(['a', 90], ['b', 30], ['c', null, true])], { zeroFill: false, groupOf: (s) => s });
  close(flat.weeklyComposite, 60);
}

// Matrix: zero-filled cells render as missing ('—') with a detail; partial fills keep the score.
{
  const dataset = buildMatrixDataset([
    {
      name: 'e2b',
      data: {
        weeklyComposite: 40,
        daysWithData: 7,
        benchmarksContributing: 1,
        benchmarksZeroFilled: 1,
        benchmarkScores: [
          { slug: 'oci-tti-stealth', compositeScore: 0, daysWithData: 0, daysZeroFilled: 7, state: 'zero-filled' },
          { slug: 'sandbox-tti-daily', compositeScore: 60, daysWithData: 5, daysZeroFilled: 2, state: 'data' },
        ],
      },
    },
  ]);
  assert.equal(dataset.cells['oci-tti-stealth'].e2b.state, 'missing');
  assert.ok(!('value' in dataset.cells['oci-tti-stealth'].e2b));
  assert.match(dataset.cells['oci-tti-stealth'].e2b.detail, /counted as 0/);
  assert.deepEqual(dataset.cells['sandbox-tti-daily'].e2b, { value: 60, detail: '5/7 days, 2 counted as 0', state: 'data' });
  assert.ok(dataset.cards.e2b.facts.some((f) => f.label === 'Benchmarks counted as 0' && f.value === '1'));
}

// Matrix: a provider with fewer than 7 days of data is left out entirely.
{
  const scores = [{ slug: 'sandbox-tti-daily', compositeScore: 90, daysWithData: 2, state: 'data' }];
  const dataset = buildMatrixDataset([
    { name: 'new', data: { weeklyComposite: 90, daysWithData: 6, benchmarkScores: scores } },
    { name: 'old', data: { weeklyComposite: 50, daysWithData: 7, benchmarkScores: [{ ...scores[0], compositeScore: 50 }] } },
    { name: 'empty', data: undefined },
  ]);
  assert.deepEqual(dataset.participants.map((p) => p.key), ['old']);
  assert.deepEqual(Object.keys(dataset.cards), ['old']);
  assert.deepEqual(Object.keys(dataset.cells['sandbox-tti-daily']), ['old']);
}

// Exercise the real weekly reader without network access or platform writes.
{
  const fetchBefore = globalThis.fetch;
  const keyBefore = process.env.BENCHMARKS_PLATFORM_API_KEY;
  process.env.BENCHMARKS_PLATFORM_API_KEY = 'offline-fixture';
  try {
    const api = new PlatformApi();
    const bench = { slug: 'oci-tti-stealth', organizationSlug: 'computesdk', category: 'sandbox', name: null };
    const DAY = '2026-11-16';
    const item = (summary: unknown, overrides: Record<string, unknown> = {}) => ({
      run: { id: 'offline-run', status: 'completed', createdAt: `${DAY}T09:00:00Z`, totalTasks: 2, summary },
      participants: [{ taskCount: 2 }],
      analytics: { status: 'complete' },
      ...overrides,
    });
    const fixture = async (...items: unknown[]) => {
      globalThis.fetch = async () => new Response(JSON.stringify({ items }), { status: 200 });
      return api.benchWeekRuns(bench, [DAY]);
    };
    const dayRuns = async (...items: unknown[]) => (await fixture(...items)).get(DAY) ?? [];
    assert.equal((await dayRuns(item({ results: [{ provider: 'fixture', compositeScore: 0 }] })))[0].scores.get('fixture'), 0);
    const renamed = (await dayRuns(item({ results: [{ provider: 'tenki', compositeScore: 61 }] })))[0];
    assert.deepEqual([...renamed.scores], [['luxor', 61]], 'old provider id read as the new id');
    const skipped = (await dayRuns(item({ results: [{ provider: 'fixture', compositeScore: null, skipped: true }] })))[0];
    assert.equal(skipped.scores.size + (skipped.incomplete?.size ?? 0), 0);
    const mixed = (
      await dayRuns(
        item({
          results: [
            { provider: 'broken', compositeScore: null },
            { provider: 'valid', compositeScore: 72.5 },
          ],
        }),
      )
    )[0];
    assert.deepEqual([...mixed.scores], [['valid', 72.5]]);
    assert.deepEqual([...(mixed.incomplete ?? [])], ['broken']);
    // Cut short: fewer tasks recorded than planned → cut; in-flight → dropped.
    const short = (
      await dayRuns({
        run: { id: 'short', status: 'completed', createdAt: `${DAY}T09:00:00Z`, totalTasks: 4, summary: { results: [{ provider: 'v', compositeScore: 50 }] } },
        participants: [{ taskCount: 3 }],
      })
    )[0];
    assert.equal(short.cut, true);
    assert.equal((await dayRuns(item({ results: [] }, { run: { id: 'x', status: 'running', createdAt: `${DAY}T09:00:00Z`, summary: { results: [] } } }))).length, 0);
    const run = { cut: false, scores: mixed.scores, incomplete: mixed.incomplete };
    assert.deepEqual(resolveBenchDay('oci-tti-stealth', [run], 'valid'), { slug: 'oci-tti-stealth', ran: true, score: 72.5 });
    assert.deepEqual(resolveBenchDay('oci-tti-stealth', [run], 'broken'), { slug: 'oci-tti-stealth', ran: false, score: null }, 'excluded, not 0-filled');
    assert.deepEqual(resolveBenchDay('oci-tti-stealth', [run], 'absent'), { slug: 'oci-tti-stealth', ran: true, score: null }, 'non-participant still 0-filled');
    const retry = { cut: false, scores: new Map([['broken', 64]]) };
    assert.deepEqual(resolveBenchDay('oci-tti-stealth', [run, retry], 'broken'), { slug: 'oci-tti-stealth', ran: true, score: 64 }, 'real retrigger score counts');
  } finally {
    globalThis.fetch = fetchBefore;
    if (keyBefore === undefined) delete process.env.BENCHMARKS_PLATFORM_API_KEY;
    else process.env.BENCHMARKS_PLATFORM_API_KEY = keyBefore;
  }
}

console.log('provider-weekly-composite: ok');
