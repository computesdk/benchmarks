/** @internal Shared with the BenchSDK CLI. */
export function getBenchmarkApiKeyFromEnv(baseUrl: string): string | undefined {
  if (typeof process === 'undefined') return undefined;

  // Honor existing benchmark-specific configuration when both keys are set.
  const legacyKey = process.env.BENCHMARKS_PLATFORM_API_KEY;
  if (legacyKey) return legacyKey;

  const key = process.env.COMPUTESDK_API_KEY;
  // The shared ComputeSDK key can be present even when the caller targets
  // another service. Only pick it up automatically for ComputeSDK or loopback.
  return key && isComputeSdkKeyDestination(baseUrl) ? key : undefined;
}

function isComputeSdkKeyDestination(baseUrl: string): boolean {
  try {
    const { hostname, protocol } = new URL(baseUrl);
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    if (loopback) return protocol === 'http:' || protocol === 'https:';
    return protocol === 'https:' && (hostname === 'computesdk.com' || hostname.endsWith('.computesdk.com'));
  } catch {
    return false;
  }
}
