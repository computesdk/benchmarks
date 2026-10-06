import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGlobalArgs, parseSubcommandOptions } from '../cli.js';
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
      'benchsdk-runner',
      'http://localhost:3000/api/v1',
      'benchmarks:read org:read',
    );
    expect(result.device_code).toBe('dc');
    expect(result.user_code).toBe('UC-1234');
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/api/auth/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'benchsdk-runner',
        resource: 'http://localhost:3000/api/v1',
        scope: 'benchmarks:read org:read',
      }),
    });
  });
});
