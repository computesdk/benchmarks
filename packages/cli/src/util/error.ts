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
