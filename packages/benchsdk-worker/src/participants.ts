/**
 * Base interface for a benchmark participant — the shared shape across all
 * benchmark categories (sandbox, ai-gateway, browser, storage). Each category
 * extends this with its own provider-specific fields.
 */
export interface BaseParticipant {
  /** Participant name (e.g. 'e2b', 'daytona', 'openrouter') */
  name: string;
  /** Environment variables that must all be set to run this participant */
  requiredEnvVars?: string[];
}

/**
 * Filters `participants` down to those whose `requiredEnvVars` are all set
 * in `process.env`. Returns an object `{ available, skipped }` where `skipped`
 * includes the names and missing vars for logging.
 */
export function filterParticipantsByEnv<T extends BaseParticipant>(
  participants: T[],
): { available: T[]; skipped: { name: string; missing: string[] }[] } {
  const available: T[] = [];
  const skipped: { name: string; missing: string[] }[] = [];

  for (const p of participants) {
    const requiredEnvVars = Array.isArray(p.requiredEnvVars) ? p.requiredEnvVars : [];
    const missing = requiredEnvVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      skipped.push({ name: p.name, missing });
    } else {
      available.push(p);
    }
  }

  return { available, skipped };
}

/**
 * Filters `all` down to the requested `names`, throwing a clear error if any
 * name is unrecognized. Returns `all` unchanged when `names` is undefined
 * (no filter specified).
 */
export function selectParticipants<T extends BaseParticipant>(
  all: T[],
  names?: string[],
): T[] {
  if (!names) return all;
  const unknown = names.filter((n) => !all.some((p) => p.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown participant(s): ${unknown.join(', ')}. Available: ${all.map((p) => p.name).join(', ')}`,
    );
  }
  return all.filter((p) => names.includes(p.name));
}
