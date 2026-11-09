import { createBenchmarkClient } from '@benchsdk/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleRunsRunAgain,
  parseSubcommandOptions,
  waitForRunAgain,
} from '../cli.js';

describe('benchmark run-again API client methods', () => {
  it('sends encoded run-again POST and status GET requests', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      const body =
        init?.method === 'POST'
          ? {
              runAgainId: 'run-again-1',
              actionRunId: null,
              created: true,
            }
          : { runAgainId: 'run-again/2', runId: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const api = createBenchmarkClient({
      baseUrl: 'https://platform.test/api/v1',
      apiKey: 'bp_test',
      fetch: fetchImpl,
    });

    const result = await api.runAgain('my bench/one', 'run:1', {
      requestId: 'request-1',
    });
    const status = await api.getRunAgain('my bench/one', 'run-again/2');

    expect(result).toEqual({
      runAgainId: 'run-again-1',
      actionRunId: null,
      created: true,
    });
    expect(requests[0].url).toBe(
      'https://platform.test/api/v1/benchmarks/my%20bench%2Fone/runs/run%3A1/run-again',
    );
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ requestId: 'request-1' });
    expect(status).toEqual({ runAgainId: 'run-again/2', runId: null });
    expect(requests[1].url).toBe(
      'https://platform.test/api/v1/benchmarks/my%20bench%2Fone/run-again/run-again%2F2',
    );
    expect(requests[1].init?.method).toBe('GET');
    expect(requests[1].init?.body).toBeUndefined();
  });
});

describe('run-again CLI option parsing', () => {
  it('parses --wait without consuming the next option', () => {
    const result = parseSubcommandOptions([
      'run-again',
      'my-bench',
      'run-1',
      '--wait',
      '--timeout',
      '60',
    ]);

    expect(result.options).toEqual({ wait: true, timeout: 60 });
    expect(result.positionals).toEqual(['run-again', 'my-bench', 'run-1']);
  });

  it('rejects a value for --wait', () => {
    expect(() => parseSubcommandOptions(['run-again', 'my-bench', 'run-1', '--wait=1'])).toThrow(
      'Option --wait does not take a value',
    );
  });
});

describe('handleRunsRunAgain validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires --wait for a timeout before resolving credentials', async () => {
    vi.stubEnv('BENCHMARKS_PLATFORM_API_KEY', '');
    vi.stubEnv('BENCHMARKS_PLATFORM_TOKEN', '');

    await expect(
      handleRunsRunAgain('my-bench', 'run-1', { timeout: 5 }, {}, {}),
    ).rejects.toThrow('--timeout requires --wait');
  });

  it('rejects a non-positive timeout before resolving credentials', async () => {
    vi.stubEnv('BENCHMARKS_PLATFORM_API_KEY', '');
    vi.stubEnv('BENCHMARKS_PLATFORM_TOKEN', '');

    await expect(
      handleRunsRunAgain('my-bench', 'run-1', { wait: true, timeout: 0 }, {}, {}),
    ).rejects.toThrow('--timeout must be greater than 0');
  });
});

describe('waitForRunAgain', () => {
  it('polls until the benchmark run reports', async () => {
    const runIds: (string | null)[] = [null, null, 'run-9'];
    const getRunAgain = vi.fn(async () => ({
      runAgainId: 'run-again-1',
      runId: runIds.shift() ?? null,
    }));
    const sleep = vi.fn(async (_ms: number) => {});

    await expect(
      waitForRunAgain({ getRunAgain }, 'my-bench', 'run-again-1', {
        timeoutMs: 15_000,
        sleep,
      }),
    ).resolves.toBe('run-9');
    expect(getRunAgain).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
  });

  it('times out with a follow-up command using the fake clock', async () => {
    let now = 0;
    const getRunAgain = vi.fn(async () => ({ runAgainId: 'run-again-1', runId: null }));

    await expect(
      waitForRunAgain({ getRunAgain }, 'my-bench', 'run-again-1', {
        timeoutMs: 10_000,
        intervalMs: 5_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow('bench runs run-again-status my-bench run-again-1');
    expect(getRunAgain).toHaveBeenCalledTimes(3);
  });

  it('polls once more at the deadline before timing out', async () => {
    let now = 0;
    const runIds: (string | null)[] = [null, 'run-5'];
    const getRunAgain = vi.fn(async () => ({
      runAgainId: 'run-again-1',
      runId: runIds.shift() ?? null,
    }));

    await expect(
      waitForRunAgain({ getRunAgain }, 'my-bench', 'run-again-1', {
        timeoutMs: 5_000,
        intervalMs: 5_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).resolves.toBe('run-5');
    expect(getRunAgain).toHaveBeenCalledTimes(2);
  });
});
