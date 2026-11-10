import { createApiClient } from './client.js';
import { ExitError, rethrowWithHint, type ApiErrorEnvelope } from './errors.js';
import { isJsonOutput, optionFlag, optionNumber, optionString, type SubcommandOptions } from './options.js';
import { printData, type OutputOptions } from './output.js';

type Overrides = { baseUrl?: string; apiKey?: string; org?: string };

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 5;
/** `bench retrigger --wait` exit code when no run linked before --timeout. */
export const RETRIGGER_TIMEOUT_EXIT_CODE = 3;

// A retrigger is attributed to a person, so the platform refuses org API keys
// (and the admin key) with 403 user_credential_required.
function retriggerHint(status: number, envelope: ApiErrorEnvelope | null): string | undefined {
  if (status === 403 && envelope?.code === 'user_credential_required') {
    return 'Retrigger needs a user login; run `bench auth login` (API keys cannot retrigger). Drop --api-key and BENCHMARKS_PLATFORM_API_KEY so the login is used.';
  }
  return undefined;
}

function secondsOption(options: SubcommandOptions, key: string, fallback: number): number {
  const value = optionNumber(options, key);
  if (value === undefined) return fallback;
  if (!(value > 0)) throw new Error(`--${key} must be a positive number of seconds`);
  return value;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `bench retrigger <slug> [--wait]`: queue today's retrigger of a daily benchmark. */
export async function handleRetrigger(
  slug: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  if (!slug) throw new Error('Benchmark slug required: bench retrigger <benchmark-slug> [--wait]');
  const wait = optionFlag(options, 'wait');
  if (!wait && (options.timeout !== undefined || options.interval !== undefined)) {
    throw new Error('--timeout and --interval only apply with --wait');
  }
  const timeoutMs = secondsOption(options, 'timeout', DEFAULT_TIMEOUT_SECONDS) * 1000;
  const intervalMs = secondsOption(options, 'interval', DEFAULT_INTERVAL_SECONDS) * 1000;

  const { api } = await createApiClient(overrides);
  const accepted = await api.retriggerBenchmark(slug).catch((err: unknown) => rethrowWithHint(err, retriggerHint));
  const { requestId } = accepted;

  if (!wait) {
    if (isJsonOutput(output)) {
      printData(accepted, output);
      return;
    }
    console.log(`Retrigger of ${slug} (${accepted.category}) requested: ${requestId}`);
    console.log(`Follow it with \`bench retrigger status ${slug} --request ${requestId}\`.`);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await api.getRetriggerRequest(slug, requestId);
    if (status.runId) {
      if (isJsonOutput(output)) printData({ requestId, runId: status.runId }, output);
      else console.log(`Run ${status.runId} started`);
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }

  if (isJsonOutput(output)) printData({ requestId, runId: null }, output);
  throw new ExitError(
    `No run linked to retrigger request ${requestId} within ${timeoutMs / 1000}s. ` +
      `Check again with \`bench retrigger status ${slug} --request ${requestId}\`.`,
    RETRIGGER_TIMEOUT_EXIT_CODE,
  );
}

/** `bench retrigger status <slug> [--request <id>]`: today's availability, or one request. */
export async function handleRetriggerStatus(
  slug: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  if (!slug) throw new Error('Benchmark slug required: bench retrigger status <benchmark-slug> [--request <id>]');
  const requestId = optionString(options, 'request');
  const { api } = await createApiClient(overrides);

  if (requestId !== undefined) {
    const status = await api.getRetriggerRequest(slug, requestId);
    if (isJsonOutput(output)) {
      printData(status, output);
      return;
    }
    console.log(
      status.runId
        ? `Request ${status.requestId} linked run ${status.runId}`
        : `Request ${status.requestId} is ${status.status}; no run linked yet`,
    );
    return;
  }

  const state = await api.getRetriggerState(slug);
  if (isJsonOutput(output)) {
    printData(state, output);
    return;
  }
  const availability = state.available ? 'available' : `unavailable${state.disabledReason ? ` (${state.disabledReason})` : ''}`;
  console.log(`${state.benchmarkSlug} (${state.category}): retrigger ${availability}`);
  console.log(`Quota ${state.quota.day}: ${state.quota.used}/${state.quota.limit} used, resets at ${state.quota.resetsAt}`);
}
