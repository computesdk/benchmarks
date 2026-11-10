import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: vi.fn(async () => null), loadCredentials: vi.fn(async () => null) };
});

import { createCliHarness, stdoutJson, type CliHarness } from './harness.js';

const REQ = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';

// The platform's orgBenchmarkRunSummarySchema row.
function feedRun(runId: string, benchmarkSlug = 'alpha', overrides: Record<string, unknown> = {}) {
  return {
    runId,
    benchmarkId: `b-${benchmarkSlug}`,
    benchmarkSlug,
    benchmarkName: benchmarkSlug.toUpperCase(),
    benchmarkOwner: 'own',
    benchmarkOwnerOrgId: 'org-a',
    benchmarkOwnerOrgSlug: 'acme',
    label: 'e2b',
    dimensions: {},
    provider: 'e2b',
    participantList: [{ slug: 'e2b', provider: 'e2b', color: '#000' }],
    status: 'finished',
    isArchived: false,
    benchmarkMuted: false,
    benchmarkConfidential: false,
    canArchive: true,
    submittedBy: null,
    submittedByKind: 'apiKey',
    organizationName: 'Acme',
    trigger: null,
    startedAt: '2026-11-01T12:00:00.000Z',
    completedAt: '2026-11-01T12:05:00.000Z',
    progress: { done: 10, inFlight: 0, errors: 1, total: 10 },
    ...overrides,
  };
}

const CURSOR_1 = { createdAt: '2026-11-01T09:00:00.000Z', id: 'p1-149' };

function dayPage(day: string, runs: unknown[], nextCursor: { createdAt: string; id: string } | null) {
  return { day, timeZone: 'UTC', runs, nextCursor, analytics: 'ok' };
}
let cli: CliHarness & { restore(): void };

beforeEach(() => {
  cli = createCliHarness();
});

afterEach(() => {
  cli.restore();
});

describe('bench runs feed', () => {
  it('reads GET /benchmarks/runs/summary and prints the v1 body as JSON', async () => {
    const body = { runs: [feedRun('r1'), feedRun('r2', 'rel-1')], analytics: 'ok' };
    cli.routes['GET /benchmarks/runs/summary'] = () => ({ body });
    const result = await cli.invoke(['runs', 'feed', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect([...cli.requests[0].query.keys()]).toEqual([]);
    expect(stdoutJson(result)).toEqual(body);
  });

  it('joins repeated and comma-listed --benchmark into benchmarkSlugs', async () => {
    cli.routes['GET /benchmarks/runs/summary'] = () => ({
      body: { runs: [feedRun('r1', 'rel-1'), feedRun('r2', 'bench-1')], analytics: 'ok' },
    });
    const result = await cli.invoke(['runs', 'feed', '--benchmark', 'rel-1', '--benchmark', 'bench-1,other', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('benchmarkSlugs')).toBe('rel-1,bench-1,other');
  });

  it('sends the archive and mute toggles and --limit', async () => {
    cli.routes['GET /benchmarks/runs/summary'] = () => ({ body: { runs: [], analytics: 'unavailable' } });
    const result = await cli.invoke(['runs', 'feed', '--include-archived', '--include-muted', '--limit', '5', '--json']);
    expect(result.exitCode).toBe(0);
    const query = cli.requests[0].query;
    expect(query.get('includeArchived')).toBe('1');
    expect(query.get('includeMuted')).toBe('1');
    expect(query.get('limit')).toBe('5');
  });

  it('rejects a --limit above 100 before sending', async () => {
    const result = await cli.invoke(['runs', 'feed', '--limit', '101']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--limit');
    expect(cli.requests).toHaveLength(0);
  });

  it('prints archived and muted runs from isArchived and benchmarkMuted', async () => {
    cli.routes['GET /benchmarks/runs/summary'] = () => ({
      body: {
        runs: [
          feedRun('r-archived', 'alpha', { isArchived: true }),
          feedRun('r-muted', 'beta', { benchmarkMuted: true }),
          feedRun('r-foreign', 'daily', { benchmarkOwner: 'foreign', benchmarkOwnerOrgSlug: 'computesdk' }),
        ],
        analytics: 'ok',
      },
    });
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['runs', 'feed', '--include-archived', '--include-muted']);
    const rows = table.mock.calls[0][0] as Record<string, unknown>[];
    table.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(rows[0]).toMatchObject({ run: 'r-archived', archived: true, progress: '10/10 (1 errors)' });
    expect(rows[0]).not.toHaveProperty('muted');
    expect(rows[1]).toMatchObject({ run: 'r-muted', muted: true });
    expect(rows[1]).not.toHaveProperty('archived');
    expect(rows[2]).toMatchObject({ benchmark: '~computesdk/daily' });
  });

  it('says so when analytics are unavailable', async () => {
    cli.routes['GET /benchmarks/runs/summary'] = () => ({
      body: { runs: [feedRun('r1', 'alpha', { statsPending: true })], analytics: 'unavailable' },
    });
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['runs', 'feed']);
    table.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('analytics: unavailable');
  });

  it('accepts a ~org/slug --benchmark against rows that carry the bare slug', async () => {
    cli.routes['GET /benchmarks/runs/summary'] = () => ({
      body: { runs: [feedRun('r1', 'daily', { benchmarkOwner: 'foreign', benchmarkOwnerOrgSlug: 'computesdk' })], analytics: 'ok' },
    });
    const result = await cli.invoke(['runs', 'feed', '--benchmark', '~computesdk/daily', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('benchmarkSlugs')).toBe('~computesdk/daily');
  });
  it('fails loudly when the platform ignores --benchmark', async () => {
    cli.routes['GET /benchmarks/runs/summary'] = () => ({
      body: { runs: [feedRun('r1', 'rel-1'), feedRun('r2', 'unrelated')], analytics: 'ok' },
    });
    const result = await cli.invoke(['runs', 'feed', '--benchmark', 'rel-1', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('benchmarkSlugs');
  });

  it('prints the API error for an unknown benchmark', async () => {
    cli.routes['GET /benchmarks/runs/summary'] = () => ({
      status: 400,
      body: { error: 'Unknown benchmark: no-such-bench', code: 'invalid_request' },
    });
    const result = await cli.invoke(['runs', 'feed', '--benchmark', 'no-such-bench']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown benchmark: no-such-bench (code: invalid_request)');
  });
});

describe('bench runs days', () => {
  it('sends --tz as timeZone and prints the v1 body', async () => {
    const body = { days: [{ day: '2026-11-01', count: 160 }, { day: '2026-11-02', count: 3 }], timeZone: 'UTC' };
    cli.routes['GET /benchmarks/runs/days'] = () => ({ body });
    const result = await cli.invoke(['runs', 'days', '--tz', 'UTC', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('timeZone')).toBe('UTC');
    expect(stdoutJson(result)).toEqual(body);
  });

  it('defaults timeZone to the local zone', async () => {
    cli.routes['GET /benchmarks/runs/days'] = () => ({ body: { days: [], timeZone: 'Europe/Berlin' } });
    const result = await cli.invoke(['runs', 'days', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('timeZone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('sends the feed filters', async () => {
    cli.routes['GET /benchmarks/runs/days'] = () => ({ body: { days: [], timeZone: 'UTC' } });
    await cli.invoke(['runs', 'days', '--benchmark', 'a,b', '--include-archived', '--include-muted', '--tz', 'UTC']);
    const query = cli.requests[0].query;
    expect(query.get('benchmarkSlugs')).toBe('a,b');
    expect(query.get('includeArchived')).toBe('1');
    expect(query.get('includeMuted')).toBe('1');
  });
});

describe('bench runs day', () => {
  const page1 = Array.from({ length: 150 }, (_, i) => feedRun(`p1-${i}`));
  const page2 = Array.from({ length: 12 }, (_, i) => feedRun(`p2-${i}`));

  beforeEach(() => {
    cli.routes['GET /benchmarks/runs/day/2026-11-01'] = (req) =>
      req.query.get('cursorId') === CURSOR_1.id && req.query.get('cursorCreatedAt') === CURSOR_1.createdAt
        ? { body: dayPage('2026-11-01', page2, null) }
        : { body: dayPage('2026-11-01', page1, CURSOR_1) };
  });

  it('prints one page as the v1 body', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--tz', 'UTC', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0].query.get('timeZone')).toBe('UTC');
    expect(cli.requests[0].query.get('cursorId')).toBeNull();
    const body = stdoutJson(result) as { runs: unknown[] };
    expect(body).toMatchObject({ day: '2026-11-01', timeZone: 'UTC', nextCursor: CURSOR_1, analytics: 'ok' });
    expect(body.runs).toHaveLength(150);
  });

  it('prints the next page as --cursor <createdAt>,<id> without --json', async () => {
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--tz', 'UTC']);
    table.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`--cursor ${CURSOR_1.createdAt},${CURSOR_1.id}`);
  });

  it('--all sends nextCursor back as cursorCreatedAt and cursorId and prints every run as one array', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--all', '--tz', 'UTC', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(2);
    expect(cli.requests[0].query.get('cursorId')).toBeNull();
    expect(cli.requests[1].query.get('cursorCreatedAt')).toBe(CURSOR_1.createdAt);
    expect(cli.requests[1].query.get('cursorId')).toBe(CURSOR_1.id);
    expect(cli.requests[1].query.has('cursor')).toBe(false);
    expect(cli.requests[1].query.get('timeZone')).toBe('UTC');
    const runs = stdoutJson(result) as { runId: string }[];
    expect(runs).toHaveLength(162);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(162);
  });

  it('--cursor <createdAt>,<id> starts from a given page', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--cursor', `${CURSOR_1.createdAt},${CURSOR_1.id}`, '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('cursorCreatedAt')).toBe(CURSOR_1.createdAt);
    expect(cli.requests[0].query.get('cursorId')).toBe(CURSOR_1.id);
    expect((stdoutJson(result) as { runs: unknown[] }).runs).toHaveLength(12);
  });

  it('rejects a --cursor that is not <createdAt>,<id> before sending', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--cursor', 'next-1']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--cursor takes <createdAt>,<id>');
    expect(cli.requests).toHaveLength(0);
  });

  it('stops with an error when the platform repeats a cursor', async () => {
    cli.routes['GET /benchmarks/runs/day/2026-11-03'] = () => ({
      body: dayPage('2026-11-03', [feedRun('x')], { createdAt: '2026-11-03T00:00:00.000Z', id: 'same' }),
    });    const result = await cli.invoke(['runs', 'day', '2026-11-03', '--all', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cursor');
    expect(cli.requests.length).toBeLessThanOrEqual(3);
  });

  it('rejects a malformed day before sending', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-13-40']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('YYYY-MM-DD');
    expect(cli.requests).toHaveLength(0);
  });

  it('requires a day', async () => {
    const result = await cli.invoke(['runs', 'day']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bench runs day <YYYY-MM-DD>');
  });
});

describe('bench runs list --benchmark', () => {
  const item = (id: string, benchmarkSlug: string) => ({
    id,
    benchmarkId: `b-${benchmarkSlug}`,
    organizationId: 'org-a',
    benchmarkSlug,
    status: 'completed',
    totalTasks: 1,
    workerCount: 1,
    archivedAt: null,
  });

  it('sends repeated --benchmark as benchmarkSlugs on the cross-benchmark list', async () => {
    cli.routes['GET /benchmarks/runs'] = () => ({ body: { items: [item('r1', 'bench-1'), item('r2', 'rel-1')] } });
    const result = await cli.invoke([
      'runs', 'list', '--benchmark', 'bench-1', '--benchmark', 'rel-1', '--archived', 'include', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].path).toBe('/benchmarks/runs');
    expect(cli.requests[0].query.get('benchmarkSlugs')).toBe('bench-1,rel-1');
    expect(cli.requests[0].query.get('archived')).toBe('include');
    expect((stdoutJson(result) as { benchmarkSlug: string }[]).map((r) => r.benchmarkSlug)).toEqual(['bench-1', 'rel-1']);
  });

  it('fails loudly when the platform ignores benchmarkSlugs', async () => {
    cli.routes['GET /benchmarks/runs'] = () => ({ body: { items: [item('r1', 'bench-1'), item('r9', 'other')] } });
    const result = await cli.invoke(['runs', 'list', '--benchmark', 'bench-1', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('benchmarkSlugs');
  });

  it('rejects a positional slug together with --benchmark', async () => {
    const result = await cli.invoke(['runs', 'list', 'alpha', '--benchmark', 'beta']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--benchmark');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench reliability cards', () => {
  const card = (slug: string, overrides: { muted?: boolean; paused?: boolean } = {}) => ({
    benchmark: {
      id: `b-${slug}`,
      slug,
      name: slug.toUpperCase(),
      ownerOrgSlug: 'acme',
      ownerOrgName: 'Acme',
      owner: 'own',
      muted: overrides.muted ?? false,
    },
    card: {
      config: { intervalMs: 300_000, graceMs: 60_000, target: 0.99 },
      generatedAt: '2026-11-06T12:00:00.000Z',
      uptime: 0.995,
      counted: 288,
      failed: 2,
      paused: overrides.paused ?? false,
      scheduler: { cells: [] },
      participants: [
        {
          slug: 'e2b',
          provider: 'e2b',
          status: { state: 'up', since: null, lastFailureAt: null, lastCheckAt: '2026-11-06T11:55:00.000Z' },
          uptime: 1,
          counted: 144,
          failed: 0,
          cells: [],
        },
        {
          slug: 'modal',
          provider: 'modal',
          status: { state: 'down', since: '2026-11-06T11:00:00.000Z', lastFailureAt: '2026-11-06T11:55:00.000Z', lastCheckAt: '2026-11-06T11:55:00.000Z' },
          uptime: 0.99,
          counted: 144,
          failed: 2,
          cells: [],
        },
      ],
      lastCheckAt: '2026-11-06T11:55:00.000Z',
    },
  });

  it('reads GET /benchmarks/reliability-cards and prints the v1 body', async () => {
    const body = { cards: [card('rel-1')], mutedCount: 1 };
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({ body });
    const result = await cli.invoke(['reliability', 'cards', '--json']);
    expect(result.exitCode).toBe(0);
    expect([...cli.requests[0].query.keys()]).toEqual([]);
    expect(stdoutJson(result)).toEqual(body);
  });

  it('prints one row per card, flags paused ones, and counts the hidden muted ones', async () => {
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({ body: { cards: [card('rel-1', { paused: true })], mutedCount: 2 } });
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['reliability', 'cards']);
    const rows = table.mock.calls[0][0] as Record<string, unknown>[];
    table.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(rows).toEqual([
      { benchmark: 'rel-1', uptime: '99.50%', checks: 288, failed: 2, down: '1/2', lastCheck: '2026-11-06T11:55:00.000Z', paused: true },
    ]);
    expect(result.stdout).toContain('2 muted reliability benchmarks hidden');
  });

  it('marks muted cards with --include-muted and drops the hidden note', async () => {
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({ body: { cards: [card('rel-1', { muted: true })], mutedCount: 1 } });
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['reliability', 'cards', '--include-muted']);
    const rows = table.mock.calls[0][0] as Record<string, unknown>[];
    table.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(rows[0]).toMatchObject({ muted: true });
    expect(result.stdout).not.toContain('hidden');
  });
  it('sends --include-muted', async () => {
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({ body: { cards: [], mutedCount: 0 } });
    const result = await cli.invoke(['reliability', 'cards', '--include-muted', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('includeMuted')).toBe('1');
  });

  it('surfaces the 503 analytics_unavailable envelope after the client retries', async () => {
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({
      status: 503,
      body: { error: 'Analytics unavailable', code: 'analytics_unavailable' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const pending = cli.invoke(['reliability', 'cards']);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Analytics unavailable (code: analytics_unavailable)');
    } finally {
      vi.useRealTimers();
    }
    // A GET is retry-safe: the default [1000, 3000] delays give three attempts.
    expect(cli.requests).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('still routes `reliability <slug>` to the uptime view', async () => {
    cli.routes['GET /benchmarks/rel-1/reliability'] = () => ({ status: 404, body: { error: 'Benchmark not found' } });
    const result = await cli.invoke(['reliability', 'rel-1', '--json']);
    expect(cli.requests[0].path).toBe('/benchmarks/rel-1/reliability');
    expect(result.exitCode).toBe(1);
  });

  it('rejects the uptime-view flags on cards', async () => {
    const result = await cli.invoke(['reliability', 'cards', '--day', '2026-11-01']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option for this command: --day');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench activity', () => {
  it('sends --days and --benchmark and prints the v1 body', async () => {
    const body = { days: 7, benchmarkSlug: 'bulk', series: [{ date: '2026-11-01', runs: 3 }] };
    cli.routes['GET /benchmarks/activity'] = () => ({ body });
    const result = await cli.invoke(['activity', '--days', '7', '--benchmark', 'bulk', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('days')).toBe('7');
    expect(cli.requests[0].query.get('benchmarkSlug')).toBe('bulk');
    expect(stdoutJson(result)).toEqual(body);
  });

  it('prints one line per date without --json', async () => {
    cli.routes['GET /benchmarks/activity'] = () => ({
      body: { days: 2, benchmarkSlug: null, series: [{ date: '2026-11-01', runs: 3 }, { date: '2026-11-02', runs: 0 }] },
    });
    const result = await cli.invoke(['activity', '--days', '2']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Runs per UTC day, last 2 days\n2026-11-01  3\n2026-11-02  0');
  });
  it('rejects --days outside 1..90 before sending', async () => {
    const result = await cli.invoke(['activity', '--days', '91']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--days');
    expect(cli.requests).toHaveLength(0);
  });

  it('takes one --benchmark', async () => {
    const result = await cli.invoke(['activity', '--benchmark', 'a,b']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--benchmark');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench run-again', () => {
  const accepted = {
    benchmarkSlug: 'daily-x',
    category: 'sandbox',
    runAgainId: REQ,
    statusUrl: `/api/v1/benchmarks/daily-x/run-again/${REQ}`,
  };

  beforeEach(() => {
    cli.useToken('member_token');
  });

  it('POSTs the run-again route with no body and prints the v1 body', async () => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({ status: 202, body: accepted });
    const result = await cli.invoke(['run-again', 'daily-x', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0]).toMatchObject({ method: 'POST', path: '/benchmarks/daily-x/run-again' });
    expect(cli.requests[0].body).toBeUndefined();
    expect(cli.requests[0].authorization).toBe('Bearer member_token');
    expect(stdoutJson(result)).toEqual(accepted);
  });

  it('prints a human line with the runAgainId and the status command', async () => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({ status: 202, body: accepted });
    const result = await cli.invoke(['run-again', 'daily-x']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Run again of daily-x (sandbox) requested: ${REQ}`);
    expect(result.stdout).toContain(`bench run-again status daily-x --request ${REQ}`);
  });

  it('turns user_credential_required into a `bench auth login` hint in place of the platform hint', async () => {
    cli.useApiKey();
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({
      status: 403,
      body: {
        error: 'User credential required',
        code: 'user_credential_required',
        hint: "Sign in as a user (bench login); API keys can't make requests on a person's behalf.",
      },
    });
    const result = await cli.invoke(['run-again', 'daily-x', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('User credential required (code: user_credential_required)');
    expect(result.stderr).toContain('Run again needs a user login');
    expect(result.stderr).toContain('`bench auth login`');
    expect(result.stderr).not.toContain('(bench login)');
  });

  it('reports quota_exceeded with retryAt', async () => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({
      status: 429,
      body: { error: 'Run again limit reached for today', code: 'quota_exceeded', retryAt: '2026-11-07T00:00:00.000Z' },
    });
    const result = await cli.invoke(['run-again', 'daily-x', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('429');
    expect(result.stderr).toContain('(code: quota_exceeded)');
    expect(result.stderr).toContain('Retry at: 2026-11-07T00:00:00.000Z');
    expect(result.stderr).toContain('bench run-again status');
  });

  it('reports run_again_disabled', async () => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({
      status: 409,
      body: { error: 'Run again is turned off for this benchmark', code: 'run_again_disabled' },
    });
    const result = await cli.invoke(['run-again', 'daily-x']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Run again is turned off for this benchmark (code: run_again_disabled)');
  });

  it.each([
    ['owner_only', 'owner organization'],
    ['category_not_entitled', 'not entitled'],
  ])('explains a 403 %s refusal', async (code, hint) => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({
      status: 403,
      body: { error: 'Run again is not available for this benchmark', code },
    });
    const result = await cli.invoke(['run-again', 'daily-x']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`(code: ${code})`);
    expect(result.stderr).toContain(hint);
  });

  it('--wait polls the request until it reports a run', async () => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({ status: 202, body: accepted });
    let polls = 0;
    cli.routes[`GET /benchmarks/daily-x/run-again/${REQ}`] = () => {
      polls += 1;
      return { body: { runAgainId: REQ, runId: polls < 3 ? null : RUN } };
    };
    const result = await cli.invoke(['run-again', 'daily-x', '--wait', '--interval', '0.01', '--timeout', '5', '--json']);
    expect(result.exitCode).toBe(0);
    expect(polls).toBe(3);
    expect(stdoutJson(result)).toEqual({ runAgainId: REQ, runId: RUN });
  });

  it('--wait prints "Run <id> started" without --json', async () => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({ status: 202, body: accepted });
    cli.routes[`GET /benchmarks/daily-x/run-again/${REQ}`] = () => ({ body: { runAgainId: REQ, runId: RUN } });
    const result = await cli.invoke(['run-again', 'daily-x', '--wait', '--interval', '0.01']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Run ${RUN} started`);
  });

  it('--wait exits 3 when the request reports no run before --timeout', async () => {
    cli.routes['POST /benchmarks/daily-x/run-again'] = () => ({ status: 202, body: accepted });
    cli.routes[`GET /benchmarks/daily-x/run-again/${REQ}`] = () => ({ body: { runAgainId: REQ, runId: null } });
    const started = Date.now();
    const result = await cli.invoke(['run-again', 'daily-x', '--wait', '--interval', '0.01', '--timeout', '0.1', '--json']);
    expect(result.exitCode).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(stdoutJson(result)).toEqual({ runAgainId: REQ, runId: null });
    expect(result.stderr).toContain(REQ);
    expect(result.stderr).toContain(`bench run-again status daily-x --request ${REQ}`);
  });

  it('rejects --timeout without --wait', async () => {
    const result = await cli.invoke(['run-again', 'daily-x', '--timeout', '10']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--wait');
    expect(cli.requests).toHaveLength(0);
  });

  it('rejects a non-positive --interval', async () => {
    const result = await cli.invoke(['run-again', 'daily-x', '--wait', '--interval', '0']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--interval');
    expect(cli.requests).toHaveLength(0);
  });

  it('requires a benchmark slug', async () => {
    const result = await cli.invoke(['run-again']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bench run-again <benchmark-slug>');
  });

  it('no longer answers to `bench retrigger`', async () => {
    const result = await cli.invoke(['retrigger', 'daily-x']);
    expect(result.exitCode).toBe(1);
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench run-again status', () => {
  const state = {
    benchmarkSlug: 'daily-x',
    category: 'sandbox',
    available: false,
    disabledReason: 'Run again limit reached for today',
    quota: { day: '2026-11-06', used: 1, limit: 1, resetsAt: '2026-11-07T00:00:00.000Z' },
  };

  it('reads the run-again state with an org API key', async () => {
    cli.routes['GET /benchmarks/daily-x/run-again'] = () => ({ body: state });
    const result = await cli.invoke(['run-again', 'status', 'daily-x', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'GET', path: '/benchmarks/daily-x/run-again' });
    expect(cli.requests[0].authorization).toBe('Bearer bp_test_key');
    expect(stdoutJson(result)).toEqual(state);
  });

  it('prints availability and quota without --json', async () => {
    cli.routes['GET /benchmarks/daily-x/run-again'] = () => ({
      body: { ...state, available: true, disabledReason: null, quota: { ...state.quota, used: 0 } },
    });
    const result = await cli.invoke(['run-again', 'status', 'daily-x']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('daily-x (sandbox): run again available');
    expect(result.stdout).toContain('0/1');
  });

  it('prints a benchmark with no daily category and its disabledReason', async () => {
    cli.routes['GET /benchmarks/alpha/run-again'] = () => ({
      body: { ...state, benchmarkSlug: 'alpha', category: null, disabledReason: 'Not a daily benchmark' },
    });
    const result = await cli.invoke(['run-again', 'status', 'alpha']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha: run again unavailable (Not a daily benchmark)');
  });

  it('--request reads one request', async () => {
    cli.routes[`GET /benchmarks/daily-x/run-again/${REQ}`] = () => ({ body: { runAgainId: REQ, runId: null } });
    const result = await cli.invoke(['run-again', 'status', 'daily-x', '--request', REQ, '--json']);
    expect(result.exitCode).toBe(0);
    expect(stdoutJson(result)).toEqual({ runAgainId: REQ, runId: null });
  });

  it('--request prints the run it reported without --json', async () => {
    cli.routes[`GET /benchmarks/daily-x/run-again/${REQ}`] = () => ({ body: { runAgainId: REQ, runId: RUN } });
    const result = await cli.invoke(['run-again', 'status', 'daily-x', '--request', REQ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Run again ${REQ} started run ${RUN}`);
  });

  it('does not take --wait', async () => {
    const result = await cli.invoke(['run-again', 'status', 'daily-x', '--wait']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option for this command: --wait');
  });
});
