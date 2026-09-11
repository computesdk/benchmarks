/**
 * The provider-assigned id of a live sandbox (`Sandbox.sandboxId` in
 * computesdk), or null when the SDK did not expose one. Logged so providers
 * can correlate a benchmark attempt with their own systems. Deliberately reads
 * only that one field: sandbox objects also carry clients and credentials, and
 * `getInfo()` is a network call that would perturb the measured latencies.
 */
export function sandboxId(sandbox: unknown): string | null {
  if (!sandbox || typeof sandbox !== 'object') return null;
  const id = (sandbox as { sandboxId?: unknown }).sandboxId;
  return typeof id === 'string' && id !== '' ? id : null;
}
