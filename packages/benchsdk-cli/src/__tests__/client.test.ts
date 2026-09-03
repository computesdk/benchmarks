import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as config from '../config.js';
import { resolveAuth, createApiClient } from '../client.js';
import { createBenchmarkClient } from '@benchsdk/api';

vi.mock('@benchsdk/api', () => ({
  createBenchmarkClient: vi.fn(() => ({ client: 'fake' })),
}));

describe('resolveAuth', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    originalEnv['BENCHMARKS_PLATFORM_API_KEY'] = process.env.BENCHMARKS_PLATFORM_API_KEY;
    originalEnv['BENCHMARKS_PLATFORM_TOKEN'] = process.env.BENCHMARKS_PLATFORM_TOKEN;
    originalEnv['BENCHMARKS_PLATFORM_URL'] = process.env.BENCHMARKS_PLATFORM_URL;
    delete process.env.BENCHMARKS_PLATFORM_API_KEY;
    delete process.env.BENCHMARKS_PLATFORM_TOKEN;
    delete process.env.BENCHMARKS_PLATFORM_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses saved OAuth credentials including baseUrl, orgSlug, and orgId', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({});
    vi.spyOn(config, 'loadCredentials').mockResolvedValue({
      token: 'saved-token',
      refreshToken: 'saved-refresh',
      tokenExpiresAt: Date.now() + 1_000_000,
      refreshExpiresAt: Date.now() + 1_000_000,
      baseUrl: 'https://saved.example.com',
      orgSlug: 'saved-org',
      orgId: 'saved-org-id',
      kind: 'oauth',
    });

    const auth = await resolveAuth();

    expect(auth.token).toBe('saved-token');
    expect(auth.refreshToken).toBe('saved-refresh');
    expect(auth.baseUrl).toBe('https://saved.example.com');
    expect(auth.apiBaseUrl).toBe('https://saved.example.com/api/v1');
    expect(auth.orgSlug).toBe('saved-org');
    expect(auth.orgId).toBe('saved-org-id');
    expect(auth.apiKey).toBeUndefined();
  });

  it('prefers BENCHMARKS_PLATFORM_API_KEY over saved OAuth and does not inherit saved org/baseUrl', async () => {
    process.env.BENCHMARKS_PLATFORM_API_KEY = 'env-api-key';
    vi.spyOn(config, 'loadConfig').mockResolvedValue({});
    vi.spyOn(config, 'loadCredentials').mockResolvedValue({
      token: 'saved-token',
      refreshToken: 'saved-refresh',
      tokenExpiresAt: Date.now() + 1_000_000,
      baseUrl: 'https://saved.example.com',
      orgSlug: 'saved-org',
      orgId: 'saved-org-id',
      kind: 'oauth',
    });

    const auth = await resolveAuth();

    expect(auth.apiKey).toBe('env-api-key');
    expect(auth.token).toBeUndefined();
    expect(auth.refreshToken).toBeUndefined();
    expect(auth.baseUrl).toBe('https://platform.computesdk.com');
    expect(auth.orgSlug).toBeUndefined();
    expect(auth.orgId).toBeUndefined();
  });

  it('prefers BENCHMARKS_PLATFORM_TOKEN over saved OAuth and does not inherit saved org/baseUrl', async () => {
    process.env.BENCHMARKS_PLATFORM_TOKEN = 'env-token';
    vi.spyOn(config, 'loadConfig').mockResolvedValue({});
    vi.spyOn(config, 'loadCredentials').mockResolvedValue({
      token: 'saved-token',
      refreshToken: 'saved-refresh',
      tokenExpiresAt: Date.now() + 1_000_000,
      baseUrl: 'https://saved.example.com',
      orgSlug: 'saved-org',
      orgId: 'saved-org-id',
      kind: 'oauth',
    });

    const auth = await resolveAuth();

    expect(auth.token).toBe('env-token');
    expect(auth.refreshToken).toBeUndefined();
    expect(auth.baseUrl).toBe('https://platform.computesdk.com');
    expect(auth.orgSlug).toBeUndefined();
    expect(auth.orgId).toBeUndefined();
  });

  it('prefers BENCHMARKS_PLATFORM_TOKEN over BENCHMARKS_PLATFORM_API_KEY when both are set', async () => {
    process.env.BENCHMARKS_PLATFORM_TOKEN = 'env-token';
    process.env.BENCHMARKS_PLATFORM_API_KEY = 'env-api-key';
    vi.spyOn(config, 'loadConfig').mockResolvedValue({});
    vi.spyOn(config, 'loadCredentials').mockResolvedValue(null);

    const auth = await resolveAuth();

    expect(auth.token).toBe('env-token');
    expect(auth.apiKey).toBeUndefined();
  });

  it('uses explicit config and overrides over saved credentials', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      baseUrl: 'https://config.example.com',
      org: 'config-org',
    });
    vi.spyOn(config, 'loadCredentials').mockResolvedValue({
      token: 'saved-token',
      refreshToken: 'saved-refresh',
      tokenExpiresAt: Date.now() + 1_000_000,
      baseUrl: 'https://saved.example.com',
      orgSlug: 'saved-org',
      orgId: 'saved-org-id',
      kind: 'oauth',
    });

    const auth = await resolveAuth({ baseUrl: 'https://override.example.com', org: 'override-org' });

    expect(auth.baseUrl).toBe('https://override.example.com');
    expect(auth.orgSlug).toBe('override-org');
    expect(auth.orgId).toBe('saved-org-id');
  });

  it('uses explicit override apiKey and ignores saved credentials entirely', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({});
    vi.spyOn(config, 'loadCredentials').mockResolvedValue({
      token: 'saved-token',
      baseUrl: 'https://saved.example.com',
      orgSlug: 'saved-org',
      kind: 'oauth',
    });

    const auth = await resolveAuth({ apiKey: 'override-api-key' });

    expect(auth.apiKey).toBe('override-api-key');
    expect(auth.token).toBeUndefined();
    expect(auth.baseUrl).toBe('https://platform.computesdk.com');
    expect(auth.orgSlug).toBeUndefined();
    expect(auth.orgId).toBeUndefined();
  });

  it('throws AuthError when no credentials are available', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({});
    vi.spyOn(config, 'loadCredentials').mockResolvedValue(null);

    await expect(resolveAuth()).rejects.toThrow('No credentials found');
  });
});

describe('createApiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.BENCHMARKS_PLATFORM_API_KEY;
    delete process.env.BENCHMARKS_PLATFORM_TOKEN;
  });

  it('passes resolved auth to createBenchmarkClient', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({});
    vi.spyOn(config, 'loadCredentials').mockResolvedValue({
      apiKey: 'api-key',
      baseUrl: 'https://platform.example.com',
      orgSlug: 'my-org',
      orgId: 'my-org-id',
      kind: 'api-key',
    });

    const { api, auth } = await createApiClient();

    expect(auth.apiKey).toBe('api-key');
    expect(auth.orgSlug).toBe('my-org');
    expect(auth.orgId).toBe('my-org-id');
    expect(auth.apiBaseUrl).toBe('https://platform.example.com/api/v1');
    expect(api).toEqual({ client: 'fake' });
    expect(createBenchmarkClient).toHaveBeenCalledWith({
      baseUrl: 'https://platform.example.com/api/v1',
      apiKey: 'api-key',
      token: undefined,
      orgSlug: 'my-org',
      orgId: 'my-org-id',
    });
  });
});
