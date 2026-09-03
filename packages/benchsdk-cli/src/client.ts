import { createBenchmarkClient, type BenchmarkClient, BenchmarkApiError } from '@benchsdk/api';
import {
  loadCredentials,
  saveCredentials,
  loadConfig,
  mergeConfig,
  type Credentials,
  type Config,
} from './config.js';
import { refreshAccessToken, AuthError } from './auth.js';
import { getApiBaseUrl, getAuthBaseUrl, getPlatformBaseUrl } from './platform.js';

export interface CliAuth {
  token?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshExpiresAt?: number;
  apiKey?: string;
  orgSlug?: string;
  orgId?: string;
  baseUrl: string;
  apiBaseUrl: string;
  authBaseUrl: string;
  format?: 'json' | 'table';
}

function tokenFromEnvironment(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env.BENCHMARKS_PLATFORM_TOKEN;
}

function apiKeyFromEnvironment(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env.BENCHMARKS_PLATFORM_API_KEY;
}

function computeTokenExpiry(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000;
}

function updateCredentialsWithTokenResponse(
  credentials: Credentials,
  response: { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number },
): Credentials {
  return {
    ...credentials,
    token: response.access_token,
    refreshToken: response.refresh_token,
    tokenExpiresAt: computeTokenExpiry(response.expires_in),
    refreshExpiresAt: computeTokenExpiry(response.refresh_expires_in),
  };
}

async function refreshIfNeeded(auth: CliAuth, credentials: Credentials): Promise<Credentials> {
  if (!auth.token || auth.apiKey) return credentials;

  const now = Date.now();
  const expiry = auth.tokenExpiresAt ?? 0;
  const refreshExpiry = auth.refreshExpiresAt ?? 0;

  // Refresh when the access token expires within 5 minutes or has already expired,
  // but only if we have a refresh token and it is still valid.
  if (now < expiry - 5 * 60 * 1000) {
    return credentials;
  }

  if (!auth.refreshToken || now >= refreshExpiry) {
    throw new AuthError(
      'Your session has expired. Run `bench auth login` or set BENCHMARKS_PLATFORM_API_KEY.',
    );
  }

  try {
    const response = await refreshAccessToken(auth.authBaseUrl, auth.refreshToken);
    const updated = updateCredentialsWithTokenResponse(credentials, response);
    await saveCredentials(updated);
    return updated;
  } catch {
    throw new AuthError(
      'Failed to refresh your session. Run `bench auth login` or set BENCHMARKS_PLATFORM_API_KEY.',
    );
  }
}

export function getAuthHeader(auth: CliAuth): string | undefined {
  const token = auth.token ?? auth.apiKey ?? apiKeyFromEnvironment();
  if (!token) return undefined;
  return `Bearer ${token}`;
}

export async function resolveAuth(override?: {
  baseUrl?: string;
  apiKey?: string;
  org?: string;
}): Promise<CliAuth> {
  const config = (await loadConfig()) ?? ({} as Config);
  const credentials = (await loadCredentials()) ?? ({} as Credentials);
  const mergedConfig = mergeConfig(config, {
    baseUrl: override?.baseUrl,
    org: override?.org,
  });

  const envApiKey = apiKeyFromEnvironment();
  const envToken = tokenFromEnvironment();

  let token: string | undefined;
  let apiKey: string | undefined;
  let refreshToken: string | undefined;
  let tokenExpiresAt: number | undefined;
  let refreshExpiresAt: number | undefined;
  let platformUrl: string;
  let orgSlug: string | undefined;
  let orgId: string | undefined;

  if (override?.apiKey) {
    apiKey = override.apiKey;
    token = undefined;
    refreshToken = undefined;
    platformUrl = getPlatformBaseUrl(override.baseUrl ?? config.baseUrl);
    orgSlug = override.org ?? config.org;
    orgId = undefined;
  } else if (envToken) {
    token = envToken;
    refreshToken = undefined;
    tokenExpiresAt = undefined;
    refreshExpiresAt = undefined;
    platformUrl = getPlatformBaseUrl(mergedConfig.baseUrl);
    orgSlug = mergedConfig.org;
    orgId = undefined;
  } else if (envApiKey) {
    apiKey = envApiKey;
    token = undefined;
    refreshToken = undefined;
    platformUrl = getPlatformBaseUrl(mergedConfig.baseUrl);
    orgSlug = mergedConfig.org;
    orgId = undefined;
  } else {
    token = credentials.token;
    apiKey = credentials.apiKey;
    refreshToken = credentials.refreshToken;
    tokenExpiresAt = credentials.tokenExpiresAt;
    refreshExpiresAt = credentials.refreshExpiresAt;
    platformUrl = getPlatformBaseUrl(mergedConfig.baseUrl ?? credentials.baseUrl);
    orgSlug = mergedConfig.org ?? credentials.orgSlug;
    orgId = credentials.orgId;
  }

  const apiBaseUrl = getApiBaseUrl(platformUrl);
  const authBaseUrl = getAuthBaseUrl(platformUrl);
  const format = config.format;

  let auth: CliAuth = {
    token,
    refreshToken,
    tokenExpiresAt,
    refreshExpiresAt,
    apiKey,
    orgSlug,
    orgId,
    baseUrl: platformUrl,
    apiBaseUrl,
    authBaseUrl,
    format,
  };

  if (auth.token && auth.refreshToken && !auth.apiKey) {
    const updated = await refreshIfNeeded(auth, credentials);
    auth = {
      ...auth,
      token: updated.token,
      refreshToken: updated.refreshToken,
      tokenExpiresAt: updated.tokenExpiresAt,
      refreshExpiresAt: updated.refreshExpiresAt,
    };
  }

  if (!auth.token && !auth.apiKey) {
    throw new AuthError(
      'No credentials found. Set BENCHMARKS_PLATFORM_API_KEY or BENCHMARKS_PLATFORM_TOKEN, or run `bench auth login` for OAuth. Create an API key at https://platform.computesdk.com in your organization settings (Settings → API keys).',
    );
  }

  return auth;
}

export async function createApiClient(override?: { baseUrl?: string; apiKey?: string; org?: string }): Promise<{
  api: BenchmarkClient;
  auth: CliAuth;
}> {
  const auth = await resolveAuth(override);
  const api = createBenchmarkClient({
    baseUrl: auth.apiBaseUrl,
    token: auth.token,
    apiKey: auth.apiKey,
    orgSlug: auth.orgSlug,
    orgId: auth.orgId,
  });
  return { api, auth };
}

export async function getMe(auth: CliAuth): Promise<{
  user: { id: string; name?: string | null; email?: string | null };
  activeOrganizationId: string | null;
  organizations: { id: string; name: string; slug: string }[];
}> {
  const authorization = getAuthHeader(auth);
  if (!authorization) throw new AuthError('Not authenticated.');
  const response = await fetch(`${auth.apiBaseUrl}/me`, {
    headers: { Authorization: authorization },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BenchmarkApiError(`Me request failed: ${response.status} ${response.statusText}`, response.status, text);
  }
  return JSON.parse(text) as {
    user: { id: string; name?: string | null; email?: string | null };
    activeOrganizationId: string | null;
    organizations: { id: string; name: string; slug: string }[];
  };
}

export async function listOrganizations(auth: CliAuth): Promise<{ id: string; name: string; slug: string }[]> {
  const authorization = getAuthHeader(auth);
  if (!authorization) throw new AuthError('Not authenticated.');
  const response = await fetch(`${auth.apiBaseUrl}/organizations`, {
    headers: { Authorization: authorization },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BenchmarkApiError(
      `Organizations request failed: ${response.status} ${response.statusText}`,
      response.status,
      text,
    );
  }
  const data = JSON.parse(text) as { items: { id: string; name: string; slug: string }[] };
  return data.items ?? [];
}

export async function setActiveOrganization(
  auth: CliAuth,
  slug: string,
): Promise<{ activeOrganizationId: string | null; organization: { id: string; name: string; slug: string } | null }> {
  const authorization = getAuthHeader(auth);
  if (!authorization) throw new AuthError('Not authenticated.');
  const response = await fetch(`${auth.apiBaseUrl}/organizations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization,
    },
    body: JSON.stringify({ slug }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BenchmarkApiError(
      `Set active organization failed: ${response.status} ${response.statusText}`,
      response.status,
      text,
    );
  }
  const result = JSON.parse(text) as {
    activeOrganizationId: string | null;
    organization: { id: string; name: string; slug: string } | null;
    accessToken?: string | null;
    expiresIn?: number;
  };

  if (result.accessToken) {
    auth.token = result.accessToken;
    auth.tokenExpiresAt = computeTokenExpiry(result.expiresIn ?? 3600);
  }

  return {
    activeOrganizationId: result.activeOrganizationId,
    organization: result.organization,
  };
}
