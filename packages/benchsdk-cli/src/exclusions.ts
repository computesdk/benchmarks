import { createApiClient } from './client.js';
import { confirmWrite } from './confirm.js';
import { rethrowWithHint, type ApiErrorEnvelope } from './errors.js';
import { isJsonOutput, optionFlag, optionList, optionString, type SubcommandOptions } from './options.js';
import { printData, type OutputOptions } from './output.js';

type Overrides = { baseUrl?: string; apiKey?: string; org?: string };

function adminHint(status: number, envelope: ApiErrorEnvelope | null): string | undefined {
  if (status !== 403) return undefined;
  const text = `${envelope?.error ?? ''} ${envelope?.message ?? ''}`;
  if (text.includes('insufficient_scope') || !/owner|admin/i.test(text)) return undefined;
  return 'Adding and removing exclusions needs an organization owner or admin: sign in as one (`bench auth login`) or use an org API key (--api-key or COMPUTESDK_API_KEY).';
}

async function adminWrite<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    rethrowWithHint(err, adminHint);
  }
}

function requiredOption(options: SubcommandOptions, key: string): string {
  const value = optionString(options, key)?.trim();
  if (!value) throw new Error(`--${key} is required: bench exclusions add --participant <slug> --start <iso> --end <iso> --reason <text>`);
  return value;
}

function isoOption(options: SubcommandOptions, key: string): string {
  const value = requiredOption(options, key);
  if (Number.isNaN(Date.parse(value))) throw new Error(`--${key} must be an ISO timestamp, e.g. 2026-11-25T21:25:00Z`);
  return value;
}

/** `bench exclusions list`: every exclusion the org has, newest window first as the platform returns them. */
export async function handleExclusionsList(
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const participant = optionString(options, 'participant')?.trim();
  const { api } = await createApiClient(overrides);
  const all = await api.listParticipantExclusions();
  const exclusions = participant ? all.filter((e) => e.participant === participant) : all;
  if (isJsonOutput(output)) {
    printData({ exclusions }, output);
    return;
  }
  if (exclusions.length === 0) {
    console.log(participant ? `No exclusions for ${participant}` : 'No exclusions');
    return;
  }
  printData(
    exclusions.map((e) => ({
      id: e.id,
      participant: e.participant,
      start: e.start,
      end: e.end,
      benchmarks: e.benchmarks ? e.benchmarks.join(',') : '(all)',
      reason: e.reason,
    })),
    output,
  );
}

/** `bench exclusions add`: validated locally before anything is sent. */
export async function handleExclusionsAdd(
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  const participant = requiredOption(options, 'participant');
  const start = isoOption(options, 'start');
  const end = isoOption(options, 'end');
  if (Date.parse(end) <= Date.parse(start)) throw new Error('--end must be after --start');
  const reason = requiredOption(options, 'reason');
  const benchmarks = optionList(options, 'benchmark');
  const { api } = await createApiClient(overrides);
  const exclusion = await adminWrite(() =>
    api.createParticipantExclusion({ participant, start, end, reason, ...(benchmarks ? { benchmarks } : {}) }),
  );
  if (isJsonOutput(output)) {
    printData(exclusion, output);
    return;
  }
  const scope = exclusion.benchmarks ? exclusion.benchmarks.join(', ') : 'every benchmark';
  console.log(`Excluded ${exclusion.participant} from ${exclusion.start} until ${exclusion.end} on ${scope} (id ${exclusion.id})`);
}

/** `bench exclusions remove <id>`: the participant's results count again, so it asks first. */
export async function handleExclusionsRemove(
  id: string | undefined,
  options: SubcommandOptions,
  overrides: Overrides,
  output: OutputOptions,
): Promise<void> {
  if (!id) throw new Error('Exclusion id required: bench exclusions remove <exclusion-id>');
  await confirmWrite({ yes: optionFlag(options, 'yes'), action: `remove exclusion ${id}` });
  const { api } = await createApiClient(overrides);
  const result = await adminWrite(() => api.deleteParticipantExclusion(id));
  if (isJsonOutput(output)) {
    printData(result, output);
    return;
  }
  console.log(`Removed exclusion ${result.deleted}`);
}
