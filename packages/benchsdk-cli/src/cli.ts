import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkApiError } from '@benchsdk/api';
import type {
  BenchmarkClient,
  BenchmarkReliabilityDay,
  BenchmarkReliabilityRange,
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
import { findCommand, groupFlags, GLOBAL_BOOLEAN_FLAGS, GLOBAL_STRING_FLAGS } from './commands.js';
import { ExitError, formatApiError } from './errors.js';
import { optionChoice, optionFlag, optionList, type SubcommandOptions } from './options.js';
import {
  RUN_ARCHIVED_FILTERS,
  handleBenchmarkArchive,
  handleBenchmarkDescribe,
  handleBenchmarkMute,
  handleBenchmarkPause,
  handleBenchmarksList,
  handleRunsArchive,
} from './manage.js';
import {
  assertBenchmarkSlugsHonored,
  handleActivity,
  handleReliabilityCards,
  handleRunDays,
  handleRunsDay,
  handleRunsFeed,
} from './feed.js';
import { handleRunAgain, handleRunAgainStatus } from './daily-run-again.js';

let packageVersion: string | undefined;

export async function getVersion(): Promise<string> {
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
  benchmarks list [--limit N] [--offset N] [--status active|archived|all]
                                     List benchmarks
  benchmarks archive <benchmark-slug> [-y]
                                     Archive a benchmark and all of its runs
  benchmarks restore <benchmark-slug>
                                     Restore an archived benchmark
  benchmarks describe <benchmark-slug> [--tagline <text>] [--description <text>]
             [--description-file <path>] [--clear-tagline] [--clear-description]
                                     Set or clear the tagline and description
  benchmarks mute|unmute <benchmark-slug>
                                     Mute or unmute a benchmark for the org
  benchmarks pause <benchmark-slug> [--start <iso>] [--end <iso>]
  benchmarks resume <benchmark-slug> Pause or resume a reliability benchmark
  runs list [benchmark-slug] [--limit N] [--offset N]
             [--participant <list>] [--since <when>] [--until <when>]
             [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>]
             [--archived exclude|include|only] [--include-muted]
             [--benchmark <slug>]...
                                     List benchmark runs (omit slug to list runs
                                     across every benchmark you can read)
  runs show <benchmark-slug> <runId> Show a single run
  runs run-again <benchmark-slug> <runId> [--wait] [--timeout <seconds>]
                                     Run the benchmark again on the latest code
  runs run-again-status <benchmark-slug> <runAgainId>
                                     Show run-again progress
  runs feed [--benchmark <slug>]... [--include-archived] [--include-muted]
             [--limit N]             The org's newest runs across benchmarks
  runs days [feed filters] [--tz <zone>]
                                     Run counts per local day
  runs day <YYYY-MM-DD> [feed filters] [--tz <zone>] [--all]
             [--cursor <createdAt>,<id>]
                                     One day's runs (--all follows every page)
  runs archive|unarchive <runId...> [-y]
                                     Archive or unarchive up to 100 runs
  results <benchmark-slug> [--run <id>] [--format json|table]
             [--participant <list>] [--steps <list>|all]
             [--since <when>] [--until <when>] [--day YYYY-MM-DD]
             [--tz <zone>] [--source-org <slug>] [--limit N] [--offset N]
                                     Show benchmark or run results. --since/--until
                                     take YYYY-MM-DD, an ISO timestamp, or a
                                     relative 24h/7d/2w
  reliability <benchmark-slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
             [--bucket day|hour] [--tz <zone>] [--metrics <list>]
             [--breakdown <list>] [--source-org <slug>] [--format json|table]
                                     Reliability uptime view for a
                                     type=reliability benchmark (default:
                                     last 7 days aggregated per participant)
  reliability <benchmark-slug> --day YYYY-MM-DD --participant <slug>
             [--tz <zone>] [--source-org <slug>] [--format json|table]
                                     Per-slot view of one participant on one
                                     local day
  reliability cards [--include-muted] The org's reliability cards
  activity [--days N] [--benchmark <slug>]
                                     Run counts per day (N from 1 to 90)
  run-again <benchmark-slug> [--wait] [--timeout <sec>] [--interval <sec>]
                                     Run a daily benchmark again (once per org
                                     and UTC day; needs a user login; --wait
                                     exits 3 on timeout)
  run-again status <benchmark-slug> [--request <runAgainId>]
                                     Run again availability and quota, or one request
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

Writes that hide data (benchmarks archive, runs archive|unarchive) ask for
confirmation on a terminal; elsewhere they need -y/--yes or exit 1 unchanged.
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
  const stringGlobals = new Set<string>(GLOBAL_STRING_FLAGS);
  const booleanGlobals = new Set<string>(GLOBAL_BOOLEAN_FLAGS);

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

type OptionType = 'string' | 'number' | 'boolean' | 'list';

const subcommandOptionSchema: Record<string, { type: OptionType }> = {
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
  from: { type: 'string' as const },
  to: { type: 'string' as const },
  bucket: { type: 'string' as const },
  metrics: { type: 'string' as const },
  breakdown: { type: 'string' as const },
  as: { type: 'string' as const },
  ref: { type: 'string' as const },
  wait: { type: 'boolean' as const },
  timeout: { type: 'number' as const },
  status: { type: 'string' },
  yes: { type: 'boolean' },
  tagline: { type: 'string' },
  description: { type: 'string' },
  'description-file': { type: 'string' },
  'clear-tagline': { type: 'boolean' },
  'clear-description': { type: 'boolean' },
  start: { type: 'string' },
  end: { type: 'string' },
  archived: { type: 'string' },
  'include-muted': { type: 'boolean' },
  'include-archived': { type: 'boolean' },
  benchmark: { type: 'list' },
  all: { type: 'boolean' },
  cursor: { type: 'string' },
  days: { type: 'number' },
  interval: { type: 'number' },
  request: { type: 'string' },
};

const SHORT_OPTIONS: Record<string, string> = { '-y': 'yes' };

/** Whether `--name` takes a value (`false` for switches such as `--yes`). */
export function flagTakesValue(name: string): boolean {
  const schema = subcommandOptionSchema[name];
  return schema !== undefined && schema.type !== 'boolean';
}

export function parseSubcommandOptions(
  args: string[],
  allowed?: readonly string[],
): { options: SubcommandOptions; positionals: string[] } {
  const options: SubcommandOptions = {};
  const positionals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const shortKey = SHORT_OPTIONS[arg];
    if (!arg.startsWith('--') && shortKey === undefined) {
      positionals.push(arg);
      i += 1;
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const namePart = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const valuePart = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    const key = shortKey ?? namePart.slice(2);
    const schema = subcommandOptionSchema[key];
    if (!schema) throw new Error(`Unknown option: ${arg}`);
    // The schema is global — a flag another command understands would
    // otherwise be silently ignored here (e.g. `bench results --from`
    // printing unfiltered results).
    if (allowed !== undefined && !allowed.includes(key)) {
      throw new Error(`Unknown option for this command: ${shortKey ? `--${key}` : arg}`);
    }

    if (schema.type === 'boolean') {
      if (valuePart !== undefined) {
        throw new Error(`Option --${key} does not take a value`);
      }
      options[key] = true;
      i += 1;
      continue;
    }

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
    } else if (schema.type === 'list') {
      // Repeatable, and each occurrence may itself be a comma list.
      const values = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
      if (values.length === 0) throw new Error(`Option --${key} needs at least one value`);
      const existing = options[key];
      options[key] = [...(Array.isArray(existing) ? existing : []), ...values];
    } else {
      options[key] = rawValue;
    }
  }
  return { options, positionals };
}

/** Rejects options parsed with a group's flag union that this subcommand does not take. */
function assertCommandFlags(path: string[], options: SubcommandOptions): void {
  const allowed = flagsOf(...path);
  const extra = Object.keys(options).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`Unknown option for this command: --${extra}`);
}

function flagsOf(...path: string[]): readonly string[] {
  const command = findCommand(path);
  if (!command) throw new Error(`bench ${path.join(' ')} is missing from COMMANDS`);
  return command.flags;
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
      return `Usage: bench benchmarks list [--limit N] [--offset N] [--status active|archived|all]
       bench benchmarks archive <benchmark-slug> [-y]
       bench benchmarks restore <benchmark-slug>
       bench benchmarks describe <benchmark-slug> [--tagline <text>] [--description <text>]
                    [--description-file <path>] [--clear-tagline] [--clear-description]
       bench benchmarks mute <benchmark-slug>
       bench benchmarks unmute <benchmark-slug>
       bench benchmarks pause <benchmark-slug> [--start <iso>] [--end <iso>]
       bench benchmarks resume <benchmark-slug>

archive hides the benchmark and all of its runs; it asks first on a
terminal and needs -y/--yes anywhere else. Management writes need an
organization owner or admin (or an org API key). pause and resume apply
to reliability benchmarks only.`;
    case 'runs':
      return `Usage: bench runs list [benchmark-slug] [--limit N] [--offset N]
                    [--participant <list>] [--since <when>] [--until <when>]
                    [--day YYYY-MM-DD] [--tz <zone>] [--source-org <slug>]
                    [--archived exclude|include|only] [--include-muted]
                    [--benchmark <slug>]...
       bench runs show <benchmark-slug> <runId>
       bench runs run-again <benchmark-slug> <runId> [--wait] [--timeout <seconds>]
       bench runs run-again-status <benchmark-slug> <runAgainId>
       bench runs archive <runId...> [-y]
       bench runs unarchive <runId...> [-y]
       bench runs feed [--benchmark <slug>]... [--include-archived] [--include-muted] [--limit N]
       bench runs days [--benchmark <slug>]... [--include-archived] [--include-muted] [--tz <zone>]
       bench runs day <YYYY-MM-DD> [--benchmark <slug>]... [--include-archived] [--include-muted]
                    [--tz <zone>] [--all] [--cursor <createdAt>,<id>]

Run lists leave out archived runs unless --archived include|only is given.
The cross-benchmark list (no slug) keeps runs of muted benchmarks, as it
always has; --include-muted only says so explicitly, and a single
benchmark's list takes no mute flag.
archive and unarchive take up to 100 run ids, ask first on a terminal, and
need -y/--yes anywhere else.

feed, days and day read the organization-wide feed the dashboard shows:
--benchmark (repeatable, or a comma list) narrows it, and archived runs and
runs of muted benchmarks stay out unless --include-archived/--include-muted.
--tz defaults to this machine's zone. day prints one page (150 runs) with
its nextCursor ({createdAt, id}); pass it back as --cursor <createdAt>,<id>,
or use --all to follow every page and print one array of runs.`;
    case 'results':
      return `Usage: bench results <benchmark-slug> [--run <id>] [--format json|table]
                    [--participant <list>] [--steps <list>|all]
                    [--since <when>] [--until <when>] [--day YYYY-MM-DD]
                    [--tz <zone>] [--source-org <slug>] [--limit N] [--offset N]`;
    case 'reliability':
      return `Usage: bench reliability <benchmark-slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                    [--bucket day|hour] [--tz <zone>] [--metrics <list>]
                    [--breakdown <list>] [--source-org <slug>] [--format json|table]
       bench reliability <benchmark-slug> --day YYYY-MM-DD --participant <slug>
                    [--tz <zone>] [--source-org <slug>] [--format json|table]
       bench reliability cards [--include-muted]

cards lists the organization's reliability benchmarks as the dashboard does;
muted ones stay out unless --include-muted.`;
    case 'activity':
      return `Usage: bench activity [--days N] [--benchmark <slug>]

Run counts per day for the organization, or for one benchmark. --days takes
1 to 90 (the platform defaults to 30).`;
    case 'run-again':
      return `Usage: bench run-again <benchmark-slug> [--wait] [--timeout <sec>] [--interval <sec>]
       bench run-again status <benchmark-slug> [--request <runAgainId>]

run-again runs a daily benchmark again, the dashboard's Run again button (one
request per organization, benchmark and UTC day). It needs a user login
(\`bench auth login\`); org API keys cannot run a benchmark again.
--wait polls the request every --interval seconds (default 5) until it
reports its run, and exits 3 if none has after --timeout seconds (default 600).
status shows today's availability and quota, or one request with --request.`;
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
  if (err instanceof ExitError) {
    if (err.message) console.error(err.message);
    process.exit(err.exitCode);
  }
  if (err instanceof BenchmarkApiError) {
    const insufficientScope =
      err.message.includes('insufficient_scope') || err.body?.includes('insufficient_scope');
    for (const line of formatApiError(err, verbose)) console.error(line);
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

export interface ResultFilterOptions {
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
export function resolveResultFilter(
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
  if (options['source-org'] !== undefined) {
    const sourceOrg = options['source-org'].trim();
    if (!sourceOrg) throw new Error('--source-org must name an organization slug');
    filter.sourceOrg = sourceOrg;
  }

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

  // `--tz` and `--source-org` are not result filters: tz only interprets
  // date bounds and sourceOrg routes to `~/org/slug`, which predates the
  // filter feature — counting them would false-positive the "platform too
  // old" check on an old platform where sourceOrg works fine.
  const flagsSent =
    participants !== undefined ||
    options.since !== undefined ||
    options.until !== undefined ||
    options.day !== undefined ||
    options.steps !== undefined;
  return { filter, flagsSent };
}

// A filter flag was sent but the response carries no `filter` echo → the
// platform predates the filter feature and silently ignored it. Fail loudly
// instead of printing unfiltered results under a filtered-looking command.
export function assertFilterEcho(filter: unknown): void {
  if (filter === undefined || filter === null) {
    throw new Error(
      'The API did not return a `filter` echo — this platform does not support result filters yet',
    );
  }
}

export type RunsListOptions = { limit?: number; offset?: number } & ResultFilterOptions & SubcommandOptions;

// `--archived only` against a platform that predates the archive filter
// would print active runs under an archived-looking command.
function assertArchivedOnly(runs: readonly { archivedAt?: string | null }[]): void {
  if (runs.some((run) => !run.archivedAt)) {
    throw new Error(
      '--archived only returned runs that are not archived — this platform does not support the archived filter yet',
    );
  }
}

export async function handleRunsList(
  benchmarkSlug: string | undefined,
  options: RunsListOptions,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const archived = optionChoice(options, 'archived', RUN_ARCHIVED_FILTERS);
  // The cross-benchmark list keeps muted benchmarks' runs by default, so
  // includeMuted=1 restates the default; a single benchmark's list has no
  // mute filter at all.
  const includeMuted = optionFlag(options, 'include-muted') || undefined;
  const benchmarkSlugs = optionList(options, 'benchmark');
  if (benchmarkSlugs && benchmarkSlug) {
    throw new Error('Pass either a benchmark slug or --benchmark, not both');
  }
  if (includeMuted && benchmarkSlug) {
    throw new Error('--include-muted applies to the cross-benchmark list (omit the benchmark slug)');
  }
  const { filter, flagsSent } = resolveResultFilter(options, { allowSteps: false });
  // Validate flag combinations before auth/API setup — a rejected command
  // should not need credentials.
  if (!benchmarkSlug) {
    if (flagsSent) {
      throw new Error('Result filters require a benchmark slug: bench runs list <benchmark-slug>');
    }
    if (filter.sourceOrg) {
      // `~/org/slug` needs a slug — listAllRuns has no org dimension, so a
      // bare --source-org would otherwise be silently ignored.
      throw new Error('--source-org requires a benchmark slug: bench runs list <benchmark-slug>');
    }
  }
  const { api } = await createApiClient(overrides);
  if (!benchmarkSlug) {
    const runs = await api.listAllRuns({
      limit: options.limit,
      offset: options.offset,
      benchmarkSlugs,
      archived,
      includeMuted,
    });
    assertBenchmarkSlugsHonored(runs, benchmarkSlugs);
    if (archived === 'only') assertArchivedOnly(runs);
    printData(runs, outputOptions);
    return;
  }
  const result = await api.listRuns(benchmarkSlug, {
    limit: options.limit,
    offset: options.offset,
    archived,
    // sourceOrg isn't a result filter (see resolveResultFilter) — send it
    // even when it's the only flag, on any platform version.
    ...(filter.sourceOrg ? { sourceOrg: filter.sourceOrg } : {}),
    ...(flagsSent ? filter : {}),
  });
  if (flagsSent) assertFilterEcho(result.appliedFilter);
  if (archived === 'only') assertArchivedOnly(result);
  if (outputOptions.json || outputOptions.format === 'json') {
    printData(
      { items: [...result], filter: result.appliedFilter ?? null, upgrade: result.upgrade ?? null },
      outputOptions,
    );
  } else {
    printData(result, outputOptions);
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

export async function waitForRunAgain(
  api: Pick<BenchmarkClient, 'getRunAgain'>,
  slug: string,
  runAgainId: string,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;

  while (true) {
    const { runId } = await api.getRunAgain(slug, runAgainId);
    if (runId !== null) return runId;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  }

  throw new Error(
    `Timed out after ${opts.timeoutMs / 1_000}s waiting for run again ${runAgainId}; check later with: bench runs run-again-status ${slug} ${runAgainId}`,
  );
}

export async function handleRunsRunAgain(
  benchmarkSlug: string,
  runId: string,
  options: { wait?: boolean; timeout?: number },
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  if (options.timeout !== undefined && !options.wait) {
    throw new Error('--timeout requires --wait');
  }
  const timeoutSeconds = options.timeout ?? 900;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout must be greater than 0');
  }

  const { api } = await createApiClient(overrides);
  const result = await api.runAgain(benchmarkSlug, runId);
  const jsonOutput = outputOptions.json || outputOptions.format === 'json';

  if (!options.wait) {
    printData(result, outputOptions);
    if (!jsonOutput) {
      console.log(
        `Check progress: bench runs run-again-status ${benchmarkSlug} ${result.runAgainId}`,
      );
    }
    return;
  }

  if (!jsonOutput) {
    console.error(
      `Run again ${result.runAgainId} requested; waiting for the benchmark run to report…`,
    );
  }
  const reportedRunId = await waitForRunAgain(api, benchmarkSlug, result.runAgainId, {
    timeoutMs: timeoutSeconds * 1_000,
  });
  printData({ ...result, runId: reportedRunId }, outputOptions);
  if (!jsonOutput) {
    console.log(`Show it: bench runs show ${benchmarkSlug} ${reportedRunId}`);
  }
}

async function handleRunsRunAgainStatus(
  benchmarkSlug: string,
  runAgainId: string,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const result = await api.getRunAgain(benchmarkSlug, runAgainId);
  printData(result, outputOptions);
}

async function handleResults(
  benchmarkSlug: string,
  options: { run?: string; format?: string; limit?: number; offset?: number } & ResultFilterOptions,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const { filter, flagsSent } = resolveResultFilter(options, { allowSteps: true });
  if (options.run) {
    // A single run has no date range or step-overview dimension to narrow —
    // only `participant` applies (date/step flags still hard-error rather
    // than silently doing nothing).
    const unsupported: string[] = [];
    if (options.since !== undefined || options.until !== undefined || options.day !== undefined) {
      unsupported.push('--since/--until/--day');
    }
    if (options.steps !== undefined) unsupported.push('--steps');
    if (options['source-org'] !== undefined) unsupported.push('--source-org');
    if (unsupported.length > 0) {
      throw new Error(`${unsupported.join(' and ')} do not apply to a single --run`);
    }
  }
  const results = options.run
    ? await api.getRunResults(benchmarkSlug, options.run as string, {
        participants: filter.participants,
      })
    : await api.getBenchmarkResults(benchmarkSlug, {
        limit: options.limit,
        offset: options.offset,
        ...(filter.sourceOrg ? { sourceOrg: filter.sourceOrg } : {}),
        ...(flagsSent ? filter : {}),
      });
  if (options.run && filter.participants) {
    assertFilterEcho((results as BenchmarkRunResults).filter);
  }
  if (!options.run && flagsSent) {
    assertFilterEcho((results as BenchmarkResultsOverview).filter);
  }
  if (options.format === 'json' || outputOptions.json || outputOptions.format === 'json') {
    printData(results, { format: 'json' });
    return;
  }
  printResultsTables(results, options.run !== undefined, filter.timeZone);
}

// Day label for a run row. The filter's zone matters: a run created at
// 02:00Z is still yesterday in America/New_York, and the label should match
// the day the user filtered on. Falls back to a short id when createdAt is
// absent, and to the UTC date when the zone is unrecognised.
export function runDay(
  run: { id: string; createdAt?: string },
  timeZone?: string,
): string {
  const created = run.createdAt ? Date.parse(run.createdAt) : NaN;
  if (Number.isNaN(created)) return run.id.slice(0, 8);
  try {
    // en-CA renders YYYY-MM-DD.
    return new Date(created).toLocaleDateString('en-CA', { timeZone });
  } catch {
    // Unrecognised zone — label by the true UTC date, not the timestamp's
    // own offset date.
    return new Date(created).toISOString().slice(0, 10);
  }
}

type ParticipantResultRow = BenchmarkRunResults['participants'][number] & { runDay?: string };

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
    ...(p.runDay ? { run: p.runDay } : {}),
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
  timeZone?: string,
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
    item.participants.map((p) => participantTableRow({ ...p, runDay: runDay(item.run, timeZone) })),
  );
  const emptyRuns = overview.items.filter((item) => item.participants.length === 0);
  if (emptyRuns.length > 0) {
    for (const item of emptyRuns) {
      console.log(
        `Run ${runDay(item.run, timeZone)} — ${item.run.status} | no participant results (analytics: ${item.analytics.status})`,
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
    (item.steps ?? []).map((s) => ({ run: runDay(item.run, timeZone), ...stepTableRow(s) })),
  );
  if (stepRows.length > 0) {
    console.log('Steps:');
    console.table(stepRows);
  }
}

async function handleReliability(
  benchmarkSlug: string,
  options: {
    day?: string;
    participant?: string;
    from?: string;
    to?: string;
    bucket?: string;
    tz?: string;
    metrics?: string;
    breakdown?: string;
    'source-org'?: string;
    format?: string;
  },
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  // Validate flag combinations before auth/API setup — the two views take
  // disjoint flags.
  if (options.day !== undefined) {
    if (!options.participant?.trim()) {
      throw new Error(
        '--participant is required with --day: bench reliability <slug> --day YYYY-MM-DD --participant <slug>',
      );
    }
    const unsupported = (['from', 'to', 'bucket', 'metrics', 'breakdown'] as const).filter(
      (k) => options[k] !== undefined,
    );
    if (unsupported.length > 0) {
      throw new Error(`--${unsupported.join(' --')} do not apply to the --day view`);
    }
  } else {
    if (options.participant !== undefined) {
      throw new Error('--participant only applies to the --day view (the range view reports every participant)');
    }
    if (options.bucket !== undefined && options.bucket !== 'day' && options.bucket !== 'hour') {
      throw new Error("--bucket must be 'day' or 'hour'");
    }
  }
  if (options['source-org'] !== undefined && !options['source-org'].trim()) {
    // A blank --source-org must not silently fall back to the active org —
    // a shared slug would return another benchmark's data without warning.
    throw new Error('--source-org must name an organization slug');
  }

  const csv = (raw: string | undefined, name: string): string[] | undefined => {
    if (raw === undefined) return undefined;
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) throw new Error(`--${name} must name at least one key`);
    return items;
  };

  const { api } = await createApiClient(overrides);
  const result = await api.getBenchmarkReliability(benchmarkSlug, {
    sourceOrg: options['source-org']?.trim(),
    day: options.day,
    participant: options.participant?.trim(),
    from: options.from,
    to: options.to,
    timeZone: options.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    bucket: options.bucket as 'day' | 'hour' | undefined,
    metrics: csv(options.metrics, 'metrics'),
    breakdowns: csv(options.breakdown, 'breakdown'),
  });
  if (options.format === 'json' || outputOptions.json || outputOptions.format === 'json') {
    printData(result, { format: 'json' });
    return;
  }
  printReliability(result);
}

function printReliability(result: BenchmarkReliabilityRange | BenchmarkReliabilityDay): void {
  const { benchmark, config, timeZone } = result;
  const interval =
    config.intervalMs >= 60_000 && config.intervalMs % 60_000 === 0
      ? `${config.intervalMs / 60_000}m`
      : `${config.intervalMs}ms`;

  if ('slots' in result) {
    const t = result.totals;
    console.log(
      `${benchmark.slug} — reliability ${result.day} (${timeZone}) — participant ${result.participant} | every ${interval}`,
    );
    console.table([
      {
        uptime: t.uptime === null ? 'n/a' : fmtRate(t.uptime),
        passed: t.passed,
        degraded: t.degraded,
        failed: t.failed,
        missed: t.missed,
        pending: t.pending,
        p50Ms: t.p50Ms ?? 'n/a',
        p95Ms: t.p95Ms ?? 'n/a',
      },
    ]);
    // Compact slot strip — one mark per slot, in order.
    const marks: Record<string, string> = {
      passed: '.', degraded: '~', failed: 'x', missed: '!', pending: ' ', 'no-data': '?',
    };
    console.log(result.slots.map((s) => marks[s.outcome] ?? '?').join(''));
    const attention = result.slots.filter((s) => s.outcome === 'failed' || s.outcome === 'degraded');
    for (const s of attention.slice(0, 10)) {
      console.log(`  ${s.at} ${s.outcome}${s.error ? ` — ${s.error}` : ''}`);
    }
    if (attention.length > 10) console.log(`  … and ${attention.length - 10} more`);
    return;
  }

  console.log(
    `${benchmark.slug} — reliability ${result.from} → ${result.to} (${timeZone}, ${result.bucket} buckets) | every ${interval}`,
  );
  if (result.participants.length === 0) {
    console.log('No participants in range.');
  } else {
    console.table(
      result.participants.map((p) => ({
        participant: p.slug,
        provider: p.provider ?? '',
        uptime: p.total.uptime === null ? 'n/a' : fmtRate(p.total.uptime),
        passed: p.total.passed,
        degraded: p.total.degraded,
        failed: p.total.failed,
        p50Ms: p.total.p50Ms ?? 'n/a',
        p95Ms: p.total.p95Ms ?? 'n/a',
        status: p.status?.state ?? '',
        statusSince: p.status?.since ?? '',
      })),
    );
  }
  const s = result.scheduler.total;
  console.log(
    `scheduler: ${s.fired}/${s.expected} fired, ${s.missed} missed, ${s.pending} pending, ${s.duplicates} duplicates`,
  );
  if (result.incidents.length > 0) {
    console.log('Incidents:');
    console.table(
      result.incidents.map((i) => ({
        participant: i.participant ?? '(scheduler)',
        kind: i.kind,
        start: i.start,
        end: i.end,
        ongoing: i.ongoing,
        failed: i.failed,
        degraded: i.degraded,
        missed: i.missed,
        error: i.error ?? '',
      })),
    );
  }
  if (result.errors.length > 0) {
    console.log('Top errors:');
    console.table(result.errors);
  }
  if (result.metrics && Object.keys(result.metrics).length > 0) {
    console.log('Metrics:');
    console.table(
      Object.entries(result.metrics).flatMap(([key, rows]) =>
        rows.map((r) => ({
          metric: key,
          participant: r.slug,
          p50: r.total.p50 ?? 'n/a',
          p95: r.total.p95 ?? 'n/a',
          p99: r.total.p99 ?? 'n/a',
        })),
      ),
    );
  }
  if (result.breakdowns && result.breakdowns.length > 0) {
    for (const b of result.breakdowns) {
      console.log(`Breakdown ${b.key}:`);
      console.table(
        b.values.map((v) => ({
          value: v.value,
          passed: v.passed,
          degraded: v.degraded,
          failed: v.failed,
        })),
      );
    }
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
  options: SubcommandOptions,
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
        parseSubcommandOptions(subRest, groupFlags('auth'));
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
        const { positionals: subPositionals } = parseSubcommandOptions(subRest, groupFlags('org'));
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
        const { options, positionals: subPositionals } = parseSubcommandOptions(subRest, groupFlags('benchmarks'));
        if (!findCommand(['benchmarks', sub])) throw new Error(USAGE);
        assertCommandFlags(['benchmarks', sub], options);
        const [slug] = subPositionals;
        switch (sub) {
          case 'list':
            await handleBenchmarksList(options, overrides, outputOptions);
            break;
          case 'archive':
          case 'restore':
            await handleBenchmarkArchive(slug, sub === 'archive', options, overrides, outputOptions);
            break;
          case 'describe':
            await handleBenchmarkDescribe(slug, options, overrides, outputOptions);
            break;
          case 'mute':
          case 'unmute':
            await handleBenchmarkMute(slug, sub === 'mute', overrides, outputOptions);
            break;
          case 'pause':
          case 'resume':
            await handleBenchmarkPause(slug, sub === 'pause', options, overrides, outputOptions);
            break;
        }
        break;
      }
      case 'runs': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, groupFlags('runs'));
        const [sub, slug, runId] = subPositionals;
        if (!findCommand(['runs', sub])) throw new Error(USAGE);
        // Options are parsed with the union of every `runs` subcommand's
        // flags; one another subcommand takes must not be silently ignored
        // (e.g. --source-org on `runs show` with a shared slug).
        assertCommandFlags(['runs', sub], options);
        if (sub === 'list') {
          await handleRunsList(
            slug,
            options as Parameters<typeof handleRunsList>[1],
            overrides,
            outputOptions,
          );
        } else if (sub === 'show') {
          if (!slug || !runId) throw new Error('Usage: bench runs show <benchmark-slug> <runId>');
          await handleRunsShow(slug, runId, overrides, outputOptions);
        } else if (sub === 'run-again') {
          if (!slug || !runId) {
            throw new Error(
              'Usage: bench runs run-again <benchmark-slug> <runId> [--wait] [--timeout <seconds>]',
            );
          }
          await handleRunsRunAgain(
            slug,
            runId,
            options as { wait?: boolean; timeout?: number },
            overrides,
            outputOptions,
          );
        } else if (sub === 'run-again-status') {
          if (!slug || !runId) {
            throw new Error(
              'Usage: bench runs run-again-status <benchmark-slug> <runAgainId>',
            );
          }
          await handleRunsRunAgainStatus(slug, runId, overrides, outputOptions);
        } else if (sub === 'feed') {
          await handleRunsFeed(options, overrides, outputOptions);
        } else if (sub === 'days') {
          await handleRunDays(options, overrides, outputOptions);
        } else if (sub === 'day') {
          await handleRunsDay(slug, options, overrides, outputOptions);
        } else {
          await handleRunsArchive(subPositionals.slice(1), sub === 'archive', options, overrides, outputOptions);
        }
        break;
      }
      case 'results': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, flagsOf('results'));
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench results <benchmark-slug>');
        await handleResults(
          slug,
          options as Parameters<typeof handleResults>[1],
          overrides,
          outputOptions,
        );
        break;
      }
      case 'reliability': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, groupFlags('reliability'));
        // `cards` is the org-wide view; any other word is a benchmark slug.
        if (subPositionals.length === 1 && subPositionals[0] === 'cards') {
          assertCommandFlags(['reliability', 'cards'], options);
          await handleReliabilityCards(options, overrides, outputOptions);
          break;
        }
        assertCommandFlags(['reliability'], options);
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench reliability <benchmark-slug>');
        await handleReliability(
          slug,
          options as Parameters<typeof handleReliability>[1],
          overrides,
          outputOptions,
        );
        break;
      }
      case 'activity': {
        const { options } = parseSubcommandOptions(rest, flagsOf('activity'));
        await handleActivity(options, overrides, outputOptions);
        break;
      }
      case 'run-again': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, groupFlags('run-again'));
        if (subPositionals[0] === 'status') {
          assertCommandFlags(['run-again', 'status'], options);
          await handleRunAgainStatus(subPositionals[1], options, overrides, outputOptions);
        } else {
          assertCommandFlags(['run-again'], options);
          await handleRunAgain(subPositionals[0], options, overrides, outputOptions);
        }
        break;
      }
      case 'iterations': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, flagsOf('iterations'));
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench iterations <benchmark-slug>');
        await handleIterations(
          slug,
          options as Parameters<typeof handleIterations>[1],
          overrides,
          outputOptions,
        );
        break;
      }
      case 'artifacts': {
        const [sub, ...subRest] = rest;
        const { options, positionals: subPositionals } = parseSubcommandOptions(subRest, groupFlags('artifacts'));
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
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, flagsOf('logs'));
        const [slug, runId] = subPositionals;
        if (!slug || !runId) throw new Error('Usage: bench logs <benchmark-slug> <runId>');
        await handleLogs(
          slug,
          runId,
          options as Parameters<typeof handleLogs>[2],
          overrides,
          outputOptions,
        );
        break;
      }
      case 'export': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, flagsOf('export'));
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench export <benchmark-slug>');
        await handleExport(
          slug,
          options as Parameters<typeof handleExport>[1],
          overrides,
        );
        break;
      }
      case 'fork': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest, flagsOf('fork'));
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: bench fork <benchmark-slug>');
        await handleFork(
          slug,
          options as Parameters<typeof handleFork>[1],
          overrides,
          outputOptions,
        );
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
