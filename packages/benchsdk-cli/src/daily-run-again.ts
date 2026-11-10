import { createApiClient } from './client.js';
import { ExitError, rethrowWithHint, type ApiErrorEnvelope } from './errors.js';
import { isJsonOutput, optionFlag, optionNumber, optionString, type SubcommandOptions } from './options.js';
import { printData, type OutputOptions } from './output.js';

type Overrides = { baseUrl?: string; apiKey?: string; org?: string };

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 5;
/** `bench run-again --wait` exit code when the request reported no run before --timeout. */
export const RUN_AGAIN_TIMEOUT_EXIT_CODE = 3;

// A daily Run again spends a quota row that records who asked, so the
// platform refuses org API keys (and the admin key) with 403
// user_credential_required.
function runAgainHint(status: number, envelope: ApiErrorEnvelope | null): string | undefined {
  if (status === 403 && envelope?.code === 'user_credential_required') {
    return 'Run again needs a user login: run `bench auth login` (org API keys cannot run a benchmark again). Drop --api-key and BENCHMARKS_PLATFORM_API_KEY so the login is used.';
  }
  if (status === 403 && envelope?.code === 'owner_only') {
    return "Only the daily benchmarks' owner organization can run this benchmark again.";
  }
  if (status === 403 && envelope?.code === 'category_not_entitled') {
    return "This organization is not entitled to this daily benchmark's category.";
  }
  if (status === 429 && envelope?.code === 'quota_exceeded') {
    return 'The organization already ran this benchmark again today; check the quota with `bench run-again status <benchmark-slug>`.';
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

/** `bench run-again <slug> [--wait]`: run a daily benchmark again (once per org, benchmark and UTC day). */
export async function handleRunAgain(
  slug: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  if (!slug) throw new Error('Benchmark slug required: bench run-again <benchmark-slug> [--wait]');
  const wait = optionFlag(options, 'wait');
  if (!wait && (options.timeout !== undefined || options.interval !== undefined)) {
    throw new Error('--timeout and --interval only apply with --wait');
  }
  const timeoutMs = secondsOption(options, 'timeout', DEFAULT_TIMEOUT_SECONDS) * 1000;
  const intervalMs = secondsOption(options, 'interval', DEFAULT_INTERVAL_SECONDS) * 1000;

  const { api } = await createApiClient(overrides);
  const accepted = await api.runBenchmarkAgain(slug).catch((err: unknown) => rethrowWithHint(err, runAgainHint));
  const { runAgainId } = accepted;
  const statusCommand = `bench run-again status ${slug} --request ${runAgainId}`;

  if (!wait) {
    if (isJsonOutput(output)) {
      printData(accepted, output);
      return;
    }
    console.log(`Run again of ${slug} (${accepted.category}) requested: ${runAgainId}`);
    console.log(`Follow it with \`${statusCommand}\`.`);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await api.getRunAgain(slug, runAgainId);
    if (status.runId) {
      if (isJsonOutput(output)) printData({ runAgainId, runId: status.runId }, output);
      else console.log(`Run ${status.runId} started`);
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }

  if (isJsonOutput(output)) printData({ runAgainId, runId: null }, output);
  throw new ExitError(
    `Run again ${runAgainId} reported no run within ${timeoutMs / 1000}s. Check again with \`${statusCommand}\`.`,
    RUN_AGAIN_TIMEOUT_EXIT_CODE,
  );
}

/** `bench run-again status <slug> [--request <runAgainId>]`: today's availability, or one request. */
export async function handleRunAgainStatus(
  slug: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  if (!slug) throw new Error('Benchmark slug required: bench run-again status <benchmark-slug> [--request <runAgainId>]');
  const runAgainId = optionString(options, 'request');
  const { api } = await createApiClient(overrides);

  if (runAgainId !== undefined) {
    const status = await api.getRunAgain(slug, runAgainId);
    if (isJsonOutput(output)) {
      printData(status, output);
      return;
    }
    console.log(
      status.runId
        ? `Run again ${status.runAgainId} started run ${status.runId}`
        : `Run again ${status.runAgainId} is pending; no run reported yet`,
    );
    return;
  }

  const state = await api.getRunAgainState(slug);
  if (isJsonOutput(output)) {
    printData(state, output);
    return;
  }
  const availability = state.available ? 'available' : `unavailable${state.disabledReason ? ` (${state.disabledReason})` : ''}`;
  const category = state.category ? ` (${state.category})` : '';
  console.log(`${state.benchmarkSlug}${category}: run again ${availability}`);
  console.log(`Quota ${state.quota.day}: ${state.quota.used}/${state.quota.limit} used, resets at ${state.quota.resetsAt}`);
}
