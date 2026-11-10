import { BenchmarkApiError } from '@benchsdk/api';

/** Ends the command with a specific exit code (after printing `message`, when non-empty, to stderr). */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'ExitError';
  }
}

/** The platform's standard error body: `{error, code, message, hint, requestId, details?}`. */
export interface ApiErrorEnvelope {
  error?: string;
  code?: string;
  message?: string;
  hint?: string;
  requestId?: string;
  retryAt?: string;
  disabledReason?: string | null;
}

export function parseApiErrorBody(body: string | undefined): ApiErrorEnvelope | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope.error !== 'string' && typeof envelope.message !== 'string') return null;
    return envelope as ApiErrorEnvelope;
  } catch {
    return null;
  }
}

const cliHints = new WeakMap<BenchmarkApiError, string>();

/**
 * Attaches a command-specific next step to an API error (printed as an extra
 * `Hint:` line) when `pick` returns one, and rethrows it.
 */
export function rethrowWithHint(
  err: unknown,
  pick: (status: number, envelope: ApiErrorEnvelope | null) => string | undefined,
): never {
  if (err instanceof BenchmarkApiError) {
    const hint = pick(err.status, parseApiErrorBody(err.body));
    if (hint) cliHints.set(err, hint);
  }
  throw err;
}

/** Lines to print on stderr for an API error. */
export function formatApiError(err: BenchmarkApiError, verbose = false): string[] {
  const lines = [`API error: ${err.message}`];
  const envelope = parseApiErrorBody(err.body);
  if (envelope) {
    const title = envelope.error ?? envelope.message ?? '';
    const detail = envelope.message && envelope.error && envelope.message !== envelope.error ? `: ${envelope.message}` : '';
    lines.push(`${title}${detail}${envelope.code ? ` (code: ${envelope.code})` : ''}`);
    if (envelope.disabledReason) lines.push(`Reason: ${envelope.disabledReason}`);
    if (envelope.retryAt) lines.push(`Retry at: ${envelope.retryAt}`);
    // A command's own hint names this CLI's commands; the platform's is generic
    // (e.g. it says `bench login` where this CLI has `bench auth login`).
    if (envelope.hint && !cliHints.has(err)) lines.push(`Hint: ${envelope.hint}`);
    if (verbose && envelope.requestId) lines.push(`Request id: ${envelope.requestId}`);
    if (verbose) lines.push(err.body);
  } else if (err.body) {
    lines.push(err.body);
  }
  const cliHint = cliHints.get(err);
  if (cliHint) lines.push(`Hint: ${cliHint}`);
  return lines;
}
