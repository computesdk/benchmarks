import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGlobalArgs, parseSubcommandOptions, resolveResultFilter, assertFilterEcho } from '../cli.js';
import { getPlatformBaseUrl, getApiBaseUrl, getAuthBaseUrl } from '../platform.js';

describe('parseGlobalArgs', () => {
  it('parses global options and keeps positionals', () => {
    const result = parseGlobalArgs(['--base-url', 'http://localhost:3000', 'benchmarks', 'list']);
    expect(result.values).toEqual({ 'base-url': 'http://localhost:3000' });
    expect(result.positionals).toEqual(['benchmarks', 'list']);
  });

  it('parses boolean flags', () => {
    const result = parseGlobalArgs(['--json', 'results', 'my-bench']);
    expect(result.values.json).toBe(true);
    expect(result.positionals).toEqual(['results', 'my-bench']);
  });

  it('ignores unknown options so subcommands can parse them', () => {
    const result = parseGlobalArgs(['results', 'my-bench', '--run', 'run-123', '--json']);
    expect(result.positionals).toEqual(['results', 'my-bench', '--run', 'run-123']);
    expect(result.values.json).toBe(true);
  });

  it('keeps values containing = when passed as --key=value', () => {
    const result = parseGlobalArgs(['--api-key=sk-abc==', '--base-url=http://h?a=b']);
    expect(result.values['api-key']).toBe('sk-abc==');
    expect(result.values['base-url']).toBe('http://h?a=b');
  });
});

describe('parseSubcommandOptions', () => {
  it('parses string and number options with positional values', () => {
    const { options, positionals } = parseSubcommandOptions([
      'list',
      'my-bench',
      '--limit',
      '10',
      '--run',
      'run-123',
    ]);
    expect(options).toEqual({ limit: 10, run: 'run-123' });
    expect(positionals).toEqual(['list', 'my-bench']);
  });

  it('parses --key=value syntax', () => {
    const { options, positionals } = parseSubcommandOptions(['my-bench', '--out=/tmp/export']);
    expect(options).toEqual({ out: '/tmp/export' });
    expect(positionals).toEqual(['my-bench']);
  });

  it('keeps values containing = in --key=value syntax', () => {
    const { options, positionals } = parseSubcommandOptions(['my-bench', '--out=/a=b=c']);
    expect(options).toEqual({ out: '/a=b=c' });
    expect(positionals).toEqual(['my-bench']);
  });

  it('throws on unknown options', () => {
    expect(() => parseSubcommandOptions(['my-bench', '--unknown', 'x'])).toThrow('Unknown option');
  });

  it('throws on missing values', () => {
    expect(() => parseSubcommandOptions(['my-bench', '--run'])).toThrow('requires a value');
  });

  it('throws on non-numeric limit', () => {
    expect(() => parseSubcommandOptions(['my-bench', '--limit', 'abc'])).toThrow('number');
  });
});

describe('platform URL helpers', () => {
  const originalEnv = process.env.BENCHMARKS_PLATFORM_URL;

  beforeEach(() => {
    delete process.env.BENCHMARKS_PLATFORM_URL;
  });

  afterEach(() => {
    if (originalEnv) process.env.BENCHMARKS_PLATFORM_URL = originalEnv;
    else delete process.env.BENCHMARKS_PLATFORM_URL;
  });

  it('uses default platform URL', () => {
    expect(getPlatformBaseUrl()).toBe('https://platform.computesdk.com');
    expect(getApiBaseUrl()).toBe('https://platform.computesdk.com/api/v1');
    expect(getAuthBaseUrl()).toBe('https://platform.computesdk.com/api/auth');
  });

  it('uses environment override', () => {
    process.env.BENCHMARKS_PLATFORM_URL = 'http://localhost:3000';
    expect(getPlatformBaseUrl()).toBe('http://localhost:3000');
    expect(getApiBaseUrl()).toBe('http://localhost:3000/api/v1');
    expect(getAuthBaseUrl()).toBe('http://localhost:3000/api/auth');
  });

  it('does not double-append /api/v1', () => {
    expect(getApiBaseUrl('http://localhost:3000/api/v1')).toBe('http://localhost:3000/api/v1');
    expect(getAuthBaseUrl('http://localhost:3000/api/v1')).toBe('http://localhost:3000/api/auth');
  });
});

describe('auth device flow', () => {
  it('requestDeviceCode fetches /device/code', async () => {
    const { requestDeviceCode } = await import('../auth.js');
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          device_code: 'dc',
          user_code: 'UC-1234',
          verification_uri: 'http://localhost:3000/device',
          expires_in: 900,
          interval: 5,
        }),
    });
    globalThis.fetch = fetchSpy;

    const result = await requestDeviceCode(
      'http://localhost:3000/api/auth',
      'benchsdk-cli',
      'http://localhost:3000/api/v1',
      'benchmarks:read org:read',
    );
    expect(result.device_code).toBe('dc');
    expect(result.user_code).toBe('UC-1234');
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/api/auth/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'benchsdk-cli',
        resource: 'http://localhost:3000/api/v1',
        scope: 'benchmarks:read org:read',
      }),
    });
  });
});

describe('resolveResultFilter', () => {
  it('resolves relative --since bounds to an ISO timestamp', () => {
    const before = Date.now();
    const { filter, flagsSent } = resolveResultFilter({ since: '7d' }, { allowSteps: true });
    const after = Date.now();
    expect(flagsSent).toBe(true);
    const sinceMs = Date.parse(filter.since!);
    expect(sinceMs).toBeGreaterThanOrEqual(before - 7 * 86_400_000);
    expect(sinceMs).toBeLessThanOrEqual(after - 7 * 86_400_000 + 1000);
  });

  it('resolves relative --until in hours', () => {
    const { filter } = resolveResultFilter({ until: '24h' }, { allowSteps: true });
    expect(Date.parse(filter.until!)).toBeLessThan(Date.now() - 23 * 3_600_000);
  });

  it('passes absolute bounds through untouched', () => {
    const { filter } = resolveResultFilter(
      { since: '2026-10-01', until: '2026-10-20T00:00:00Z' },
      { allowSteps: true },
    );
    expect(filter.since).toBe('2026-10-01');
    expect(filter.until).toBe('2026-10-20T00:00:00Z');
  });

  it('rejects --day combined with --since or --until', () => {
    expect(() =>
      resolveResultFilter({ day: '2026-10-20', since: '2026-10-01' }, { allowSteps: true }),
    ).toThrow('--day cannot be combined');
    expect(() =>
      resolveResultFilter({ day: '2026-10-20', until: '2026-10-21' }, { allowSteps: true }),
    ).toThrow('--day cannot be combined');
  });

  it('--day expands to since+until on that date', () => {
    const { filter } = resolveResultFilter({ day: '2026-10-20' }, { allowSteps: true });
    expect(filter.since).toBe('2026-10-20');
    expect(filter.until).toBe('2026-10-20');
  });

  it('rejects --steps where steps do not apply', () => {
    expect(() =>
      resolveResultFilter({ steps: 'launch' }, { allowSteps: false }),
    ).toThrow('--steps only applies');
  });

  it('rejects an empty --participant value', () => {
    expect(() =>
      resolveResultFilter({ participant: ' , ' }, { allowSteps: true }),
    ).toThrow('--participant must name at least one');
  });

  it('--tz and --source-org alone do not count as result filters', () => {
    const tzOnly = resolveResultFilter({ tz: 'America/New_York' }, { allowSteps: true });
    expect(tzOnly.flagsSent).toBe(false);
    expect(tzOnly.filter.timeZone).toBe('America/New_York');
    const orgOnly = resolveResultFilter({ 'source-org': 'curator' }, { allowSteps: true });
    expect(orgOnly.flagsSent).toBe(false);
    expect(orgOnly.filter.sourceOrg).toBe('curator');
    const real = resolveResultFilter({ 'source-org': 'curator', participant: 'e2b' }, { allowSteps: true });
    expect(real.flagsSent).toBe(true);
    expect(real.filter.participants).toEqual(['e2b']);
    expect(real.filter.sourceOrg).toBe('curator');
  });

  it('parses participant lists and steps', () => {
    const { filter } = resolveResultFilter(
      { participant: 'e2b, daytona', steps: 'all' },
      { allowSteps: true },
    );
    expect(filter.participants).toEqual(['e2b', 'daytona']);
    expect(filter.steps).toBe('all');
  });
});

describe('assertFilterEcho', () => {
  it('throws the missing-filter error when the response has no echo', () => {
    expect(() => assertFilterEcho(undefined)).toThrow('does not support result filters');
    expect(() => assertFilterEcho(null)).toThrow('does not support result filters');
  });

  it('accepts any defined echo', () => {
    expect(() => assertFilterEcho({ timeZone: 'UTC' })).not.toThrow();
    expect(() => assertFilterEcho({})).not.toThrow();
  });
});
