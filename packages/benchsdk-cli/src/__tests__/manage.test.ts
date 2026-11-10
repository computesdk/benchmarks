import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: vi.fn(async () => null), loadCredentials: vi.fn(async () => null) };
});

const prompt = vi.hoisted(() => ({ answer: 'n', questions: [] as string[] }));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async (text: string) => {
      prompt.questions.push(text);
      return prompt.answer;
    },
    close: () => {},
  }),
}));

import { createCliHarness, stdoutJson, type CliHarness } from './harness.js';

const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';

function benchmark(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b-1',
    organizationId: 'org-a',
    slug: 'alpha',
    name: 'Alpha',
    tagline: null,
    description: null,
    status: 'active',
    visibility: 'private',
    type: 'standard',
    mutedAt: null,
    ...overrides,
  };
}

let cli: CliHarness & { restore(): void };

beforeEach(() => {
  cli = createCliHarness();
  cli.setStdinTTY(undefined);
  prompt.answer = 'n';
  prompt.questions.length = 0;
});

afterEach(() => {
  cli.restore();
});

describe('bench benchmarks archive', () => {
  beforeEach(() => {
    cli.routes['PATCH /benchmarks/alpha'] = (req) => ({
      body: {
        benchmark: benchmark({ status: (req.body as { status: string }).status }),
        archivedRunCount: 3,
      },
    });
  });

  it('refuses without -y when stdin is not a terminal and sends no request', async () => {
    const result = await cli.invoke(['benchmarks', 'archive', 'alpha', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--yes');
    expect(result.stderr).toContain('-y');
    expect(cli.requests).toHaveLength(0);
  });

  it('archives with -y and prints the benchmark with archivedRunCount as JSON', async () => {
    const result = await cli.invoke(['benchmarks', 'archive', 'alpha', '-y', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0]).toMatchObject({ method: 'PATCH', path: '/benchmarks/alpha', body: { status: 'archived' } });
    expect(cli.requests[0].authorization).toBe('Bearer bp_test_key');
    expect(stdoutJson(result)).toMatchObject({ slug: 'alpha', status: 'archived', archivedRunCount: 3 });
  });

  it('accepts --yes and prints one confirmation line', async () => {
    const result = await cli.invoke(['benchmarks', 'archive', 'alpha', '--yes']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Archived benchmark alpha (3 runs)');
  });

  it('prompts on a terminal and archives when the answer is yes', async () => {
    cli.setStdinTTY(true);
    prompt.answer = 'y';
    const result = await cli.invoke(['benchmarks', 'archive', 'alpha']);
    expect(result.exitCode).toBe(0);
    expect(prompt.questions[0]).toContain('alpha');
    expect(cli.requests).toHaveLength(1);
  });

  it('prompts on a terminal and changes nothing when the answer is no', async () => {
    cli.setStdinTTY(true);
    prompt.answer = '';
    const result = await cli.invoke(['benchmarks', 'archive', 'alpha']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Aborted');
    expect(cli.requests).toHaveLength(0);
  });

  it('requires a benchmark slug', async () => {
    const result = await cli.invoke(['benchmarks', 'archive', '-y']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bench benchmarks archive <benchmark-slug>');
    expect(cli.requests).toHaveLength(0);
  });

  it('a repeat archive exits 1 with the 409 conflict and a restore hint', async () => {
    cli.routes['PATCH /benchmarks/alpha'] = () => ({
      status: 409,
      body: {
        error: 'Benchmark is already archived',
        code: 'conflict',
        hint: 'The resource is already in this state; fetch it and decide whether to retry.',
      },
    });
    const result = await cli.invoke(['benchmarks', 'archive', 'alpha', '-y']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('409');
    expect(result.stderr).toContain('Benchmark is already archived (code: conflict)');
    expect(result.stderr).toContain('Hint: alpha is already archived; `bench benchmarks restore alpha` brings it back.');
  });
  it('renders a member-login refusal with the API message and an admin hint', async () => {
    cli.useToken('member_token');
    cli.routes['PATCH /benchmarks/alpha'] = () => ({
      status: 403,
      body: { error: 'Only organization owners or admins may do this', code: 'forbidden', requestId: 'req_1' },
    });
    const result = await cli.invoke(['benchmarks', 'archive', 'alpha', '-y', '--json']);
    expect(result.exitCode).toBe(1);
    expect(cli.requests[0].authorization).toBe('Bearer member_token');
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('403');
    expect(result.stderr).toContain('Only organization owners or admins may do this');
    expect(result.stderr).toContain('code: forbidden');
    expect(result.stderr).toMatch(/owner or admin/i);
  });
});

describe('bench benchmarks restore', () => {
  it('restores without confirmation and prints status active', async () => {
    cli.routes['PATCH /benchmarks/alpha'] = () => ({
      body: { benchmark: benchmark({ status: 'active' }), archivedRunCount: 3 },
    });
    const result = await cli.invoke(['benchmarks', 'restore', 'alpha', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'PATCH', body: { status: 'active' } });
    expect(stdoutJson(result)).toMatchObject({ status: 'active', archivedRunCount: 3 });
  });

  it('restoring a benchmark that was not archived prints no run count', async () => {
    cli.routes['PATCH /benchmarks/alpha'] = () => ({ body: { benchmark: benchmark({ status: 'active' }) } });
    const result = await cli.invoke(['benchmarks', 'restore', 'alpha']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Restored benchmark alpha');
  });
  it('does not take --yes', async () => {
    const result = await cli.invoke(['benchmarks', 'restore', 'alpha', '--yes']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option for this command: --yes');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench benchmarks describe', () => {
  beforeEach(() => {
    cli.routes['PATCH /benchmarks/alpha'] = (req) => ({ body: { benchmark: benchmark(req.body as Record<string, unknown>) } });
  });

  it('sends tagline and description and prints the updated benchmark', async () => {
    const result = await cli.invoke([
      'benchmarks', 'describe', 'alpha', '--tagline', 'CLI tagline', '--description', 'CLI desc', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({
      method: 'PATCH',
      path: '/benchmarks/alpha',
      body: { tagline: 'CLI tagline', description: 'CLI desc' },
    });
    expect(stdoutJson(result)).toMatchObject({ tagline: 'CLI tagline', description: 'CLI desc' });
  });

  it('clears the tagline with --clear-tagline', async () => {
    const result = await cli.invoke(['benchmarks', 'describe', 'alpha', '--clear-tagline', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toEqual({ tagline: null });
    expect(stdoutJson(result)).toMatchObject({ tagline: null });
  });

  it('clears the description with --clear-description', async () => {
    const result = await cli.invoke(['benchmarks', 'describe', 'alpha', '--clear-description']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toEqual({ description: null });
  });

  it('reads the description from --description-file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-describe-'));
    const file = join(dir, 'about.md');
    await writeFile(file, '# Alpha\n\nLong form.\n');
    const result = await cli.invoke(['benchmarks', 'describe', 'alpha', '--description-file', file, '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toEqual({ description: '# Alpha\n\nLong form.\n' });
  });

  it('needs at least one field and sends nothing otherwise', async () => {
    const result = await cli.invoke(['benchmarks', 'describe', 'alpha']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--tagline');
    expect(cli.requests).toHaveLength(0);
  });

  it('rejects a value together with its --clear flag', async () => {
    const result = await cli.invoke(['benchmarks', 'describe', 'alpha', '--tagline', 'x', '--clear-tagline']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--clear-tagline');
    expect(cli.requests).toHaveLength(0);
  });

  it('rejects --description together with --description-file', async () => {
    const result = await cli.invoke([
      'benchmarks', 'describe', 'alpha', '--description', 'x', '--description-file', '/tmp/x.md',
    ]);
    expect(result.exitCode).toBe(1);
    expect(cli.requests).toHaveLength(0);
  });

  it('renders a member-login refusal', async () => {
    cli.useToken('member_token');
    cli.routes['PATCH /benchmarks/alpha'] = () => ({
      status: 403,
      body: { error: 'Only organization owners or admins may do this' },
    });
    const result = await cli.invoke(['benchmarks', 'describe', 'alpha', '--tagline', 'x', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Only organization owners or admins may do this');
    expect(result.stderr).toMatch(/owner or admin/i);
  });
});

describe('bench benchmarks mute / unmute', () => {
  beforeEach(() => {
    cli.routes['PATCH /benchmarks/muted-1'] = (req) => ({
      body: {
        benchmark: benchmark({
          slug: 'muted-1',
          mutedAt: (req.body as { muted: boolean }).muted ? '2026-11-06T00:00:00.000Z' : null,
        }),
      },
    });
  });

  it('unmute sends muted:false and prints mutedAt null', async () => {
    const result = await cli.invoke(['benchmarks', 'unmute', 'muted-1', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'PATCH', path: '/benchmarks/muted-1', body: { muted: false } });
    expect(stdoutJson(result)).toMatchObject({ mutedAt: null });
  });

  it('mute sends muted:true and prints a human line', async () => {
    const result = await cli.invoke(['benchmarks', 'mute', 'muted-1']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toEqual({ muted: true });
    expect(result.stdout).toBe('Muted benchmark muted-1');
  });
});

describe('bench benchmarks pause / resume', () => {
  it('pause POSTs the pause route and prints paused:true', async () => {
    cli.routes['POST /benchmarks/rel-1/pause'] = () => ({
      body: { paused: true, pauses: [{ start: '2026-11-06T00:00:00.000Z', end: null }] },
    });
    const result = await cli.invoke(['benchmarks', 'pause', 'rel-1', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'POST', path: '/benchmarks/rel-1/pause', body: {} });
    expect(stdoutJson(result)).toMatchObject({ paused: true });
  });

  it('pause sends --start and --end', async () => {
    cli.routes['POST /benchmarks/rel-1/pause'] = () => ({ body: { paused: true, pauses: [] } });
    const result = await cli.invoke([
      'benchmarks', 'pause', 'rel-1', '--start', '2026-11-06T00:00:00Z', '--end', '2026-11-07T00:00:00Z',
    ]);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toEqual({ start: '2026-11-06T00:00:00Z', end: '2026-11-07T00:00:00Z' });
  });

  it('pause rejects a --start that is not a timestamp before sending', async () => {
    const result = await cli.invoke(['benchmarks', 'pause', 'rel-1', '--start', 'tomorrow']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--start');
    expect(cli.requests).toHaveLength(0);
  });

  it('resume DELETEs the pause route and prints paused:false', async () => {
    cli.routes['DELETE /benchmarks/rel-1/pause'] = () => ({ body: { paused: false, pauses: [] } });
    const result = await cli.invoke(['benchmarks', 'resume', 'rel-1', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'DELETE', path: '/benchmarks/rel-1/pause' });
    expect(stdoutJson(result)).toMatchObject({ paused: false });
  });

  it('a second resume exits non-zero with the API conflict message', async () => {
    cli.routes['DELETE /benchmarks/rel-1/pause'] = () => ({
      status: 409,
      body: { error: 'Benchmark is not paused', code: 'conflict' },
    });
    const result = await cli.invoke(['benchmarks', 'resume', 'rel-1', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Benchmark is not paused');
    expect(result.stderr).toContain('409');
  });

  it('pausing a non-reliability benchmark exits non-zero with the 400 message', async () => {
    cli.routes['POST /benchmarks/alpha/pause'] = () => ({
      status: 400,
      body: { error: 'Benchmark is not a reliability benchmark', code: 'invalid_request' },
    });
    const result = await cli.invoke(['benchmarks', 'pause', 'alpha', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a reliability benchmark');
  });
});

describe('bench benchmarks list --status', () => {
  it('sends status to GET /benchmarks', async () => {
    cli.routes['GET /benchmarks'] = () => ({ body: { items: [benchmark(), benchmark({ slug: 'old', status: 'archived' })] } });
    const result = await cli.invoke(['benchmarks', 'list', '--status', 'all', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('status')).toBe('all');
    expect((stdoutJson(result) as { slug: string }[]).map((b) => b.slug)).toEqual(['alpha', 'old']);
  });

  it('rejects an unknown status before sending', async () => {
    const result = await cli.invoke(['benchmarks', 'list', '--status', 'deleted']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--status must be one of active, archived, all');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench runs archive / unarchive', () => {
  it('refuses without -y when stdin is not a terminal and sends no request', async () => {
    const result = await cli.invoke(['runs', 'archive', RUN_1, RUN_2, '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--yes');
    expect(cli.requests).toHaveLength(0);
  });

  it('archives with -y; the count comes from the platform answer', async () => {
    cli.routes['POST /benchmarks/runs/archive'] = () => ({ body: { archived: 2, count: 2 } });
    const result = await cli.invoke(['runs', 'archive', RUN_1, RUN_2, '-y', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({
      method: 'POST',
      path: '/benchmarks/runs/archive',
      body: { runIds: [RUN_1, RUN_2], archived: true },
    });
    expect(stdoutJson(result)).toEqual({ archived: true, count: 2 });
  });

  it('also reads an { archived: <count> } answer without count', async () => {
    cli.routes['POST /benchmarks/runs/archive'] = () => ({ body: { archived: 2 } });
    const result = await cli.invoke(['runs', 'archive', RUN_1, RUN_2, '--yes']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Archived 2 runs');
  });

  it('unarchive sends archived:false', async () => {
    cli.routes['POST /benchmarks/runs/archive'] = () => ({ body: { archived: 1, count: 1 } });
    const result = await cli.invoke(['runs', 'unarchive', RUN_1, '-y', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toEqual({ runIds: [RUN_1], archived: false });
    expect(stdoutJson(result)).toEqual({ archived: false, count: 1 });
  });

  it('prompts on a terminal before unarchiving', async () => {
    cli.setStdinTTY(true);
    prompt.answer = 'no';
    const result = await cli.invoke(['runs', 'unarchive', RUN_1]);
    expect(result.exitCode).toBe(1);
    expect(prompt.questions[0]).toContain('1 run');
    expect(cli.requests).toHaveLength(0);
  });

  it('needs at least one run id', async () => {
    const result = await cli.invoke(['runs', 'archive', '-y']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bench runs archive <runId...>');
    expect(cli.requests).toHaveLength(0);
  });

  it('takes at most 100 run ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const result = await cli.invoke(['runs', 'archive', ...ids, '-y']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('at most 100');
    expect(cli.requests).toHaveLength(0);
  });

  it('surfaces a run that could not be archived', async () => {
    cli.routes['POST /benchmarks/runs/archive'] = () => ({
      status: 400,
      body: { error: 'One or more runs could not be archived' },
    });
    const result = await cli.invoke(['runs', 'archive', RUN_1, '-y']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('One or more runs could not be archived');
  });
});

describe('bench runs list archive and mute filters', () => {
  const item = (id: string, archivedAt: string | null, benchmarkSlug = 'alpha') => ({
    id,
    benchmarkId: 'b-1',
    organizationId: 'org-a',
    benchmarkSlug,
    status: 'completed',
    totalTasks: 1,
    workerCount: 1,
    archivedAt,
  });

  it('sends --archived on a benchmark run list', async () => {
    cli.routes['GET /benchmarks/alpha/runs'] = () => ({
      body: { items: [item(RUN_1, '2026-11-06T00:00:00Z'), item(RUN_2, '2026-11-06T00:00:00Z')], filter: null, upgrade: null },
    });
    const result = await cli.invoke(['runs', 'list', 'alpha', '--archived', 'only', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('archived')).toBe('only');
    expect((stdoutJson(result) as { items: { id: string }[] }).items.map((r) => r.id)).toEqual([RUN_1, RUN_2]);
  });

  it('sends --archived and --include-muted on the cross-benchmark list', async () => {
    cli.routes['GET /benchmarks/runs'] = () => ({ body: { items: [item(RUN_1, null)] } });
    const result = await cli.invoke(['runs', 'list', '--archived', 'include', '--include-muted', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('archived')).toBe('include');
    expect(cli.requests[0].query.get('includeMuted')).toBe('1');
  });

  it('keeps muted runs by default: no includeMuted is sent without the flag', async () => {
    cli.routes['GET /benchmarks/runs'] = () => ({ body: { items: [item(RUN_1, null)] } });
    const result = await cli.invoke(['runs', 'list', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.has('includeMuted')).toBe(false);
  });

  it('rejects --include-muted with a benchmark slug before sending', async () => {
    const result = await cli.invoke(['runs', 'list', 'alpha', '--include-muted']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--include-muted applies to the cross-benchmark list');
    expect(cli.requests).toHaveLength(0);
  });
  it('fails loudly when --archived only comes back with unarchived runs', async () => {
    cli.routes['GET /benchmarks/runs'] = () => ({ body: { items: [item(RUN_1, null)] } });
    const result = await cli.invoke(['runs', 'list', '--archived', 'only', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('archived');
  });

  it('rejects an unknown --archived value before sending', async () => {
    const result = await cli.invoke(['runs', 'list', '--archived', 'all']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--archived must be one of exclude, include, only');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('API error envelopes', () => {
  it('prints the envelope message, code and hint', async () => {
    cli.routes['DELETE /benchmarks/rel-1/pause'] = () => ({
      status: 404,
      body: { error: 'Benchmark not found', code: 'not_found', hint: 'Check the slug with `bench benchmarks list`.' },
    });
    const result = await cli.invoke(['benchmarks', 'resume', 'rel-1']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('404');
    expect(result.stderr).toContain('Benchmark not found (code: not_found)');
    expect(result.stderr).toContain('Hint: Check the slug with `bench benchmarks list`.');
  });
});
