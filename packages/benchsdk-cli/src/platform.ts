export const DEFAULT_PLATFORM_URL = 'https://platform.computesdk.com';

export function getPlatformBaseUrl(override?: string, fallback?: string): string {
  const base = override?.trim() || process.env.BENCHMARKS_PLATFORM_URL?.trim() || fallback?.trim() || DEFAULT_PLATFORM_URL;
  return base.replace(/\/+$/, '');
}

export function getApiBaseUrl(platformUrl?: string): string {
  const base = getPlatformBaseUrl(platformUrl);
  if (base.endsWith('/api/v1')) return base;
  return `${base}/api/v1`;
}

export function getAuthBaseUrl(platformUrl?: string): string {
  const base = getPlatformBaseUrl(platformUrl).replace(/\/api\/v1$/, '');
  return `${base}/api/auth`;
}
