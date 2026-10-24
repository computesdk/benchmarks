import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkApiError } from '@benchsdk/api';
import type {
  BenchmarkResultsOverview,
  BenchmarkRunFilterInput,
  BenchmarkRunResults,
  BenchmarkStepResultSummary,
} from '@benchsdk/api';
import { requestDeviceCode, pollDeviceToken, AuthError } from './auth.js';
import { loadCredentials, saveCredentials, clearCredentials, loadConfig } from './config.js';
import { createApiClient, getMe, listOrganizations, setActiveOrganization } from './client.js';
import { printData, type OutputOptions } from './output.js';
import { getApiBaseUrl, getAuthBaseUrl, getPlatformBaseUrl } from './platform.js';

let packageVersion: string | undefined;

async function getVersion(): Promise<string> {
  if (packageVersion) return packageVersion;

  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, '..', 'package.json'));
  }
  if (typeof __dirname === 'undefined') {
    const base = import.meta.url;
    candidates.push(fileURLToPath(new URL('../package.json', base)));
    candidates.push(fileURLToPath(new URL('../../package.json', base)));
  }

  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) {
        packageVersion = pkg.version;
        return packageVersion;
      }
    } catch {
      // try next candidate
    }
  }

  packageVersion = '0.0.0';
  return packageVersion;
}

const USAGE = `Usage: bench [options] <command>

Commands:
  auth login                         Authenticate with OAuth device flow
  auth logout                        Remove saved credentials
  auth status                        Show current user and active organization
  org list                           List organizations
  org use <slug>                     Set active organization
  benchmarks list [--limit N] [--offset N]
                                     List benchmarks
  runs list [benchmark-slug] [--limit N] [--offset N]
             [--participant <list>] [--since <when>] [--until <when>]
             [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>]
                                     List benchmark runs (omit slug to list runs
                                     across every benchmark you can read)
  runs show <benchmark-slug> <runId> Show a single run
  results <benchmark-slug> [--run <id>] [--format json|table]
             [--participant <list>] [--steps <list>|all]
             [--since <when>] [--until <when>] [--day YYYY-MM-DD]
             [--tz <zone>] [--source-org <slug>] [--limit N] [--offset N]
                                     Show benchmark or run results. --since/--until
                                     take YYYY-MM-DD, an ISO timestamp, or a
                                     relative 24h/7d/2w
  iterations <benchmark-slug> --run <id> [--participant <slug>] [--steps <list>] [--format json|table]
                                     Show per-iteration step latencies
  artifacts list <benchmark-slug> <runId> [--worker <id>]
                                     List run artifacts
  logs <benchmark-slug> <runId> [--participant <slug>] [--worker <id>] [--max-lines N]
                                     Show participant worker logs (parsed, like
                                     the dashboard log view)
  export <benchmark-slug> [--run <id>] [--out <dir>]
                                     Export benchmark or run results to JSON
  fork <benchmark-slug> [--as <new-slug>] [--source-org <slug>] [--ref <sha>]
                                     Fork a catalog benchmark into your org —
                                     a private benchmark that tracks the
                                     upstream bench file

Options:
  --base-url <url>                   Platform root URL (default: https://platform.computesdk.com)
  --api-key <key>                    Use an API key instead of OAuth
  --org <slug>                       Organization slug for this command
  --format json|table                Output format (also --json for JSON)
  --json                             Output JSON
  --verbose                          Include extra diagnostics on errors
  --version                          Show version
  --help                             Show this help
`;

interface GlobalOptions {
  'base-url'?: string;
  'api-key'?: string;
  org?: string;
  format?: 'json' | 'table';
  json?: boolean;
  verbose?: boolean;
  version?: boolean;
  help?: boolean;
}

interface ParsedOptions {
  values: GlobalOptions;
  positionals: string[];
}

export function parseGlobalArgs(argv: string[]): ParsedOptions {
  const values: GlobalOptions = {};
  const positionals: string[] = [];
  const stringGlobals = new Set(['base-url', 'api-key', 'org', 'format']);
  const booleanGlobals = new Set(['json', 'verbose', 'version', 'help']);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      i += 1;
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const namePart = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const valuePart = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    const key = namePart.slice(2);

    if (stringGlobals.has(key)) {
      const rawValue = valuePart !== undefined ? valuePart : argv[i + 1];
      if (rawValue === undefined) throw new Error(`Option --${key} requires a value`);
      (values as Record<string, string>)[key] = rawValue;
      i += valuePart !== undefined ? 1 : 2;
    } else if (booleanGlobals.has(key)) {
      if (valuePart !== undefined) {
        (values as Record<string, boolean>)[key] = valuePart === 'true' || valuePart === '1';
        i += 1;
      } else {
        (values as Record<string, boolean>)[key] = true;
        i += 1;
      }
    } else {
      // Unknown option: leave it for the subcommand parser.
      positionals.push(arg);
      i += 1;
    }
  }

  return { values, positionals };
}

const subcommandOptionSchema = {
  limit: { type: 'number' as const },
  offset: { type: 'number' as const },
  run: { type: 'string' as const },
  participant: { type: 'string' as const },
  steps: { type: 'string' as const },
  worker: { type: 'string' as const },
  'max-lines': { type: 'number' as const },
  out: { type: 'string' as const },
  since: { type: 'string' as const },
  until: { type: 'string' as const },
  day: { type: 'string' as const },
  tz: { type: 'string' as const },
  'source-org': { type: 'string' as const },
  as: { type: 'string' as const },
  ref: { type: 'string' as const },
};

export function parseSubcommandOptions(args: string[]): { options: Record<string, string | number>; positionals: string[] } {
  const options: Record<string, string | number> = {};
  const positionals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      i += 1;
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const namePart = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const valuePart = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    const key = namePart.slice(2);
    const schema = subcommandOptionSchema[key as keyof typeof subcommandOptionSchema];
    if (!schema) throw new Error(`Unknown option: ${arg}`);

    let rawValue: string;
    if (valuePart !== undefined) {
      rawValue = valuePart;
      i += 1;
    } else if (i + 1 < args.length) {
      rawValue = args[i + 1];
      i += 2;
    } else {
      throw new Error(`Option --${key} requires a value`);
    }

    if (schema.type === 'number') {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) throw new Error(`Option --${key} must be a number`);
      options[key] = n;
    } else {
      options[key] = rawValue;
    }
  }
  return { options, positionals };
}

function commandHelp(command?: string): string {
  switch (command) {
    case 'auth':
      return `Usage: bench auth <subcommand>

Subcommands:
  login      Authenticate with OAuth device flow
  logout     Remove saved credentials
  status     Show current user and active organization`;
    case 'org':
      return `Usage: bench org <subcommand>

Subcommands:
  list       List organizations
  use <slug> Set active organization`;
    case 'benchmarks':
      return `Usage: bench benchmarks list [--limit N] [--offset N]`;
    case 'runs':
      return `Usage: bench runs list [benchmark-slug] [--limit N] [--offset N]
                    [--participant <list>] [--since <when>] [--until <when>]
                    [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>]
       bench runs show <benchmark-slug> <runId>`;
    case 'results':
      return `Usage: bench results <benchmark-slug> [--run <id>] [--format json|table]
                    [--participant <list>] [--steps <list>|all]
                    [--since <when>] [--until <when>] [--day YYYY-MM-DD]
                    [--tz <zone>] [--source-org <slug>] [--limit N] [--offset N]`;
    case 'iterations':
      return `Usage: bench iterations <benchmark-slug> --run <id> [--participant <slug>] [--steps <list>] [--format json|table]`;
    case 'artifacts':
      return `Usage: bench artifacts list <benchmark-slug> <runId> [--worker <id>]`;
    case 'logs':
      return `Usage: bench logs <benchmark-slug> <runId> [--participant <slug>] [--worker <id>] [--max-lines N]`;
    case 'export':
      return `Usage: bench export <benchmark-slug> [--run <id>] [--out <dir>]`;
    case 'fork':
      return `Usage: bench fork <benchmark-slug> [--as <new-slug>] [--source-org <slug>] [--ref <sha>]`;
    default:
      return USAGE;
  }
}

async function printErrorAndExit(err: unknown, verbose = false): Promise<never> {
  if (err instanceof BenchmarkApiError) {
    const insufficientScope =
      err.message.includes('insufficient_scope') || err.body?.includes('insufficient_scope');
    console.error(`API error: ${err.message}`);
    if (err.body) console.error(err.body);
    if (insufficientScope) {
      console.error(
        'Your login does not cover this call — run `bench auth login` or `compute login` to sign in again.',
      );
    }
  } else if (err instanceof AuthError) {
    console.error(err.message);
    if (verbose && err.stack) console.error(err.stack);
    process.exit(2);
  } else if (err instanceof Error) {
    console.error(err.message);
    if (verbose && err.stack) console.error(err.stack);
  } else {
    console.error('Unexpected error:', err);
  }
  process.exit(1);
}

// Every first-party CLI (`compute`, `bench`) logs in as the same OAuth
// client with the same scope set, so one login in ~/.benchsdk/credentials.json
// covers all of them. Keep this list in sync with
// FIRST_PARTY_CLIENT_SCOPES['benchsdk-cli'] in
// benchmarks-platform lib/oauth/first-party.ts — a scope the client isn't
// registered for fails the device request with `invalid_scope`.
export const BENCH_OAUTH_CLIENT_ID = 'benchsdk-cli';
export const BENCH_OAUTH_SCOPE =
  'actions:read actions:write benchmarks:read benchmarks:write billing:read ' +
  'market:read market:write org:read org:admin sandboxes:read sandboxes:write ' +
  'vault:read vault:write offline_access';

export interface OAuthLoginOptions {
  baseUrl?: string;
  verbose?: boolean;
  /** Defaults to the shared `benchsdk-cli` client every first-party CLI uses. */
  clientId?: string;
  /** Defaults to {@link BENCH_OAUTH_SCOPE} (the full first-party set). */
  scope?: string;
}

/** Interactive RFC 8628 device login; writes ~/.benchsdk/credentials.json. */
export async function oauthLogin(options: OAuthLoginOptions = {}): Promise<void> {
  const clientId = options.clientId ?? BENCH_OAUTH_CLIENT_ID;
  const scope = options.scope ?? BENCH_OAUTH_SCOPE;
  const baseUrl = getPlatformBaseUrl(options.baseUrl);
  // getAuthBaseUrl/getApiBaseUrl tolerate a base URL that already ends in
  // /api/v1; appending the suffixes by hand would double them.
  const authBaseUrl = getAuthBaseUrl(options.baseUrl);
  const resource = getApiBaseUrl(options.baseUrl);
  const { device_code, user_code, verification_uri_complete, verification_uri, expires_in, interval } =
    await requestDeviceCode(authBaseUrl, clientId, resource, scope);

  console.log(`To sign in, visit:`);
  console.log(verification_uri_complete ?? verification_uri);
  console.log(`User code: ${user_code}`);

  const response = await pollDeviceToken(
    authBaseUrl,
    device_code,
    interval,
    expires_in,
    clientId,
    resource,
  );
  const now = Date.now();
  await saveCredentials({
    baseUrl,
    token: response.access_token,
    refreshToken: response.refresh_token,
    tokenExpiresAt: now + response.expires_in * 1000,
    kind: 'oauth',
    clientId,
  });

  console.log('Authenticated.');

  try {
    const { auth } = await createApiClient({ baseUrl });
    const me = await getMe(auth);
    if (!me.activeOrganizationId && me.organizations.length === 1) {
      const org = me.organizations[0];
      await setActiveOrganization(auth, org.slug);
      const existing = (await loadCredentials()) ?? {};
      await saveCredentials({
        ...existing,
        baseUrl,
        token: auth.token,
        refreshToken: auth.refreshToken,
        tokenExpiresAt: auth.tokenExpiresAt,
        refreshExpiresAt: auth.refreshExpiresAt,
        orgSlug: org.slug,
        orgId: org.id,
        kind: 'oauth',
        clientId,
      });
      console.log(`Set active organization to ${org.slug}`);
    }
  } catch (err) {
    if (options.verbose) {
      console.error('Organization auto-select failed:', err instanceof Error ? err.message : err);
    }
    // organization auto-select is best-effort
  }
}

async function handleAuthLogout(): Promise<void> {
  await clearCredentials();
  console.log('Logged out.');
}

async function handleAuthStatus(
  overrides: { baseUrl?: string; apiKey?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { auth } = await createApiClient(overrides);
  const me = await getMe(auth);
  const activeOrg = me.organizations.find((o) => o.id === me.activeOrganizationId);
  printData(
    {
      user: me.user,
      activeOrganization: activeOrg ?? null,
      organizations: me.organizations,
    },
    outputOptions,
  );
}

async function handleOrgList(
  overrides: { baseUrl?: string; apiKey?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { auth } = await createApiClient(overrides);
  const organizations = await listOrganizations(auth);
  printData(organizations, outputOptions);
}

async function handleOrgUse(slug: string, overrides: { baseUrl?: string; apiKey?: string }): Promise<void> {
  const credentials = (await loadCredentials()) ?? {};
  const { auth } = await createApiClient(overrides);
  const result = await setActiveOrganization(auth, slug);
  if (!result.organization) {
    throw new Error(`Could not set active organization to ${slug}`);
  }
  await saveCredentials({
    ...credentials,
    baseUrl: auth.baseUrl,
    token: auth.token,
    refreshToken: auth.refreshToken,
    tokenExpiresAt: auth.tokenExpiresAt,
    refreshExpiresAt: auth.refreshExpiresAt,
    orgSlug: result.organization.slug,
    orgId: result.organization.id,
    kind: 'oauth',
  });
  console.log(`Active organization set to ${result.organization.slug} (${result.organization.id})`);
}

async function handleBenchmarksList(
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  options: { limit?: number; offset?: number },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const benchmarks = await api.listBenchmarks(options);
  printData(benchmarks, outputOptions);
}

interface ResultFilterOptions {
  participant?: string;
  steps?: string;
  since?: string;
  until?: string;
  day?: string;
  tz?: string;
  'source-org'?: string;
}

const RELATIVE_BOUND = /^(\d+)([hdw])$/;

// `--since/--until` accept YYYY-MM-DD, a full ISO timestamp, or a relative
// `24h`/`7d`/`2w` resolved to an instant here (the server only knows absolute
// bounds). `--day` is sugar for since=<day>&until=<day>; a date-only until
// already includes the whole day server-side. `--tz` defaults to the local
// machine zone so `bench results --day` reads naturally.
function resolveResultFilter(
  options: ResultFilterOptions,
  { allowSteps }: { allowSteps: boolean },
): { filter: BenchmarkRunFilterInput & { steps?: string[] | 'all' }; flagsSent: boolean } {
  if (options.day && (options.since || options.until)) {
    throw new Error('--day cannot be combined with --since/--until');
  }
  if (!allowSteps && options.steps !== undefined) {
    throw new Error('--steps only applies to `bench results`');
  }

  const resolveBound = (raw: string): string => {
    const rel = RELATIVE_BOUND.exec(raw.trim());
    if (!rel) return raw;
    const n = Number(rel[1]);
    const ms = rel[2] === 'h' ? n * 3_600_000 : rel[2] === 'd' ? n * 86_400_000 : n * 604_800_000;
    return new Date(Date.now() - ms).toISOString();
  };

  const filter: BenchmarkRunFilterInput & { steps?: string[] | 'all' } = {};
  const participants = options.participant
    ? options.participant.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  if (options.participant !== undefined && !participants?.length) {
    throw new Error('--participant must name at least one participant slug');
  }
  if (participants?.length) filter.participants = participants;
  if (options.since) filter.since = resolveBound(options.since);
  if (options.until) filter.until = resolveBound(options.until);
  if (options.day) {
    filter.since = options.day;
    filter.until = options.day;
  }
  filter.timeZone =
    options.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  if (options['source-org']) filter.sourceOrg = options['source-org'];

  if (allowSteps && options.steps !== undefined) {
    const steps =
      options.steps.trim() === 'all'
        ? 'all'
        : options.steps.split(',').map((s) => s.trim()).filter(Boolean);
    if (steps !== 'all' && steps.length === 0) {
      throw new Error('--steps must name at least one step name (or "all")');
    }
    filter.steps = steps;
  }

  const flagsSent =
    participants !== undefined ||
    options.since !== undefined ||
    options.until !== undefined ||
    options.day !== undefined ||
    options.steps !== undefined ||
    options.tz !== undefined ||
    options['source-org'] !== undefined;
  return { filter, flagsSent };
}

// A filter flag was sent but the response carries no `filter` echo → the
// platform predates the filter feature and silently ignored it. Fail loudly
// instead of printing unfiltered results under a filtered-looking command.
function assertFilterEcho(filter: unknown): void {
  if (filter === undefined || filter === null) {
    throw new Error(
      'The API did not return a `filter` echo — this platform does not support result filters yet',
    );
  }
}

async function handleRunsList(
  benchmarkSlug: string | undefined,
  options: { limit?: number; offset?: number } & ResultFilterOptions,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const { filter, flagsSent } = resolveResultFilter(options, { allowSteps: false });
  if (!benchmarkSlug) {
    if (flagsSent) {
      throw new Error('Result filters require a benchmark slug: bench runs list <benchmark-slug>');
    }
    const runs = await api.listAllRuns(options);
    printData(runs, outputOptions);
    return;
  }
  const result = await api.listRuns(benchmarkSlug, {
    limit: options.limit,
    offset: options.offset,
    ...(flagsSent ? filter : {}),
  });
  if (flagsSent) assertFilterEcho(result.filter);
  if (outputOptions.json || outputOptions.format === 'json') {
    printData(result, outputOptions);
  } else {
    printData(result.items, outputOptions);
  }
}

async function handleRunsShow(
  benchmarkSlug: string,
  runId: string,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const run = await api.getRun(benchmarkSlug, runId);
  printData(run, outputOptions);
}

async function handleResults(
  benchmarkSlug: string,
  options: { run?: string; format?: string; limit?: number; offset?: number } & ResultFilterOptions,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const { filter, flagsSent } = resolveResultFilter(options, { allowSteps: true });
  if (options.run && flagsSent) {
    throw new Error('Result filters do not apply to a single --run');
  }
  const results = options.run
    ? await api.getRunResults(benchmarkSlug, options.run as string)
    : await api.getBenchmarkResults(benchmarkSlug, {
        limit: options.limit,
        offset: options.offset,
        ...(flagsSent ? filter : {}),
      });
  if (!options.run && flagsSent) {
    assertFilterEcho((results as BenchmarkResultsOverview).filter);
  }
  if (options.format === 'json' || outputOptions.json || outputOptions.format === 'json') {
    printData(results, { format: 'json' });
    return;
  }
  printResultsTables(results, options.run !== undefined);
}

type ParticipantResultRow = BenchmarkRunResults['participants'][number] & { runId?: string };

function fmtMs(value: number | null): number | string {
  if (value === null) return '';
  if (value < 10) {
    const rounded = Number(value.toFixed(2));
    return rounded === 0 && value > 0 ? '<0.01' : rounded;
  }
  return Math.round(value);
}

function fmtRate(rate: number): string {
  if (rate === 1) return '100%';
  const pct = (rate * 100).toFixed(1);
  return pct === '100.0' ? '99.9%' : `${pct}%`;
}

function participantTableRow(p: ParticipantResultRow): Record<string, unknown> {
  return {
    ...(p.runId ? { run: p.runId } : {}),
    participant: p.participantSlug,
    provider: p.provider ?? '',
    tasks: p.taskCount,
    ok: p.successCount,
    err: p.errorCount,
    'ok%': fmtRate(p.successRate),
    p50ms: fmtMs(p.latencyMs.p50),
    avgms: fmtMs(p.latencyMs.avg),
    p95ms: fmtMs(p.latencyMs.p95),
  };
}

function stepTableRow(s: BenchmarkStepResultSummary): Record<string, unknown> {
  return {
    participant: s.participantSlug,
    step: s.stepName,
    tasks: s.stepCount,
    ok: s.successCount,
    err: s.errorCount,
    'ok%': fmtRate(s.successRate),
    p50ms: fmtMs(s.latencyMs.p50),
    avgms: fmtMs(s.latencyMs.avg),
  };
}

function printResultsTables(
  results: BenchmarkRunResults | BenchmarkResultsOverview,
  isSingleRun: boolean,
): void {
  if (isSingleRun) {
    const runResults = results as BenchmarkRunResults;
    const { run, overall, participants, steps } = runResults;
    console.log(
      `Run ${run.id} — ${run.status} | overall: ${overall.successCount}/${overall.taskCount} ok (${fmtRate(overall.successRate)})`,
    );
    if (participants.length === 0) {
      console.log('No results.');
    } else {
      console.table(participants.map(participantTableRow));
    }
    if (steps.length > 0) {
      console.log('Steps:');
      console.table(steps.map(stepTableRow));
    }
    return;
  }

  const overview = results as BenchmarkResultsOverview;
  if (overview.analytics.query === 'unavailable') {
    console.log(`Results unavailable${overview.analytics.error ? `: ${overview.analytics.error}` : '.'}`);
    return;
  }
  const rows = overview.items.flatMap((item) =>
    item.participants.map((p) => participantTableRow({ ...p, runId: item.run.id })),
  );
  const emptyRuns = overview.items.filter((item) => item.participants.length === 0);
  if (emptyRuns.length > 0) {
    for (const item of emptyRuns) {
      console.log(
        `Run ${item.run.id} — ${item.run.status} | no participant results (analytics: ${item.analytics.status})`,
      );
    }
  }
  if (rows.length === 0) {
    if (emptyRuns.length === 0) console.log('No results.');
  } else {
    console.table(rows);
  }
  // One row per run × participant × step when --steps was sent.
  const stepRows = overview.items.flatMap((item) =>
    (item.steps ?? []).map((s) => ({ run: item.run.id, ...stepTableRow(s) })),
  );
  if (stepRows.length > 0) {
    console.log('Steps:');
    console.table(stepRows);
  }
}

async function handleIterations(
  benchmarkSlug: string,
  options: { run?: string; participant?: string; steps?: string },
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  if (!options.run) {
    throw new Error('Usage: bench iterations <benchmark-slug> --run <id> [--participant <slug>] [--steps <list>]');
  }
  const { api } = await createApiClient(overrides);
  const steps = options.steps
    ? options.steps.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const { steps: rows } = await api.getRunStepIterations(benchmarkSlug, options.run, {
    participant: options.participant,
    steps,
  });
  const formatted = rows.map((row) => ({
    participantSlug: row.participantSlug,
    taskIndex: row.taskIndex,
    stepName: row.stepName,
    status: row.status,
    latencyMs: row.latencyMs,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    ...row.data,
  }));
  printData(formatted, outputOptions);
}

async function handleArtifactsList(
  benchmarkSlug: string,
  runId: string,
  workerId: string | undefined,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const artifacts = workerId
    ? await api.listWorkerArtifacts(benchmarkSlug, runId, workerId)
    : await api.listRunArtifacts(benchmarkSlug, runId);
  printData(artifacts, outputOptions);
}

function formatLogLine(line: { n: number; ts: string | null; level: string; msg: string }): string {
  const ts = line.ts ? line.ts.slice(11, 23) : ''.padEnd(12);
  return `${ts} ${line.level.padEnd(5)} ${line.msg}`;
}

async function handleLogs(
  benchmarkSlug: string,
  runId: string,
  options: { participant?: string; worker?: string; 'max-lines'?: string | number },
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const maxLines = options['max-lines'] !== undefined ? Number(options['max-lines']) : undefined;
  if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
    throw new Error('--max-lines must be a positive integer');
  }

  const participantSlugs = options.participant
    ? [options.participant]
    : (await api.listParticipants(benchmarkSlug, runId)).map((p) => p.slug);

  const results = [];
  for (const slug of participantSlugs) {
    const logs = await api.getParticipantLogs(benchmarkSlug, runId, slug, { maxLines });
    if (options.worker) {
      logs.workers = logs.workers.filter((w) => w.workerId === options.worker);
    }
    results.push(logs);
  }

  if (outputOptions.json || outputOptions.format === 'json') {
    printData(options.participant ? results[0] : results, outputOptions);
    return;
  }

  for (const result of results) {
    for (const worker of result.workers) {
      console.log(`== ${result.participant} worker ${worker.workerIndex} (${worker.workerId}) ==`);
      if (!worker.log) {
        console.log('  (no log artifact)');
        continue;
      }
      for (const line of worker.log.lines) {
        console.log(formatLogLine(line));
      }
      if (worker.log.totalLines > worker.log.lines.length) {
        console.log(`  ... ${worker.log.totalLines - worker.log.lines.length} earlier lines truncated`);
      }
    }
  }
}

async function handleExport(
  benchmarkSlug: string,
  options: { run?: string; out?: string },
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const outDir = options.out ?? '.';
  await mkdir(outDir, { recursive: true });

  if (options.run) {
    const runId = options.run as string;
    const [run, results] = await Promise.all([api.getRun(benchmarkSlug, runId), api.getRunResults(benchmarkSlug, runId)]);
    const payload = { benchmarkSlug, runId, run, results };
    const path = join(outDir, `${benchmarkSlug}-${runId}.json`);
    await writeFile(path, JSON.stringify(payload, null, 2));
    console.log(`Exported to ${path}`);
  } else {
    const results = await api.getBenchmarkResults(benchmarkSlug);
    const path = join(outDir, `${benchmarkSlug}.json`);
    await writeFile(path, JSON.stringify(results, null, 2));
    console.log(`Exported to ${path}`);
  }
}

// `bench fork dax` → a private benchmark in your org whose config.upstream
// points back at the catalog source. The fork is a normal org benchmark —
// it's yours, invisible to others, and tracks the upstream bench file
// unless --ref pins it.
async function handleFork(
  slug: string,
  options: Record<string, string | number>,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions,
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const sourceOrg = (options['source-org'] as string | undefined) ?? 'computesdk';
  const newSlug = (options.as as string | undefined) ?? slug;
  const ref = options.ref as string | undefined;

  const { source } = await api.getForeignBenchmark(sourceOrg, slug);
  if (!source) {
    throw new Error(
      `The platform can't attribute a source file to "${slug}" — only benchmarks with a platform-attributed source can be forked.`,
    );
  }

  const upstream = {
    org: sourceOrg,
    slug,
    source: { ...source, ...(ref ? { ref } : {}) },
  };

  // A slug that already exists keeps its own config — upstream merges in,
  // so re-forking onto an established benchmark doesn't drop scoring or
  // display settings.
  let existing: { config?: Record<string, unknown> } | null = null;
  try {
    existing = await api.getBenchmark(newSlug);
  } catch {
    existing = null;
  }
  const config = { ...(existing?.config ?? {}), upstream };
  const benchmark = existing
    ? await api.updateBenchmark(newSlug, { config })
    : await api.upsertBenchmark(newSlug, { config });

  printData(benchmark, outputOptions);
  console.log(
    `Forked ${sourceOrg}/${slug} → ${newSlug}` +
      (ref ? ` (pinned to ${ref})` : ` (tracking ${source.githubOwner}/${source.repo}@${source.ref})`),
  );
  console.log(`Source: ${source.githubOwner}/${source.repo} ${source.path}`);
  console.log(
    `\nRun it: checkout the bench file in your own Actions — ` +
      `git clone https://github.com/${source.githubOwner}/${source.repo} && ` +
      `cd ${source.repo}` +
      (ref ? ` && git checkout ${ref}` : '') +
      ` && bench run ${source.path} --benchmark ${newSlug} --provider <your-provider>`,
  );
}

function toOutputOptions(values: GlobalOptions): OutputOptions {
  return {
    json: !!values.json,
    format: values.format ?? (values.json ? 'json' : 'table'),
  };
}

export async function run(argv: string[]): Promise<void> {
  let values: GlobalOptions;
  let positionals: string[];
  try {
    ({ values, positionals } = parseGlobalArgs(argv));
  } catch (err) {
    await printErrorAndExit(err, false);
    return;
  }

  if (values.version) {
    console.log(await getVersion());
    process.exit(0);
  }

  if (values.help || positionals.length === 0) {
    if (values.help && positionals.length > 0) {
      console.log(commandHelp(positionals[0]));
    } else {
      console.log(USAGE);
    }
    process.exit(values.help || positionals.length === 0 ? 0 : 1);
  }

  const config = (await loadConfig()) ?? {};
  const overrides = {
    baseUrl: values['base-url'] ?? config.baseUrl,
    apiKey: values['api-key'],
    org: values.org ?? config.org,
  };
  const outputOptions: OutputOptions = toOutputOptions(values);

  try {
    const [command, ...rest] = positionals;

    if (rest.includes('--help')) {
      console.log(commandHelp(command));
      process.exit(0);
    }

    switch (command) {
      case 'auth': {
        const [sub, ...subRest] = rest;
        if (sub === 'login') {
          await oauthLogin({ baseUrl: overrides.baseUrl, verbose: values.verbose });
        } else if (sub === 'logout') {
          await handleAuthLogout();
        } else if (sub === 'status') {
          await handleAuthStatus(overrides, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'org': {
        const [sub, ...subRest] = rest;
        const { positionals: subPositionals } = parseSubcommandOptions(subRest);
        if (sub === 'list') {
          await handleOrgList(overrides, outputOptions);
        } else if (sub === 'use') {
          const slug = subPositionals[0];
          if (!slug) throw new Error('Organization slug required: bench org use <slug>');
          await handleOrgUse(slug, overrides);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'benchmarks': {
        const [sub, ...subRest] = rest;
        const { options } = parseSubcommandOptions(subRest);
        if (sub === 'list') {
          await handleBenchmarksList(overrides, options, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'runs': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [sub, slug, runId] = subPositionals;
        if (sub === 'list') {
          await handleRunsList(slug, options, overrides, outputOptions);
        } else if (sub === 'show') {
          if (!slug || !runId) throw new Error('Usage: bench runs show <benchmark-slug> <runId>');
          await handleRunsShow(slug, runId, overrides, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'results': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench results <benchmark-slug>');
        await handleResults(slug, options, overrides, outputOptions);
        break;
      }
      case 'iterations': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench iterations <benchmark-slug>');
        await handleIterations(slug, options, overrides, outputOptions);
        break;
      }
      case 'artifacts': {
        const [sub, ...subRest] = rest;
        const { options, positionals: subPositionals } = parseSubcommandOptions(subRest);
        if (sub === 'list') {
          const [slug, runId] = subPositionals;
          if (!slug || !runId) throw new Error('Usage: bench artifacts list <benchmark-slug> <runId>');
          await handleArtifactsList(slug, runId, options.worker as string | undefined, overrides, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'logs': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [slug, runId] = subPositionals;
        if (!slug || !runId) throw new Error('Usage: bench logs <benchmark-slug> <runId>');
        await handleLogs(slug, runId, options, overrides, outputOptions);
        break;
      }
      case 'export': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench export <benchmark-slug>');
        await handleExport(slug, options, overrides);
        break;
      }
      case 'fork': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench fork <benchmark-slug>');
        await handleFork(slug, options, overrides, outputOptions);
        break;
      }
      default:
        throw new Error(USAGE);
    }
    process.exit(0);
  } catch (err) {
    await printErrorAndExit(err, values.verbose);
  }
}

