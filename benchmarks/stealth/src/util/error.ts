/**
 * Format an unknown thrown value into a diagnostic string.
 *
 * StorageSDK wraps provider failures in a `StorageError` whose `message` is
 * often just the error `code` (e.g. the generic `"Provider"` fallback), with
 * the real provider error tucked into `.cause`. Walking the cause chain keeps
 * those underlying messages from being swallowed in benchmark output.
 */
export function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    const label = typeof code === 'string' && code !== current.message ? `${code}: ` : '';
    parts.push(`${label}${current.message}`);
    current = (current as { cause?: unknown }).cause;
  }

  return parts.join(' <- ');
}

/**
 * Bucket an error into a coarse class for rate reporting. S3-compatible
 * backends signal throttling as SlowDown ("Please reduce your request rate"),
 * which never contains the word "throttle" — match the literal message too.
 */
export function errorClass(error: unknown): string {
  const text = formatError(error).toLowerCase();
  if (/timeout|timed out|abort/.test(text)) return 'TIMEOUT';
  if (/429|503|slowdown|slow down|reduce your request rate|too many requests|throttl|rate.?limit|requestlimit/.test(text)) return 'THROTTLE';
  if (/reset|eof|socket|tls|connection/.test(text)) return 'CONN_ERROR';
  if (/notfound|not found/.test(text)) return 'NOT_FOUND';
  if (/unauthor|forbidden|accessdenied|invalidargument/.test(text)) return 'CLIENT';
  return 'SERVER';
}
