import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: vi.fn(async () => null), loadCredentials: vi.fn(async () => null) };
});

import { createCliHarness, stdoutJson, type CliHarness } from './harness.js';

const RUN = '44444444-4444-4444-8444-444444444444';
const RUN_PATH = `/benchmarks/alpha/runs/${RUN}`;

const latency = { min: 1, avg: 2, p50: 2, p95: 3, p99: 3, max: 4 };

function overview() {
  return {
    run: { id: RUN, benchmarkSlug: 'alpha', label: 'e2b', status: 'finished', startedAt: '2026-11-01T12:00:00.000Z', completedAt: null },
    generatedAt: '2026-11-01T12:10:00.000Z',
    progress: { done: 10, inFlight: 0, errors: 1, total: 10 },
    overall: {
      taskCount: 10,
      successCount: 9,
      errorCount: 1,
      otherCount: 0,
      latencyCount: 10,
      successRate: 0.9,
      latencyMs: latency,
      firstStartedAt: null,
      lastCompletedAt: null,
    },
    customMetrics: { tokens: 12 },
    dimension: null,
    ranking: {
      rankBy: { value: 'task', type: 'task', label: 'Task', direction: 'lower-better', stat: 'median' },
      defaultRankBy: 'task',
      dimension: null,
      options: [
        { type: 'task', value: 'task', label: 'Task' },
        { type: 'metric', value: 'tokens', key: 'tokens', label: 'tokens' },
      ],
      participants: [
        {
          rank: 1,
          participantSlug: 'e2b',
          provider: 'e2b',
          displayName: null,
          dimension: null,
          value: 2,
          status: 'finished',
          taskCount: 10,
          successCount: 9,
          errorCount: 1,
          otherCount: 0,
          successRate: 0.9,
          latencyMs: latency,
          compositeScore: null,
          customMetrics: { tokens: 12 },
        },
      ],
    },
  };
}

let cli: CliHarness & { restore(): void };

beforeEach(() => {
  cli = createCliHarness();
});

afterEach(() => {
  cli.restore();
});

describe('bench benchmarks list directory flags', () => {
  it('sends sort, order, group, category, owner and q', async () => {
    cli.routes['GET /benchmarks'] = () => ({ body: { items: [] } });
    const result = await cli.invoke([
      'benchmarks', 'list', '--sort', 'runs', '--order', 'asc', '--group', 'stealth',
      '--category', 'sandbox', '--category', 'ai,llm', '--owner', 'acme', '--q', 'cold', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const query = cli.requests[0].query;
    expect(Object.fromEntries(query)).toEqual({
      sort: 'runs', order: 'asc', group: 'stealth', category: 'sandbox,ai,llm', owner: 'acme', q: 'cold',
    });
  });

  it('rejects an unknown sort and --order without --sort before sending', async () => {
    expect((await cli.invoke(['benchmarks', 'list', '--sort', 'stars'])).stderr).toContain('--sort must be one of');
    expect((await cli.invoke(['benchmarks', 'list', '--order', 'asc'])).stderr).toContain('--order needs --sort');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench runs show', () => {
  beforeEach(() => {
    cli.routes[`GET ${RUN_PATH}`] = () => ({ body: { run: { id: RUN, status: 'finished' } } });
  });

  it('adds the overview to the run and passes the ranking flags', async () => {
    cli.routes[`GET ${RUN_PATH}/overview`] = () => ({ body: overview() });
    const result = await cli.invoke(['runs', 'show', 'alpha', RUN, '--rank-by', 'tokens', '--stat', 'max', '--json']);
    expect(result.exitCode).toBe(0);
    const request = cli.requests.find((r) => r.path.endsWith('/overview'))!;
    expect(Object.fromEntries(request.query)).toEqual({ rankBy: 'tokens', stat: 'max' });
    const printed = stdoutJson(result) as { overview: { ranking: { participants: unknown[] } } };
    expect(printed.overview.ranking.participants).toHaveLength(1);
  });

  it('prints the ranking table', async () => {
    cli.routes[`GET ${RUN_PATH}/overview`] = () => ({ body: overview() });
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['runs', 'show', 'alpha', RUN]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ranked by Task (median, lower-better)');
    expect(result.stdout).toContain('Custom metrics (median): tokens=12');
    const rows = table.mock.calls.at(-1)![0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ rank: 1, participant: 'e2b', value: 2, tokens: 12 });
  });

  it('prints overview null when the platform has no overview route', async () => {
    const result = await cli.invoke(['runs', 'show', 'alpha', RUN, '--json']);
    expect(result.exitCode).toBe(0);
    expect(stdoutJson(result)).toMatchObject({ overview: null });
  });

  it('fails when an overview flag was given and the overview is unavailable', async () => {
    cli.routes[`GET ${RUN_PATH}/overview`] = () => ({ status: 503, body: { error: 'analytics_unavailable' } });
    const result = await cli.invoke(['runs', 'show', 'alpha', RUN, '--stat', 'p95', '--json']);
    expect(result.exitCode).toBe(1);
  });

  it('rejects an unknown --stat before sending', async () => {
    const result = await cli.invoke(['runs', 'show', 'alpha', RUN, '--stat', 'avg']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--stat must be one of min, median, p95, p99, max');
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench results --timeline / --tasks', () => {
  it('reads the timeline with --bucket-ms', async () => {
    const body = {
      run: { id: RUN },
      generatedAt: 'x',
      eventRate: { bucketMs: 500, buckets: [] },
      concurrency: { firstRecordedAt: null, heartbeatCount: 0, points: [] },
    };
    cli.routes[`GET ${RUN_PATH}/results/timeline`] = () => ({ body });
    const result = await cli.invoke(['results', 'alpha', '--run', RUN, '--timeline', '--bucket-ms', '500', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('bucketMs')).toBe('500');
    expect(stdoutJson(result)).toEqual(body);
  });

  it('reads task buckets with --bucket-size and --failure-limit', async () => {
    const body = { run: { id: RUN }, generatedAt: 'x', bucketSize: 5, buckets: [], failures: [] };
    cli.routes[`GET ${RUN_PATH}/results/tasks`] = () => ({ body });
    const result = await cli.invoke([
      'results', 'alpha', '--run', RUN, '--tasks', '--bucket-size', '5', '--failure-limit', '20', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(Object.fromEntries(cli.requests[0].query)).toEqual({ bucketSize: '5', failureLimit: '20' });
  });

  it.each([
    [['--timeline'], '--timeline needs --run <id>'],
    [['--run', RUN, '--timeline', '--tasks'], 'separate views'],
    [['--run', RUN, '--bucket-ms', '5'], '--bucket-ms needs --timeline'],
    [['--run', RUN, '--tasks', '--participant', 'e2b'], '--participant does not apply to --tasks'],
  ])('rejects %j before sending', async (flags, message) => {
    const result = await cli.invoke(['results', 'alpha', ...flags]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(cli.requests).toHaveLength(0);
  });

  it('prints custom metric medians under a single run', async () => {
    cli.routes[`GET ${RUN_PATH}/results`] = () => ({
      body: {
        run: { id: RUN, status: 'finished' },
        overall: overview().overall,
        participants: [],
        steps: [],
        customMetrics: { overall: { tokens: 12 }, participants: [{ participantSlug: 'e2b', metrics: { tokens: 11 } }] },
      },
    });
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['results', 'alpha', '--run', RUN]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Custom metrics (median):');
    expect(table.mock.calls.at(-1)![0]).toEqual([
      { participant: '(run)', tokens: 12 },
      { participant: 'e2b', tokens: 11 },
    ]);
  });
});

describe('bench iterations --type', () => {
  it('reads task iterations with --type tasks', async () => {
    cli.routes[`GET ${RUN_PATH}/iterations`] = () => ({
      body: {
        run: { id: RUN },
        generatedAt: 'x',
        tasks: [
          { participantSlug: 'e2b', provider: 'e2b', taskIndex: 0, status: 'success', latencyMs: 5, startedAt: null, completedAt: null, data: { region: 'us' } },
        ],
      },
    });
    const result = await cli.invoke(['iterations', 'alpha', '--run', RUN, '--type', 'tasks', '--participant', 'e2b', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('type')).toBe('tasks');
    expect(cli.requests[0].query.get('participant')).toBe('e2b');
    expect(stdoutJson(result)).toEqual([
      { participantSlug: 'e2b', taskIndex: 0, status: 'success', latencyMs: 5, startedAt: null, completedAt: null, region: 'us' },
    ]);
  });

  it('rejects --steps with --type tasks and an unknown type', async () => {
    expect((await cli.invoke(['iterations', 'alpha', '--run', RUN, '--type', 'tasks', '--steps', 'a'])).stderr).toContain(
      '--steps applies to --type steps only',
    );
    expect((await cli.invoke(['iterations', 'alpha', '--run', RUN, '--type', 'events'])).stderr).toContain(
      '--type must be one of steps, tasks',
    );
    expect(cli.requests).toHaveLength(0);
  });
});

describe('bench workers', () => {
  it('lists GET …/workers with --participant and prints the items', async () => {
    const worker = {
      workerIndex: 0,
      workerId: 'w-1',
      participantSlug: 'e2b',
      displayName: 'E2B',
      provider: 'e2b',
      color: '#000',
      status: 'completed',
      taskIndexStart: 0,
      taskIndexEnd: 9,
      progressDone: 10,
      progressInFlight: 0,
      progressErrors: 0,
      progressTotal: 10,
      artifacts: [],
    };
    cli.routes[`GET ${RUN_PATH}/workers`] = () => ({ body: { run: { id: RUN }, items: [worker] } });
    const result = await cli.invoke(['workers', 'alpha', RUN, '--participant', 'e2b', '--json']);
    expect(result.exitCode).toBe(0);
    expect(cli.requests[0].query.get('participant')).toBe('e2b');
    expect(stdoutJson(result)).toEqual([worker]);
  });

  it('needs the run id', async () => {
    const result = await cli.invoke(['workers', 'alpha']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Usage: bench workers <benchmark-slug> <runId>');
  });
});

describe('bench matrix and model-index', () => {
  it('reads a foreign matrix with --source-org', async () => {
    const body = {
      benchmark: { id: 'b', slug: 'alpha', name: 'Alpha', tagline: null, description: null },
      run: { id: RUN, name: null, startedAt: 's', completedAt: null },
      generatedAt: 'g',
      upgrade: null,
      spec: { cell: { unit: 'ms', decimals: 1, direction: 'lower-better' }, highlight: 'none' },
      dataset: { version: 1, rows: [{ key: 'r', label: 'Row' }], participants: [{ key: 'p', label: 'P' }], cells: { r: { p: { value: 1.25, state: 'data' } } } },
    };
    cli.routes['GET /benchmarks/~/computesdk/alpha/matrix'] = () => ({ body });
    const json = await cli.invoke(['matrix', 'alpha', '--source-org', 'computesdk', '--json']);
    expect(json.exitCode).toBe(0);
    expect(stdoutJson(json)).toEqual(body);

    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    const result = await cli.invoke(['matrix', 'alpha', '--source-org', 'computesdk']);
    expect(result.exitCode).toBe(0);
    expect(table.mock.calls.at(-1)![0]).toEqual([{ row: 'Row', P: 1.3 }]);
  });

  it('reads the model index', async () => {
    const body = {
      benchmark: { id: 'b', slug: 'models', name: 'Models' },
      run: { id: RUN, startedAt: 's', completedAt: null },
      generatedAt: 'g',
      upgrade: null,
      matrix: { timestamp: 't', gateways: [], rows: [], authors: [] },
    };
    cli.routes['GET /benchmarks/models/model-index'] = () => ({ body });
    const result = await cli.invoke(['model-index', 'models', '--json']);
    expect(result.exitCode).toBe(0);
    expect(stdoutJson(result)).toEqual(body);
  });
});

describe('bench artifacts download', () => {
  const ARTIFACT_PATH = `${RUN_PATH}/workers/w-1/artifacts/a-1`;
  const BLOB = 'https://blob.example/a-1?sig=1';
  const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff]);

  beforeEach(() => {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === BLOB ? new Response(bytes) : inner(input, init)) as typeof fetch;
  });

  function artifact(contentType: string) {
    cli.routes[`GET ${ARTIFACT_PATH}`] = () => ({
      body: { artifact: { id: 'a-1', kind: 'log', name: 'worker.log.gz', contentType }, downloadUrl: BLOB },
    });
  }

  it('writes the stored bytes to --out unchanged', async () => {
    artifact('application/gzip');
    const out = join(await mkdtemp(join(tmpdir(), 'bench-artifact-')), 'worker.log.gz');
    const result = await cli.invoke(['artifacts', 'download', 'alpha', RUN, 'w-1', 'a-1', '--out', out, '--json']);
    expect(result.exitCode).toBe(0);
    expect(new Uint8Array(await readFile(out))).toEqual(bytes);
    expect(stdoutJson(result)).toMatchObject({ path: out, bytes: 5, artifact: { id: 'a-1' } });
  });

  it('writes to stdout without --out', async () => {
    artifact('text/plain');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, done?: () => void) => {
      done?.();
      return true;
    }) as typeof process.stdout.write);
    const result = await cli.invoke(['artifacts', 'download', 'alpha', RUN, 'w-1', 'a-1']);
    expect(result.exitCode).toBe(0);
    expect(write).toHaveBeenCalledWith(bytes, expect.any(Function));
  });

  it('waits for a backpressured stdout to take the bytes before returning', async () => {
    artifact('text/plain');
    let flush: (() => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, done?: () => void) => {
      flush = done;
      return false;
    }) as typeof process.stdout.write);
    let finished = false;
    const pending = cli.invoke(['artifacts', 'download', 'alpha', RUN, 'w-1', 'a-1']).then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(flush).toBeDefined());
    expect(finished).toBe(false);
    flush!();
    expect((await pending).exitCode).toBe(0);
  });

  it('needs every id and --out with --json', async () => {
    expect((await cli.invoke(['artifacts', 'download', 'alpha', RUN, 'w-1'])).stderr).toContain(
      'Usage: bench artifacts download',
    );
    expect((await cli.invoke(['artifacts', 'download', 'alpha', RUN, 'w-1', 'a-1', '--json'])).stderr).toContain(
      'pass --out <file>',
    );
    expect(cli.requests).toHaveLength(0);
  });

  it('rejects --out on artifacts list', async () => {
    const result = await cli.invoke(['artifacts', 'list', 'alpha', RUN, '--out', '/tmp/x']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option for this command: --out');
  });
});
