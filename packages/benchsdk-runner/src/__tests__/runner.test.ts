import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createBenchmarkClient = vi.fn();
const runWorker = vi.fn();
const reporterClaim = vi.fn();

vi.mock('@benchsdk/api', () => ({
  createBenchmarkClient: (...args: unknown[]) => createBenchmarkClient(...args),
}));

vi.mock('@benchsdk/worker', () => ({
  BenchmarkReporter: { claim: (...args: unknown[]) => reporterClaim(...args) },
  createSystemMetricsCollector: () => ({
    sample: () => ({ ts: new Date().toISOString() }),
    stop: () => {},
  }),
  filterParticipantsByEnv: (ps: any[]) => {
    const available: any[] = [];
    const skipped: { name: string; missing: string[] }[] = [];
    for (const p of ps) {
      const missing = (p.requiredEnvVars as string[]).filter((v) => !process.env[v]);
      if (missing.length) skipped.push({ name: p.name, missing });
      else available.push(p);
    }
    return { available, skipped };
  },
  runWorker: (...args: unknown[]) => runWorker(...args),
  selectParticipants: (all: any[], names?: string[]) => (names ? all.filter((p) => names.includes(p.name)) : all),
}));

vi.mock('@benchsdk/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('@benchsdk/cli')>();
  return {
    ...original,
    resolveAuth: vi.fn(),
  };
});

import { parseCliArgs, mergeConfig, runBenchmark } from '../runner';
import { TaskError, defineTask } from '../bench-config';
import { NoAvailableParticipantsError } from '../no-available-participants';
import { resolveAuth, AuthError } from '@benchsdk/cli';
import type { CliAuth } from '@benchsdk/cli';
import type { BenchmarkConfig } from '../bench-config';
import type { TaskResultRecord } from '@benchsdk/api';

describe('parseCliArgs', () => {
  it('parses space-separated flags', () => {
    expect(parseCliArgs(['--iterations', '10', '--concurrency', '4', '--stagger-delay-ms', '250'])).toEqual({
      iterations: 10,
      concurrency: 4,
      staggerDelayMs: 250,
    });
  });

  it('parses = separated flags', () => {
    expect(parseCliArgs(['--iterations=7', '--concurrency=2'])).toEqual({ iterations: 7, concurrency: 2 });
  });

  it('parses comma-separated and repeated --provider', () => {
    expect(parseCliArgs(['--provider', 'e2b,modal', '--provider', 'daytona'])).toEqual({
      providers: ['e2b', 'modal', 'daytona'],
    });
  });

  it('parses --group-by', () => {
    expect(parseCliArgs(['--group-by', 'round'])).toEqual({ groupBy: 'round' });
    expect(parseCliArgs(['--group-by=participant'])).toEqual({ groupBy: 'participant' });
  });

  it('parses --benchmark (and its --slug alias) and --name', () => {
    expect(parseCliArgs(['--benchmark', 'sandbox-burst-local'])).toEqual({ benchmark: 'sandbox-burst-local' });
    expect(parseCliArgs(['--benchmark=sandbox-tti-local'])).toEqual({ benchmark: 'sandbox-tti-local' });
    expect(parseCliArgs(['--slug', 'sandbox-burst-local'])).toEqual({ benchmark: 'sandbox-burst-local' });
    expect(parseCliArgs(['--name', 'Sandbox burst TTI'])).toEqual({ name: 'Sandbox burst TTI' });
    expect(() => parseCliArgs(['--name', ' '])).toThrow('--name');
  });

  it('parses --shape and --run-key', () => {
    expect(parseCliArgs(['--shape', 'burst'])).toEqual({ shape: 'burst' });
    expect(parseCliArgs(['--run-key=ci-123'])).toEqual({ runKey: 'ci-123' });
    expect(() => parseCliArgs(['--shape', ''])).toThrow('--shape');
    expect(() => parseCliArgs(['--run-key', ''])).toThrow('--run-key');
  });

  it('throws on a non-slug --benchmark', () => {
    expect(() => parseCliArgs(['--benchmark', 'Sandbox TTI'])).toThrow('--benchmark');
    expect(() => parseCliArgs(['--slug', ''])).toThrow('--slug');
  });

  it('throws on invalid --group-by', () => {
    expect(() => parseCliArgs(['--group-by', 'nope'])).toThrow('--group-by');
  });

  it('throws on unknown flags', () => {
    expect(() => parseCliArgs(['--unknown', 'x', '--iterations', '3'])).toThrow('Unknown flag');
  });

  it('allows declared custom pass-through flags and their values', () => {
    expect(parseCliArgs(['--file-size', '10MB', '--iterations', '3'], ['--file-size'])).toEqual({
      iterations: 3,
    });
    expect(parseCliArgs(['--file-size=10MB', '--iterations', '3'], ['--file-size'])).toEqual({
      iterations: 3,
    });
  });

  it('still throws when a pass-through-style flag is not declared', () => {
    expect(() => parseCliArgs(['--file-size', '10MB'])).toThrow('Unknown flag');
  });

  it('throws on non-numeric numeric flags', () => {
    expect(() => parseCliArgs(['--iterations', 'abc'])).toThrow('--iterations');
  });

  it('throws on empty, negative, or non-integer iterations/concurrency', () => {
    expect(() => parseCliArgs(['--iterations', ''])).toThrow('--iterations');
    expect(() => parseCliArgs(['--iterations', '-3'])).toThrow('--iterations');
    expect(() => parseCliArgs(['--iterations', '1.5'])).toThrow('--iterations');
    expect(() => parseCliArgs(['--concurrency', '0'])).toThrow('--concurrency');
  });

  it('throws on negative stagger delay', () => {
    expect(() => parseCliArgs(['--stagger-delay-ms', '-1'])).toThrow('--stagger-delay-ms');
  });

  it('returns empty object for no args', () => {
    expect(parseCliArgs([])).toEqual({});
  });

  it('parses --no-ingest and --dry-run', () => {
    expect(parseCliArgs(['--no-ingest'])).toEqual({ noIngest: true });
    expect(parseCliArgs(['--dry-run'])).toEqual({ noIngest: true });
  });

  it('honors BENCHSDK_NO_INGEST=1', () => {
    process.env.BENCHSDK_NO_INGEST = '1';
    try {
      expect(parseCliArgs([])).toEqual({ noIngest: true });
      expect(parseCliArgs(['--iterations', '5'])).toEqual({ noIngest: true, iterations: 5 });
    } finally {
      delete process.env.BENCHSDK_NO_INGEST;
    }
  });
});

describe('mergeConfig', () => {
  const config: BenchmarkConfig = {
    benchmarkSlug: 's',
    benchmarkName: 'n',
    iterations: 100,
    concurrency: 1,
    staggerDelayMs: 0,
    participants: [],
  };

  it('uses config defaults when no CLI args', () => {
    expect(mergeConfig(config, {})).toEqual({ iterations: 100, concurrency: 1, staggerDelayMs: 0, groupBy: 'participant', providers: undefined });
  });

  it('lets CLI args win over config', () => {
    expect(mergeConfig(config, { iterations: 5, concurrency: 5, staggerDelayMs: 200, groupBy: 'round', providers: ['e2b'] })).toEqual({
      iterations: 5,
      concurrency: 5,
      staggerDelayMs: 200,
      groupBy: 'round',
      providers: ['e2b'],
    });
  });

  it('falls back to knob defaults of 1/1/0/participant when neither config nor CLI set them', () => {
    const bare: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', participants: [] };
    expect(mergeConfig(bare, {})).toEqual({ iterations: 1, concurrency: 1, staggerDelayMs: 0, groupBy: 'participant', providers: undefined });
  });

  it('uses config.groupBy when CLI does not set it', () => {
    const rr: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', groupBy: 'round', participants: [] };
    expect(mergeConfig(rr, {}).groupBy).toBe('round');
  });

  it('falls back to config.defaultProviders when --provider is not passed', () => {
    const withDefaults: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', defaultProviders: ['e2b'], participants: [] };
    expect(mergeConfig(withDefaults, {}).providers).toEqual(['e2b']);
    expect(mergeConfig(withDefaults, { providers: ['modal'] }).providers).toEqual(['modal']);
  });

  it('derives iterations from phases (sum), and applies --iterations to each phase', () => {
    const phased: BenchmarkConfig = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      phases: [{ name: '1MB', iterations: 2 }, { name: '16MB', iterations: 2 }],
      participants: [],
    };
    expect(mergeConfig(phased, {})).toMatchObject({ iterations: 4, phaseIterations: undefined });
    // Phases are the arms of one comparison, so the flag scales every arm
    // rather than being split between them.
    expect(mergeConfig(phased, { iterations: 10 })).toMatchObject({ iterations: 20, phaseIterations: 10 });
  });

  it('keeps individually sized phases over --iterations, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const phased: BenchmarkConfig = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      phases: [{ name: 'cold', iterations: 3 }, { name: 'warm', iterations: 2 }],
      participants: [],
    };
    expect(mergeConfig(phased, { iterations: 99 })).toMatchObject({ iterations: 5, phaseIterations: undefined });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('runBenchmark', () => {
  const participants = [
    { name: 'e2b', requiredEnvVars: ['E2B_API_KEY'] },
    { name: 'modal', requiredEnvVars: ['MODAL_TOKEN'] },
  ];

  let calls: Record<string, any[]>;
  let fakeClient: any;
  let taskRangeStart: number;

  beforeEach(() => {
    taskRangeStart = 0;
    vi.restoreAllMocks();
    reporterClaim.mockReset();
    runWorker.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.E2B_API_KEY = 'x';
    process.env.MODAL_TOKEN = 'y';
    process.env.BENCHMARKS_PLATFORM_API_KEY = 'test-key';
    calls = { upsertBenchmark: [], createRun: [], planWorkers: [], upsertParticipant: [], getRun: [], runWorker: [], taskData: [], submitRunSummary: [] };
    fakeClient = {
      upsertBenchmark: vi.fn(async (...a: any[]) => { calls.upsertBenchmark.push(a); return {}; }),
      createRun: vi.fn(async (...a: any[]) => { calls.createRun.push(a); return { run: { id: 'run-1' }, participants: [] }; }),
      planWorkers: vi.fn(async (...a: any[]) => { calls.planWorkers.push(a); return []; }),
      upsertParticipant: vi.fn(async (...a: any[]) => { calls.upsertParticipant.push(a); return {}; }),
      submitRunSummary: vi.fn(async (...a: any[]) => { calls.submitRunSummary.push(a); }),
      getRun: vi.fn(async (slug: string, runId: string) => {
        calls.getRun.push([slug, runId]);
        return { id: runId, totalTasks: 3, participantSized: runId === 'run-open' };
      }),
    };
    runWorker.mockImplementation(async (_client: any, opts: any) => {
      calls.runWorker.push(opts);
      const total = calls.createRun[0]?.[1]?.totalTasks ?? calls.upsertParticipant[0]?.[3]?.totalTasks ?? 1;
      // The platform hands out globally-indexed task ranges; `taskRangeStart`
      // lets a test exercise a worker whose range doesn't start at 0.
      const start = taskRangeStart;
      const assignment = { workerId: 'w1', taskRange: { start, end: start + total - 1, count: total } };
      const records: any[] = [];
      for (let ti = start; ti < start + total; ti++) {
        // Mirror the real client worker: `measure` merges into the record's
        // data alongside whatever the task returns. `step` records options
        // so participant-mode option forwarding can be asserted.
        const measures: Record<string, unknown> = {};
        const steps: any[] = [];
        const ctx = {
          taskIndex: ti,
          assignment,
          step: async (_n: string, fn: any, options: any) => {
            const value = await fn();
            steps.push({ name: _n, options });
            return value;
          },
          measure: (d: Record<string, unknown>) => Object.assign(measures, d),
          log: () => {},
        };
        const returned = await opts.task(ctx);
        calls.taskData.push(returned);
        const data = { ...measures, ...(returned ?? {}) };
        const rec = { taskIndex: ti, status: 'success', data, steps };
        opts.onResult?.(rec);
        records.push(rec);
      }
      return { assignment, records };
    });
    createBenchmarkClient.mockReturnValue(fakeClient);
    vi.mocked(resolveAuth).mockImplementation(async () => {
      const token = process.env.BENCHMARKS_PLATFORM_TOKEN;
      const apiKey = process.env.BENCHMARKS_PLATFORM_API_KEY;
      if (!token && !apiKey) {
        throw new AuthError('No credentials found');
      }
      return {
        apiBaseUrl: 'https://platform.computesdk.com/api/v1',
        baseUrl: 'https://platform.computesdk.com',
        authBaseUrl: 'https://platform.computesdk.com/auth',
        format: 'table',
        apiKey: token ? undefined : apiKey,
        token: token || undefined,
        orgSlug: process.env.BENCHMARKS_TEST_ORG_SLUG,
        orgId: process.env.BENCHMARKS_TEST_ORG_ID,
      } as CliAuth;
    });
  });

  afterEach(() => {
    delete process.env.E2B_API_KEY;
    delete process.env.MODAL_TOKEN;
    delete process.env.BENCHMARKS_PLATFORM_API_KEY;
    delete process.env.BENCHMARKS_PLATFORM_TOKEN;
    delete process.env.BENCHMARKS_TEST_ORG_SLUG;
    delete process.env.BENCHMARKS_TEST_ORG_ID;
    delete process.env.BENCHSDK_NO_INGEST;
  });

  it('drives upsert -> createRun -> planWorkers/runWorker per available participant', async () => {
    const task = vi.fn(async () => ({ data: { ttiMs: 42 } }));
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      iterations: 3,
      concurrency: 1,
      participants,
    };

    const outcome = await runBenchmark(config, defineTask(task), []);

    expect(outcome.runId).toBe('run-1');
    expect(outcome.participants.map((p) => p.participant)).toEqual(['e2b', 'modal']);
    expect(outcome.participants[0].records).toHaveLength(3);
    expect(outcome.participants[1].records).toHaveLength(3);

    expect(calls.upsertBenchmark[0][0]).toBe('sandbox-tti-local');
    expect(calls.upsertBenchmark[0][1]).toMatchObject({ name: 'Sandbox TTI' });
    expect(calls.createRun[0][1]).toMatchObject({ totalTasks: 3, workerCount: 1, participants: ['e2b', 'modal'] });
    expect(calls.planWorkers).toHaveLength(2);
    expect(calls.runWorker).toHaveLength(2);
    expect(calls.runWorker[0].concurrency).toBe(1);
    // The runner's task wrapper forwards participant/taskIndex/phase + the
    // client-owned step/measure/log onto config.task.
    expect(task).toHaveBeenCalledWith(
      expect.objectContaining({ participant: participants[0], taskIndex: 0, step: expect.any(Function), measure: expect.any(Function), log: expect.any(Function) }),
    );
    // The wrapper returns the task's `data` payload to the platform worker.
    expect(calls.taskData[0]).toEqual({ ttiMs: 42 });
  });

  it('calls config.onComplete once with the run outcome', async () => {
    const onComplete = vi.fn();
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 2,
      concurrency: 1,
      participants: [participants[0]],
      onComplete,
    };

    const outcome = await runBenchmark(config, defineTask(async () => ({})), []);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(outcome);
    expect(outcome.config).toMatchObject({ iterations: 2, concurrency: 1 });
  });

  it('calls config.onScore and submits a run summary before onComplete', async () => {
    const onScore = vi.fn((lowerIsBetter) => ({
      metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 1000, weights: { median: 1, p95: 0, p99: 0 } })],
    }));
    const onComplete = vi.fn();
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 2,
      concurrency: 1,
      participants: [participants[0]],
      onScore,
      onComplete,
    };

    const outcome = await runBenchmark(config, defineTask(async () => ({ data: { ttiMs: 100 } })), []);

    expect(onScore).toHaveBeenCalledTimes(1);
    expect(onScore).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
    expect(calls.submitRunSummary).toHaveLength(1);
    expect(calls.submitRunSummary[0][0]).toBe('s');
    expect(calls.submitRunSummary[0][1]).toBe('run-1');
    expect(calls.submitRunSummary[0][2]).toMatchObject({
      run: expect.objectContaining({
        gitSha: expect.any(String),
        nodeVersion: expect.any(String),
        platform: expect.any(String),
        arch: expect.any(String),
      }),
      results: expect.arrayContaining([
        expect.objectContaining({
          provider: 'e2b',
          metrics: expect.arrayContaining([expect.objectContaining({ name: 'ttiMs', unit: 'ms' })]),
          compositeScore: expect.any(Number),
          successRate: expect.any(Number),
          skipped: false,
        }),
      ]),
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(outcome);
  });

  it('propagates a ScoringSpecError from a misconfigured onScore instead of swallowing it as a warning', async () => {
    // weights sum to 0.5, not 1.0 — an authoring bug in onScore, not a
    // transient submit failure, so runBenchmark must reject rather than warn
    // and continue to onComplete.
    const onScore = vi.fn((lowerIsBetter) => ({
      metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 1000, weights: { median: 0.5, p95: 0, p99: 0 } })],
    }));
    const onComplete = vi.fn();
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 2,
      concurrency: 1,
      participants: [participants[0]],
      onScore,
      onComplete,
    };

    await expect(
      runBenchmark(config, defineTask(async () => ({ data: { ttiMs: 100 } })), []),
    ).rejects.toThrow('Scoring spec weights sum to');
    expect(calls.submitRunSummary).toHaveLength(0);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('still warns and continues when submitRunSummary itself fails (not a scoring config bug)', async () => {
    fakeClient.submitRunSummary = vi.fn(async () => {
      throw new Error('network blip');
    });
    const onScore = vi.fn((lowerIsBetter) => ({
      metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 1000, weights: { median: 1, p95: 0, p99: 0 } })],
    }));
    const onComplete = vi.fn();
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 2,
      concurrency: 1,
      participants: [participants[0]],
      onScore,
      onComplete,
    };

    const outcome = await runBenchmark(config, defineTask(async () => ({ data: { ttiMs: 100 } })), []);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(outcome);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('network blip'));
  });

  it('applies CLI overrides over config', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 100,
      concurrency: 1,
      participants,
    };

    await runBenchmark(config, defineTask(async () => ({})), ['--iterations', '5', '--concurrency', '5', '--provider', 'e2b']);

    expect(calls.createRun[0][1]).toMatchObject({ totalTasks: 5, participants: ['e2b'] });
    expect(calls.runWorker).toHaveLength(1);
    expect(calls.runWorker[0].concurrency).toBe(5);
  });

  it('reports under --slug/--name instead of the config slug and name', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      iterations: 1,
      participants: [participants[0]],
    };

    await runBenchmark(config, defineTask(async () => ({})), [
      '--slug',
      'sandbox-burst-local',
      '--name',
      'Sandbox burst TTI',
    ]);

    expect(calls.upsertBenchmark[0][0]).toBe('sandbox-burst-local');
    expect(calls.upsertBenchmark[0][1]).toMatchObject({ name: 'Sandbox burst TTI' });
    expect(calls.createRun[0][0]).toBe('sandbox-burst-local');
  });

  it('shares a run by --run-key: get-or-creates it keyed, then registers only its own participant', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      iterations: 2,
      participants: [participants[0]],
    };

    const outcome = await runBenchmark(config, defineTask(async () => ({})), ['--run-key', 'ci-123', '--provider', 'e2b']);

    // The benchmark is still materialized from the file identity.
    expect(calls.upsertBenchmark[0][0]).toBe('sandbox-tti-local');
    // One keyed get-or-create, carrying the key and no size/participant list.
    expect(calls.createRun).toHaveLength(1);
    expect(calls.createRun[0][1]).toMatchObject({ runKey: 'ci-123' });
    expect(calls.createRun[0][1].totalTasks).toBeUndefined();
    expect(calls.createRun[0][1].participants).toBeUndefined();
    // Registers only the provider it runs, sized to its own iteration count.
    expect(calls.upsertParticipant[0].slice(0, 3)).toEqual(['sandbox-tti-local', 'run-1', 'e2b']);
    expect(calls.upsertParticipant[0][3]).toMatchObject({ totalTasks: 2 });
    expect(calls.runWorker[0]).toMatchObject({ runId: 'run-1' });
    expect(outcome.runId).toBe('run-1');
    expect(outcome.participants[0].records).toHaveLength(2);
  });

  it('does not rename a benchmark it was merely retargeted at', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      iterations: 1,
      participants: [participants[0]],
    };

    await runBenchmark(config, defineTask(async () => ({})), ['--benchmark', 'sandbox-burst-local']);
    expect(calls.upsertBenchmark).toEqual([]);

    await runBenchmark(config, defineTask(async () => ({})), [
      '--benchmark',
      'sandbox-burst-local',
      '--name',
      'Sandbox burst TTI',
    ]);
    expect(calls.upsertBenchmark[0]).toEqual(['sandbox-burst-local', { name: 'Sandbox burst TTI' }]);
  });

  it('selects a declared shape by --shape, reporting under its slug and name', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      iterations: 1,
      participants: [participants[0]],
      shapes: {
        staggered: { slug: 'sandbox-staggered-local', name: 'Sandbox staggered TTI', staggerDelayMs: 200 },
      },
    };

    const outcome = await runBenchmark(config, defineTask(async () => ({})), ['--shape', 'staggered']);

    expect(calls.upsertBenchmark[0][0]).toBe('sandbox-staggered-local');
    expect(calls.upsertBenchmark[0][1]).toMatchObject({ name: 'Sandbox staggered TTI' });
    expect(calls.createRun[0][0]).toBe('sandbox-staggered-local');
    // The shape's stable knob applies; scale knobs stay defaulted/overridable.
    expect(outcome.config.staggerDelayMs).toBe(200);
  });

  it('rejects an unknown --shape, listing the declared ones', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      participants: [participants[0]],
      shapes: { burst: { slug: 'sandbox-burst-local' } },
    };

    await expect(
      runBenchmark(config, defineTask(async () => ({})), ['--shape', 'nope']),
    ).rejects.toThrow('Known shapes: burst');
  });

  it('throws NoAvailableParticipantsError, listing the skips, when no participant has its env vars set', async () => {
    delete process.env.E2B_API_KEY;
    delete process.env.MODAL_TOKEN;

    const err = await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', participants },
      defineTask(async () => ({})),
      [],
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoAvailableParticipantsError);
    expect((err as NoAvailableParticipantsError).skipped).toEqual([
      { name: 'e2b', missing: ['E2B_API_KEY'] },
      { name: 'modal', missing: ['MODAL_TOKEN'] },
    ]);
    expect(createBenchmarkClient).toHaveBeenCalled();
  });

  it('throws AuthError before checking participants when no platform credentials are set', async () => {
    delete process.env.BENCHMARKS_PLATFORM_API_KEY;
    delete process.env.BENCHMARKS_PLATFORM_TOKEN;

    const err = await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', participants },
      defineTask(async () => ({})),
      [],
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AuthError);
  });

  it('participant mode: tags data.phase from the schedule via measure', async () => {
    const seenPhases: (string | undefined)[] = [];
    const task = vi.fn(async (ctx: any) => {
      seenPhases.push(ctx.phase);
      return { data: { i: ctx.taskIndex } };
    });

    const outcome = await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        participants: [participants[0]],
      },
      defineTask(task),
      [],
    );

    expect(calls.createRun[0][1].totalTasks).toBe(3);
    expect(seenPhases).toEqual(['cold', 'cold', 'warm']);
    // Phase now rides the measure channel, so it lands on the record data.
    expect(outcome.participants[0].records.map((r) => r.data)).toEqual([
      { i: 0, phase: 'cold' },
      { i: 1, phase: 'cold' },
      { i: 2, phase: 'warm' },
    ]);
  });

  it('participant mode: --iterations runs that many iterations of every phase', async () => {
    const seenPhases: (string | undefined)[] = [];
    const task = vi.fn(async (ctx: any) => {
      seenPhases.push(ctx.phase);
      return {};
    });

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: '1MB', iterations: 2 }, { name: '16MB', iterations: 2 }],
        participants: [participants[0]],
      },
      defineTask(task),
      ['--iterations', '3'],
    );

    expect(calls.createRun[0][1].totalTasks).toBe(6);
    expect(seenPhases).toEqual(['1MB', '1MB', '1MB', '16MB', '16MB', '16MB']);
  });

  it('participant mode: a failing task keeps its phase tag and TaskError data on the record', async () => {
    // Mirrors the real worker's failure path: measures survive a thrown task,
    // the task's return value does not.
    runWorker.mockImplementation(async (_client: any, opts: any) => {
      const assignment = { workerId: 'w1', taskRange: { start: 0, end: 0, count: 1 } };
      const measures: Record<string, unknown> = {};
      const ctx = {
        taskIndex: 0,
        assignment,
        step: async (_n: string, fn: any) => fn(),
        measure: (d: Record<string, unknown>) => Object.assign(measures, d),
        log: () => {},
      };
      let status = 'success';
      try {
        await opts.task(ctx);
      } catch {
        status = 'error';
      }
      const rec = { taskIndex: 0, status, data: { ...measures } };
      opts.onResult?.(rec);
      return { assignment, records: [rec] };
    });

    const task = defineTask(async () => {
      throw new TaskError('boom', { code: 'storage_error', data: { file_size: '1MB' } });
    });

    const outcome = await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: '1MB', iterations: 1 }],
        participants: [participants[0]],
      },
      task,
      [],
    );

    expect(outcome.participants[0].records[0]).toMatchObject({
      status: 'error',
      data: { phase: '1MB', file_size: '1MB' },
    });
  });

  it('groupBy round: claims one reporter per participant, interleaves rounds, finishes each', async () => {
    const recorded: Record<string, TaskResultRecord[]> = { e2b: [], modal: [] };
    const finished: Record<string, boolean> = {};
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded[cfg.participantSlug].push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async (failedFlag: boolean) => { finished[cfg.participantSlug] = failedFlag; },
    }));

    // Task returns a pre-measured step + data; records interleave e2b,modal per round.
    const order: string[] = [];
    const task = vi.fn(async (ctx: any) => {
      order.push(`${ctx.participant.name}#${ctx.taskIndex}`);
      return { data: { ok: true }, steps: [{ name: 'probe', status: 'success' as const, latencyMs: 5 }] };
    });

    const outcome = await runBenchmark(
      { benchmarkSlug: 'ai-gateway-local', benchmarkName: 'AI GW', iterations: 2, groupBy: 'round', participants },
      defineTask(task),
      [],
    );

    expect(outcome.participants.map((p) => p.participant)).toEqual(['e2b', 'modal']);
    expect(outcome.participants[0].records).toHaveLength(2);
    expect(outcome.participants[1].records).toHaveLength(2);
    expect(outcome.participants[0].records).toEqual(recorded.e2b);
    expect(outcome.participants[1].records).toEqual(recorded.modal);

    expect(reporterClaim).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['e2b#0', 'modal#0', 'e2b#1', 'modal#1']);
    expect(recorded.e2b).toHaveLength(2);
    expect(recorded.modal).toHaveLength(2);
    // Task-owned steps are persisted onto the built record in round mode.
    expect(recorded.e2b[0].steps).toEqual([{ name: 'probe', status: 'success', latencyMs: 5 }]);
    expect(recorded.e2b[0].status).toBe('success');
    expect(finished.e2b).toBe(false);
    expect(finished.modal).toBe(false);
    // runWorker is NOT used in round mode; the single worker per participant is
    // planned for every task in the schedule, not just one.
    expect(runWorker).not.toHaveBeenCalled();
    expect(fakeClient.planWorkers).toHaveBeenCalledTimes(2);
    expect(calls.planWorkers[0][3]).toMatchObject({ workerCount: 1, targetConcurrency: 2 });
  });

  it('groupBy round: uploads a single shared system-metrics artifact (not one per participant)', async () => {
    const uploads: Record<string, { kind: string; body: string; metadata?: Record<string, unknown> }[]> = { e2b: [], modal: [] };
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: () => {},
      uploadArtifact: async (input: { kind: string; body: string; metadata?: Record<string, unknown> }) => {
        uploads[cfg.participantSlug].push(input);
        return {};
      },
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async () => {},
    }));

    const task = vi.fn(async () => ({ data: { ok: true } }));

    await runBenchmark(
      { benchmarkSlug: 'ai-gateway-local', benchmarkName: 'AI GW', iterations: 2, groupBy: 'round', participants },
      defineTask(task),
      [],
    );

    // Every participant runs in this one shared process, so metrics belong to
    // the run — a single artifact via one reporter, not a duplicate per slug.
    const metricsUploads = [...uploads.e2b, ...uploads.modal].filter((u) => u.kind === 'system-metrics');
    expect(metricsUploads).toHaveLength(1);
    const metrics = metricsUploads[0];
    expect(metrics).toMatchObject({ kind: 'system-metrics', name: 'metrics.jsonl', contentType: 'application/x-ndjson' });
    // Tagged process-scoped with every participant, so it's not misread as the
    // uploading participant's isolated usage (the SDK's only artifact API is
    // worker-scoped, so it's necessarily filed under one reporter's worker).
    expect(metrics.metadata).toEqual({ scope: 'shared-process', participants: ['e2b', 'modal'] });
    // Baseline sample at claim + one per round (2 rounds) + one final sample.
    const lines = metrics.body.trim().split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('groupBy round: a task with no explicit steps records a single implicit "task" step', async () => {
    const recorded: TaskResultRecord[] = [];
    reporterClaim.mockImplementation(async () => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded.push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async () => {},
    }));

    const task = vi.fn(async (ctx: any) => { ctx.measure({ bytes: 10 }); });

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
      defineTask(task),
      [],
    );

    expect(recorded[0].steps).toHaveLength(1);
    expect(recorded[0].steps?.[0]).toMatchObject({ name: 'task', status: 'success', data: { bytes: 10 } });
    // Task-level measure also folds into the record data.
    expect(recorded[0].data).toEqual({ bytes: 10 });
  });

  it('groupBy round: measure inside a step attaches to that step, not the task', async () => {
    const recorded: TaskResultRecord[] = [];
    reporterClaim.mockImplementation(async () => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded.push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async () => {},
    }));

    const task = vi.fn(async (ctx: any) => {
      await ctx.step('probe', () => { ctx.measure({ ops: 5 }); });
    });

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
      defineTask(task),
      [],
    );

    const probe = recorded[0].steps?.find((s) => s.name === 'probe');
    expect(probe?.data).toEqual({ ops: 5 });
    // No task-level measure was made, so the record carries no data.
    expect(recorded[0].data).toBeUndefined();
  });

  it('groupBy round with phases: tags each record with its phase in order', async () => {
    const recorded: Record<string, TaskResultRecord[]> = { e2b: [] };
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded[cfg.participantSlug].push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async () => {},
    }));

    const task = vi.fn(async (ctx: any) => ({ data: { phaseSeen: ctx.phase }, latencyMs: 11 }));

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        groupBy: 'round',
        participants: [participants[0]],
      },
      defineTask(task),
      [],
    );

    expect(calls.createRun[0][1].totalTasks).toBe(3);
    expect(recorded.e2b.map((r) => r.data?.phase)).toEqual(['cold', 'cold', 'warm']);
    // Task-owned latency overrides framework wall-clock.
    expect(recorded.e2b.every((r) => r.latencyMs === 11)).toBe(true);
  });

  it('groupBy round: reports worker progress after every record', async () => {
    const progress: Array<{ done: number; inFlight: number; errors: number; total?: number }> = [];
    let heartbeats = 0;
    reporterClaim.mockImplementation(async () => ({
      taskIndexStart: 0,
      recordResult: () => {},
      uploadArtifact: async () => ({}),
      setProgress: (p: { done: number; inFlight: number; errors: number; total?: number }) => progress.push(p),
      heartbeat: async () => { heartbeats += 1; },
      finish: async () => {},
    }));

    let attempt = 0;
    const task = vi.fn(async () => {
      attempt += 1;
      if (attempt === 2) throw new TaskError('boom', { code: 'probe_failed' });
      return {};
    });

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 3, groupBy: 'round', participants: [participants[0]] },
      defineTask(task),
      [],
    );

    expect(progress).toEqual([
      { done: 1, inFlight: 0, errors: 0, total: 3 },
      { done: 2, inFlight: 0, errors: 1, total: 3 },
      { done: 3, inFlight: 0, errors: 1, total: 3 },
    ]);
    expect(heartbeats).toBe(3);
  });

  it('participant mode: schedule + ctx.taskIndex are relative to the worker task range start', async () => {
    taskRangeStart = 10;
    const seen: { phase?: string; taskIndex: number }[] = [];
    const task = vi.fn(async (ctx: any) => {
      seen.push({ phase: ctx.phase, taskIndex: ctx.taskIndex });
      return {};
    });

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        participants: [participants[0]],
      },
      defineTask(task),
      [],
    );

    expect(seen).toEqual([
      { phase: 'cold', taskIndex: 0 },
      { phase: 'cold', taskIndex: 1 },
      { phase: 'warm', taskIndex: 2 },
    ]);
  });

  it('participant mode: the ramp is anchored to the worker start, not accumulated per task', async () => {
    // The fake worker runs tasks one at a time, so every task is already past
    // its scheduled launch time — none of them should sleep.
    const starts: number[] = [];
    const t0 = Date.now();
    const task = vi.fn(async () => {
      starts.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 40));
      return {};
    });

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 3, staggerDelayMs: 50, participants: [participants[0]] },
      defineTask(task),
      [],
    );

    expect(starts).toHaveLength(3);
    // Accumulating index * 50ms on top of the 40ms of work would push the last
    // start past 140ms; anchored to the worker start it lands around 80ms.
    expect(starts[2]).toBeLessThan(130);
  });

  it('groupBy round: schedule index stays 0-based while records use the reporter offset', async () => {
    const recorded: TaskResultRecord[] = [];
    reporterClaim.mockImplementation(async () => ({
      taskIndexStart: 10,
      recordResult: (r: TaskResultRecord) => recorded.push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async () => {},
    }));

    const seen: { phase?: string; taskIndex: number }[] = [];
    const task = vi.fn(async (ctx: any) => {
      seen.push({ phase: ctx.phase, taskIndex: ctx.taskIndex });
      return {};
    });

    await runBenchmark(
      {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        phases: [{ name: 'cold', iterations: 2 }, { name: 'warm', iterations: 1 }],
        groupBy: 'round',
        participants: [participants[0]],
      },
      defineTask(task),
      [],
    );

    expect(seen).toEqual([
      { phase: 'cold', taskIndex: 0 },
      { phase: 'cold', taskIndex: 1 },
      { phase: 'warm', taskIndex: 2 },
    ]);
    expect(recorded.map((r) => r.taskIndex)).toEqual([10, 11, 12]);
    expect(recorded.map((r) => r.data?.phase)).toEqual(['cold', 'cold', 'warm']);
  });

  it('groupBy round: a TaskError is recorded with its code + data preserved and marks the reporter failed', async () => {
    const recorded: Record<string, TaskResultRecord[]> = { e2b: [] };
    const finished: Record<string, boolean> = {};
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded[cfg.participantSlug].push(r),
      uploadArtifact: async () => ({}),
      setProgress: () => {},
      heartbeat: async () => {},
      finish: async (failedFlag: boolean) => { finished[cfg.participantSlug] = failedFlag; },
    }));

    const task = async () => {
      throw new TaskError('boom', { code: 'probe_failed', data: { mode: 'cold' } });
    };

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
      defineTask(task),
      [],
    );

    expect(finished.e2b).toBe(true);
    expect(recorded.e2b[0].status).toBe('error');
    expect(recorded.e2b[0].errorCode).toBe('probe_failed');
    expect(recorded.e2b[0].data).toEqual({ mode: 'cold' });
  });

  describe('ctx.step options', () => {
    const setupRoundReporter = (recorded: TaskResultRecord[]) =>
      reporterClaim.mockImplementation(async () => ({
        taskIndexStart: 0,
        recordResult: (r: TaskResultRecord) => recorded.push(r),
        uploadArtifact: async () => ({}),
        setProgress: () => {},
        heartbeat: async () => {},
        finish: async () => {},
      }));

    it('runs a step with timeoutMs that completes normally', async () => {
      const recorded: TaskResultRecord[] = [];
      setupRoundReporter(recorded);

      const task = vi.fn(async (ctx: any) => {
        const value = await ctx.step('fast', () => 'ok', { timeoutMs: 1000 });
        expect(value).toBe('ok');
        return {};
      });

      await runBenchmark(
        { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
        defineTask(task),
        [],
      );

      const step = recorded[0].steps?.find((s) => s.name === 'fast');
      expect(step?.status).toBe('success');
      expect(step?.timeoutMs).toBe(1000);
      expect(step?.errorCode).toBeUndefined();
    });

    it('times out a step with timeoutMs and records step_timeout', async () => {
      const recorded: TaskResultRecord[] = [];
      setupRoundReporter(recorded);

      let caught: unknown;
      const task = vi.fn(async (ctx: any) => {
        try {
          await ctx.step('slow', () => new Promise((resolve) => setTimeout(resolve, 5000)), { timeoutMs: 10 });
        } catch (error) {
          caught = error;
        }
        return {};
      });

      await runBenchmark(
        { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
        defineTask(task),
        [],
      );

      expect(caught).toBeInstanceOf(TaskError);
      expect((caught as TaskError).code).toBe('step_timeout');
      const step = recorded[0].steps?.find((s) => s.name === 'slow');
      expect(step?.status).toBe('error');
      expect(step?.errorCode).toBe('step_timeout');
      expect(step?.timeoutMs).toBe(10);
    });

    it('runs a step with concurrency > 1 and returns an array of results', async () => {
      const recorded: TaskResultRecord[] = [];
      setupRoundReporter(recorded);

      const task = vi.fn(async (ctx: any) => {
        const results = await ctx.step('parallel', () => 42, { concurrency: 3 });
        expect(results).toEqual([42, 42, 42]);
        return {};
      });

      await runBenchmark(
        { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
        defineTask(task),
        [],
      );

      const step = recorded[0].steps?.find((s) => s.name === 'parallel');
      expect(step?.status).toBe('success');
      expect(step?.concurrency).toBe(3);
    });

    it('fails a step with concurrency > 1 when one invocation fails', async () => {
      const recorded: TaskResultRecord[] = [];
      setupRoundReporter(recorded);

      let calls = 0;
      let caught: unknown;
      const task = vi.fn(async (ctx: any) => {
        try {
          await ctx.step(
            'parallel',
            () => {
              const index = calls++;
              if (index === 1) throw new TaskError('boom', { code: 'invocation_failed' });
              return index;
            },
            { concurrency: 3 },
          );
        } catch (error) {
          caught = error;
        }
        return {};
      });

      await runBenchmark(
        { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
        defineTask(task),
        [],
      );

      expect(caught).toBeInstanceOf(TaskError);
      expect((caught as TaskError).code).toBe('invocation_failed');
      const step = recorded[0].steps?.find((s) => s.name === 'parallel');
      expect(step?.status).toBe('error');
      expect(step?.concurrency).toBe(3);
      expect(step?.errorCode).toBe('invocation_failed');
    });

    it('handles a parallel step where a later invocation rejects while an earlier one is still pending', async () => {
      const recorded: TaskResultRecord[] = [];
      setupRoundReporter(recorded);

      let calls = 0;
      let caught: unknown;
      const task = vi.fn(async (ctx: any) => {
        try {
          await ctx.step(
            'parallel',
            () => {
              const index = calls++;
              if (index === 1) {
                return new Promise((_, reject) =>
                  setTimeout(() => reject(new TaskError('boom', { code: 'invocation_failed' })), 5),
                );
              }
              return new Promise((resolve) => setTimeout(() => resolve(index), 50));
            },
            { concurrency: 3 },
          );
        } catch (error) {
          caught = error;
        }
        return {};
      });

      await runBenchmark(
        { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', participants: [participants[0]] },
        defineTask(task),
        [],
      );

      expect(caught).toBeInstanceOf(TaskError);
      expect((caught as TaskError).code).toBe('invocation_failed');
      const step = recorded[0].steps?.find((s) => s.name === 'parallel');
      expect(step?.status).toBe('error');
      expect(step?.concurrency).toBe(3);
      expect(step?.errorCode).toBe('invocation_failed');
    });

    it('forwards timeoutMs and concurrency to the platform worker step in participant mode', async () => {
      const task = vi.fn(async (ctx: any) => {
        await ctx.step('par', () => 'ok', { concurrency: 3, timeoutMs: 1000 });
        return {};
      });

      const outcome = await runBenchmark(
        { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'participant', participants: [participants[0]] },
        defineTask(task),
        [],
      );

      expect(task).toHaveBeenCalled();
      const stepOptions = (outcome.participants[0].records[0] as any).steps?.[0]?.options;
      expect(stepOptions).toMatchObject({ timeoutMs: 1000, stepConcurrency: 3 });
    });
  });

  describe('no-ingest mode', () => {
    it('skips all platform calls in participant mode', async () => {
      const task = vi.fn(async () => ({ data: { ok: true } }));
      const config: BenchmarkConfig<typeof participants[number]> = {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        iterations: 3,
        concurrency: 2,
        participants: [participants[0]],
      };

      const outcome = await runBenchmark(config, defineTask(task), ['--no-ingest']);

      expect(createBenchmarkClient).toHaveBeenCalled();
      expect(fakeClient.upsertBenchmark).not.toHaveBeenCalled();
      expect(fakeClient.createRun).not.toHaveBeenCalled();
      expect(runWorker).not.toHaveBeenCalled();
      expect(fakeClient.submitRunSummary).not.toHaveBeenCalled();
      expect(outcome.runId).toBe('no-ingest');
      expect(outcome.dashboardUrl).toBe('');
      expect(outcome.participants).toHaveLength(1);
      expect(outcome.participants[0].records).toHaveLength(3);
      expect(outcome.participants[0].records.every((r) => r.status === 'success')).toBe(true);
    });

    it('skips all platform calls in round mode', async () => {
      const task = vi.fn(async () => ({ data: { ok: true } }));
      const config: BenchmarkConfig<typeof participants[number]> = {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        iterations: 2,
        groupBy: 'round',
        participants: [participants[0]],
      };

      const outcome = await runBenchmark(config, defineTask(task), ['--no-ingest']);

      expect(createBenchmarkClient).toHaveBeenCalled();
      expect(fakeClient.upsertBenchmark).not.toHaveBeenCalled();
      expect(fakeClient.createRun).not.toHaveBeenCalled();
      expect(fakeClient.planWorkers).not.toHaveBeenCalled();
      expect(reporterClaim).not.toHaveBeenCalled();
      expect(fakeClient.submitRunSummary).not.toHaveBeenCalled();
      expect(outcome.runId).toBe('no-ingest');
      expect(outcome.participants[0].records).toHaveLength(2);
    });

    it('honors BENCHSDK_NO_INGEST=1 without a CLI flag', async () => {
      process.env.BENCHSDK_NO_INGEST = '1';
      const task = vi.fn(async () => ({}));
      const config: BenchmarkConfig<typeof participants[number]> = {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        iterations: 2,
        participants: [participants[0]],
      };

      const outcome = await runBenchmark(config, defineTask(task), []);

      expect(createBenchmarkClient).toHaveBeenCalled();
      expect(fakeClient.createRun).not.toHaveBeenCalled();
      expect(outcome.runId).toBe('no-ingest');
    });

    it('does not submit a run summary in dry-run even with scoring configured', async () => {
      const onScore = vi.fn((lowerIsBetter) => ({
        metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 1000, weights: { median: 1, p95: 0, p99: 0 } })],
      }));
      const onComplete = vi.fn();
      const config: BenchmarkConfig<typeof participants[number]> = {
        benchmarkSlug: 's',
        benchmarkName: 'n',
        iterations: 2,
        participants: [participants[0]],
        onScore,
        onComplete,
      };

      const outcome = await runBenchmark(config, defineTask(async () => ({ data: { ttiMs: 100 } })), ['--no-ingest']);

      expect(fakeClient.submitRunSummary).not.toHaveBeenCalled();
      expect(onScore).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(outcome);
      expect(outcome.runId).toBe('no-ingest');
    });
  });

  it('propagates resolved orgSlug and orgId to round-mode reporter claims', async () => {
    process.env.BENCHMARKS_PLATFORM_TOKEN = 'oauth-token';
    process.env.BENCHMARKS_TEST_ORG_SLUG = 'my-org';
    process.env.BENCHMARKS_TEST_ORG_ID = 'my-org-id';
    delete process.env.BENCHMARKS_PLATFORM_API_KEY;

    const task = vi.fn(async () => ({ data: { ok: true } }));
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 1,
      groupBy: 'round',
      participants: [participants[0]],
    };

    await runBenchmark(config, defineTask(task), []);

    expect(createBenchmarkClient).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'oauth-token',
        orgSlug: 'my-org',
        orgId: 'my-org-id',
      }),
    );
    expect(reporterClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'oauth-token',
        orgSlug: 'my-org',
        orgId: 'my-org-id',
      }),
    );
  });
});
