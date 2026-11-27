import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const ID = '33333333-3333-4333-8333-333333333333';

function exclusion(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    participant: 'vercel',
    start: '2026-11-25T21:25:00.000Z',
    end: '2026-11-27T16:20:00.000Z',
    reason: 'token rejected',
    benchmarks: null,
    createdAt: '2026-11-27T21:00:00.000Z',
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

describe('bench exclusions list', () => {
  it('GETs the org exclusions and narrows by --participant', async () => {
    cli.routes['GET /participants/exclusions'] = () => ({
      body: { exclusions: [exclusion(), exclusion({ id: 'other', participant: 'e2b' })] },
    });
    const result = await cli.invoke(['exclusions', 'list', '--participant', 'vercel', '--json']);
    expect(result.exitCode).toBe(0);
    expect(stdoutJson(result)).toEqual({ exclusions: [exclusion()] });
  });

  it('prints (all) for an org-wide exclusion in table output', async () => {
    cli.routes['GET /participants/exclusions'] = () => ({ body: { exclusions: [exclusion()] } });
    const result = await cli.invoke(['exclusions', 'list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(all)');
    expect(result.stdout).toContain(ID);
  });
});

describe('bench exclusions add', () => {
  const args = [
    'exclusions', 'add', '--participant', 'vercel',
    '--start', '2026-11-25T21:25:00Z', '--end', '2026-11-27T16:20:00Z', '--reason', 'token rejected',
  ];

  it('POSTs the window and omits benchmarks when none are given', async () => {
    cli.routes['POST /participants/exclusions'] = () => ({ status: 201, body: exclusion() });
    const result = await cli.invoke([...args, '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toEqual({
      participant: 'vercel',
      start: '2026-11-25T21:25:00Z',
      end: '2026-11-27T16:20:00Z',
      reason: 'token rejected',
    });
    expect(stdoutJson(result)).toMatchObject({ id: ID, benchmarks: null });
  });

  it('sends repeated and comma-separated --benchmark slugs', async () => {
    cli.routes['POST /participants/exclusions'] = () => ({ status: 201, body: exclusion({ benchmarks: ['a', 'b', 'c'] }) });
    const result = await cli.invoke([...args, '--benchmark', 'a,b', '--benchmark', 'c']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].body).toMatchObject({ benchmarks: ['a', 'b', 'c'] });
    expect(result.stdout).toContain('on a, b, c');
  });

  it('rejects a missing --reason, a bad timestamp or an empty window before sending', async () => {
    for (const bad of [
      args.slice(0, -2),
      [...args.slice(0, 5), 'tomorrow', ...args.slice(6)],
      [...args.slice(0, 7), '2026-11-25T21:25:00Z', ...args.slice(8)],
    ]) {
      const result = await cli.invoke(bad);
      expect(result.exitCode).toBe(1);
    }
    expect(cli.requests).toHaveLength(0);
  });

  it('adds the owner/admin hint to a 403', async () => {
    cli.routes['POST /participants/exclusions'] = () => ({
      status: 403,
      body: { error: 'forbidden', message: 'Only organization owners and admins can do this.' },
    });
    const result = await cli.invoke(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('owner or admin');
  });
});

describe('bench exclusions remove', () => {
  it('refuses without -y off a terminal and sends nothing', async () => {
    const result = await cli.invoke(['exclusions', 'remove', ID]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--yes');
    expect(cli.requests).toHaveLength(0);
  });

  it('DELETEs the exclusion with -y', async () => {
    cli.routes[`DELETE /participants/exclusions/${ID}`] = () => ({ body: { deleted: ID } });
    const result = await cli.invoke(['exclusions', 'remove', ID, '-y']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0]).toMatchObject({ method: 'DELETE', path: `/participants/exclusions/${ID}` });
    expect(result.stdout).toContain(`Removed exclusion ${ID}`);
  });

  it('requires an id', async () => {
    const result = await cli.invoke(['exclusions', 'remove', '-y']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Exclusion id required');
  });
});

it('rejects an unknown exclusions subcommand with its usage', async () => {
  const result = await cli.invoke(['exclusions', 'nope']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('bench exclusions add');
});
