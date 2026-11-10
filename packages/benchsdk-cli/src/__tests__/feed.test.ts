import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: vi.fn(async () => null), loadCredentials: vi.fn(async () => null) };
});

import { createCliHarness, stdoutJson, type CliHarness } from './harness.js';

const REQ = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';

function feedRun(runId: string, benchmarkSlug = 'alpha', overrides: Record<string, unknown> = {}) {
  return {
    runId,
    benchmarkSlug,
    benchmarkName: benchmarkSlug.toUpperCase(),
    status: 'finished',
    isArchived: false,
    archivedAt: null,
    muted: false,
    startedAt: '2026-11-01T12:00:00.000Z',
    completedAt: '2026-11-01T12:05:00.000Z',
    stats: null,
    ...overrides,
  };
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
    cli.routes['GET /benchmarks/runs/days'] = () => ({ body: { days: [], timeZone: 'x' } });
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
      req.query.get('cursor') === 'next-1'
        ? { body: { day: '2026-11-01', runs: page2, nextCursor: null } }
        : { body: { day: '2026-11-01', runs: page1, nextCursor: 'next-1' } };
  });

  it('prints one page as the v1 body', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--tz', 'UTC', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0].query.get('timeZone')).toBe('UTC');
    const body = stdoutJson(result) as { day: string; runs: unknown[]; nextCursor: string | null };
    expect(body.day).toBe('2026-11-01');
    expect(body.runs).toHaveLength(150);
    expect(body.nextCursor).toBe('next-1');
  });

  it('--all follows nextCursor and prints every run as one array', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--all', '--tz', 'UTC', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(2);
    expect(cli.requests[0].query.get('cursor')).toBeNull();
    expect(cli.requests[1].query.get('cursor')).toBe('next-1');
    expect(cli.requests[1].query.get('timeZone')).toBe('UTC');
    const runs = stdoutJson(result) as { runId: string }[];
    expect(runs).toHaveLength(162);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(162);
  });

  it('--cursor starts from a given page', async () => {
    const result = await cli.invoke(['runs', 'day', '2026-11-01', '--cursor', 'next-1', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('cursor')).toBe('next-1');
    expect((stdoutJson(result) as { runs: unknown[] }).runs).toHaveLength(12);
  });

  it('follows a { createdAt, id } cursor with cursorCreatedAt and cursorId', async () => {
    cli.routes['GET /benchmarks/runs/day/2026-11-02'] = (req) =>
      req.query.get('cursorId') === 'r-150'
        ? { body: { day: '2026-11-02', runs: [feedRun('last')], nextCursor: null } }
        : { body: { day: '2026-11-02', runs: [feedRun('first')], nextCursor: { createdAt: '2026-11-02T01:00:00.000Z', id: 'r-150' } } };
    const result = await cli.invoke(['runs', 'day', '2026-11-02', '--all', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[1].query.get('cursorCreatedAt')).toBe('2026-11-02T01:00:00.000Z');
    expect((stdoutJson(result) as unknown[]).length).toBe(2);
  });

  it('stops with an error when the platform repeats a cursor', async () => {
    cli.routes['GET /benchmarks/runs/day/2026-11-03'] = () => ({
      body: { day: '2026-11-03', runs: [feedRun('x')], nextCursor: 'same' },
    });
    const result = await cli.invoke(['runs', 'day', '2026-11-03', '--all', '--json']);
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
  it('reads GET /benchmarks/reliability-cards and prints the v1 body', async () => {
    const body = { cards: [{ benchmarkSlug: 'rel-1', benchmarkName: 'Rel 1', uptime: 0.99, pausedNow: false }], mutedCount: 1 };
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({ body });
    const result = await cli.invoke(['reliability', 'cards', '--json']);
    expect(result.exitCode).toBe(0);
    expect([...cli.requests[0].query.keys()]).toEqual([]);
    expect(stdoutJson(result)).toEqual(body);
  });

  it('sends --include-muted', async () => {
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({ body: { cards: [], mutedCount: 0 } });
    const result = await cli.invoke(['reliability', 'cards', '--include-muted', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('includeMuted')).toBe('1');
  });

  it('surfaces the 503 analytics_unavailable envelope', async () => {
    cli.routes['GET /benchmarks/reliability-cards'] = () => ({
      status: 503,
      body: { error: 'Analytics unavailable', code: 'analytics_unavailable' },
    });
    const result = await cli.invoke(['reliability', 'cards']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Analytics unavailable (code: analytics_unavailable)');
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
    const body = { days: 7, series: [{ day: '2026-11-01', total: 3, completed: 2, failed: 1 }] };
    cli.routes['GET /benchmarks/activity'] = () => ({ body });
    const result = await cli.invoke(['activity', '--days', '7', '--benchmark', 'bulk', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('days')).toBe('7');
    expect(cli.requests[0].query.get('benchmarkSlug')).toBe('bulk');
    expect(stdoutJson(result)).toEqual(body);
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

describe('bench retrigger', () => {
  const accepted = {
    benchmarkSlug: 'daily-x',
    category: 'sandbox',
    requestId: REQ,
    statusUrl: `/api/v1/benchmarks/daily-x/retrigger/${REQ}`,
  };

  beforeEach(() => {
    cli.useToken('member_token');
  });

  it('POSTs the retrigger route and prints the v1 body', async () => {
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({ status: 202, body: accepted });
    const result = await cli.invoke(['retrigger', 'daily-x', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'POST', path: '/benchmarks/daily-x/retrigger', body: {} });
    expect(cli.requests[0].authorization).toBe('Bearer member_token');
    expect(stdoutJson(result)).toEqual(accepted);
  });

  it('prints a human line with the request id', async () => {
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({ status: 202, body: accepted });
    const result = await cli.invoke(['retrigger', 'daily-x']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(REQ);
  });

  it('turns user_credential_required into a login hint', async () => {
    cli.useApiKey();
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({
      status: 403,
      body: { error: 'User credential required', code: 'user_credential_required' },
    });
    const result = await cli.invoke(['retrigger', 'daily-x', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Retrigger needs a user login');
    expect(result.stderr).toContain('bench auth login');
    expect(result.stderr).toContain('API keys cannot retrigger');
  });

  it('reports quota_exceeded with the retry time', async () => {
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({
      status: 429,
      body: { error: 'Daily retrigger quota used', code: 'quota_exceeded', retryAt: '2026-11-07T00:00:00.000Z' },
    });
    const result = await cli.invoke(['retrigger', 'daily-x', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('quota_exceeded');
    expect(result.stderr).toContain('2026-11-07T00:00:00.000Z');
  });

  it('reports retrigger_unavailable with its reason', async () => {
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({
      status: 409,
      body: { error: 'Retrigger unavailable', code: 'retrigger_unavailable', disabledReason: 'A run is in progress' },
    });
    const result = await cli.invoke(['retrigger', 'daily-x']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('A run is in progress');
  });

  it('--wait polls the request until a run links', async () => {
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({ status: 202, body: accepted });
    let polls = 0;
    cli.routes[`GET /benchmarks/daily-x/retrigger/${REQ}`] = () => {
      polls += 1;
      return {
        body: polls < 3
          ? { requestId: REQ, runId: null, status: 'pending' }
          : { requestId: REQ, runId: RUN, status: 'linked' },
      };
    };
    const result = await cli.invoke(['retrigger', 'daily-x', '--wait', '--interval', '0.01', '--timeout', '5', '--json']);
    expect(result.exitCode).toBe(0);
    expect(polls).toBe(3);
    expect(stdoutJson(result)).toEqual({ requestId: REQ, runId: RUN });
  });

  it('--wait prints "Run <id> started" without --json', async () => {
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({ status: 202, body: accepted });
    cli.routes[`GET /benchmarks/daily-x/retrigger/${REQ}`] = () => ({
      body: { requestId: REQ, runId: RUN, status: 'linked' },
    });
    const result = await cli.invoke(['retrigger', 'daily-x', '--wait', '--interval', '0.01']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Run ${RUN} started`);
  });

  it('--wait exits 3 when no run links before --timeout', async () => {
    cli.routes['POST /benchmarks/daily-x/retrigger'] = () => ({ status: 202, body: accepted });
    cli.routes[`GET /benchmarks/daily-x/retrigger/${REQ}`] = () => ({
      body: { requestId: REQ, runId: null, status: 'pending' },
    });
    const started = Date.now();
    const result = await cli.invoke(['retrigger', 'daily-x', '--wait', '--interval', '0.01', '--timeout', '0.1', '--json']);
    expect(result.exitCode).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(result.stderr).toContain(REQ);
    expect(result.stderr).toContain('bench retrigger status daily-x --request');
  });

  it('rejects --timeout without --wait', async () => {
    const result = await cli.invoke(['retrigger', 'daily-x', '--timeout', '10']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--wait');
    expect(cli.requests).toHaveLength(0);
  });

  it('rejects a non-positive --interval', async () => {
    const result = await cli.invoke(['retrigger', 'daily-x', '--wait', '--interval', '0']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--interval');
    expect(cli.requests).toHaveLength(0);
  });

  it('requires a benchmark slug', async () => {
    const result = await cli.invoke(['retrigger']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bench retrigger <benchmark-slug>');
  });
});

describe('bench retrigger status', () => {
  it('reads the retrigger state', async () => {
    const body = {
      benchmarkSlug: 'daily-x',
      category: 'sandbox',
      available: false,
      disabledReason: null,
      quota: { day: '2026-11-06', used: 1, limit: 1, resetsAt: '2026-11-07T00:00:00.000Z' },
    };
    cli.routes['GET /benchmarks/daily-x/retrigger'] = () => ({ body });
    const result = await cli.invoke(['retrigger', 'status', 'daily-x', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'GET', path: '/benchmarks/daily-x/retrigger' });
    expect(stdoutJson(result)).toEqual(body);
  });

  it('prints availability and quota without --json', async () => {
    cli.routes['GET /benchmarks/daily-x/retrigger'] = () => ({
      body: {
        benchmarkSlug: 'daily-x',
        category: 'sandbox',
        available: true,
        disabledReason: null,
        quota: { day: '2026-11-06', used: 0, limit: 1, resetsAt: '2026-11-07T00:00:00.000Z' },
      },
    });
    const result = await cli.invoke(['retrigger', 'status', 'daily-x']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('available');
    expect(result.stdout).toContain('0/1');
  });

  it('--request reads one request', async () => {
    cli.routes[`GET /benchmarks/daily-x/retrigger/${REQ}`] = () => ({
      body: { requestId: REQ, runId: null, status: 'pending' },
    });
    const result = await cli.invoke(['retrigger', 'status', 'daily-x', '--request', REQ, '--json']);
    expect(result.exitCode).toBe(0);
    expect(stdoutJson(result)).toEqual({ requestId: REQ, runId: null, status: 'pending' });
  });

  it('does not take --wait', async () => {
    const result = await cli.invoke(['retrigger', 'status', 'daily-x', '--wait']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option for this command: --wait');
  });
});
