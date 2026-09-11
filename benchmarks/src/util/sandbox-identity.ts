import type { JsonObject } from '@benchsdk/api';

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|credential)/i;
const SKIP_KEYS = new Set(['sandboxId', 'provider']);

/**
 * Identifying, non-sensitive facts about a live sandbox, suitable for log
 * lines. Always carries `sandboxId` (null when the SDK did
 * not expose one) so providers can correlate a benchmark attempt with their
 * own logs; other public scalar fields on the sandbox object (region, template,
 * instance type, ...) are included as `providerMeta`. Synchronous on purpose —
 * `getInfo()` is a network call and would perturb the measured latencies.
 */
export interface SandboxIdentity {
  sandboxId: string | null;
  providerMeta?: JsonObject;
}

export function sandboxIdentity(sandbox: unknown): SandboxIdentity {
  if (!sandbox || typeof sandbox !== 'object') return { sandboxId: null };
  const s = sandbox as Record<string, unknown>;
  const identity: SandboxIdentity = { sandboxId: typeof s.sandboxId === 'string' ? s.sandboxId : null };
  const meta: JsonObject = {};
  for (const key of Object.keys(s)) {
    if (SKIP_KEYS.has(key) || SECRET_KEY_RE.test(key)) continue;
    const val = s[key];
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') meta[key] = val;
  }
  if (Object.keys(meta).length > 0) identity.providerMeta = meta;
  return identity;
}
