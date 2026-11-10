/**
 * The platform commands `bench` accepts. `run()` reads each command's flag
 * allowlist from this table and `bench __manifest` (in `@benchsdk/runner`)
 * publishes it, so the CLI and its manifest cannot drift apart.
 */
export interface BenchCommand {
  /** Command words, e.g. `['runs', 'list']`. */
  readonly path: readonly string[];
  /** Positional arguments: `<required>` or `[optional]`. */
  readonly args: readonly string[];
  /** Subcommand options without the leading `--`. Global options are not listed. */
  readonly flags: readonly string[];
  /** First `@benchsdk/cli` version that shipped the command. */
  readonly since: string;
  /** Flags that shipped after the command itself, by the version that added them. */
  readonly flagsSince?: Readonly<Record<string, string>>;
  readonly summary: string;
}

/** Options every command accepts, parsed before the subcommand options. */
export const GLOBAL_STRING_FLAGS = ['base-url', 'api-key', 'org', 'format'] as const;
export const GLOBAL_BOOLEAN_FLAGS = ['json', 'verbose', 'version', 'help'] as const;

const RESULT_FILTERS_SINCE = '0.8.0';
// Management commands: the first @benchsdk/cli release after 0.9.3.
const MANAGEMENT_SINCE = '0.9.4';
// Org feed and daily Run again commands ship in the same release.
const FEED_SINCE = '0.9.4';

export const COMMANDS: readonly BenchCommand[] = [
  { path: ['auth', 'login'], args: [], flags: [], since: '0.2.0', summary: 'Authenticate with OAuth device flow' },
  { path: ['auth', 'logout'], args: [], flags: [], since: '0.2.0', summary: 'Remove saved credentials' },
  {
    path: ['auth', 'status'],
    args: [],
    flags: [],
    since: '0.2.0',
    summary: 'Show current user and active organization',
  },
  { path: ['org', 'list'], args: [], flags: [], since: '0.2.0', summary: 'List organizations' },
  { path: ['org', 'use'], args: ['<slug>'], flags: [], since: '0.2.0', summary: 'Set active organization' },
  {
    path: ['benchmarks', 'list'],
    args: [],
    flags: ['limit', 'offset', 'status'],
    since: '0.2.0',
    flagsSince: { status: MANAGEMENT_SINCE },
    summary: 'List benchmarks (--status active|archived|all; default active)',
  },
  {
    path: ['benchmarks', 'archive'],
    args: ['<benchmark-slug>'],
    flags: ['yes'],
    since: MANAGEMENT_SINCE,
    summary: 'Archive a benchmark and all of its runs (asks first; -y to skip)',
  },
  {
    path: ['benchmarks', 'restore'],
    args: ['<benchmark-slug>'],
    flags: [],
    since: MANAGEMENT_SINCE,
    summary: 'Restore an archived benchmark and its runs',
  },
  {
    path: ['benchmarks', 'describe'],
    args: ['<benchmark-slug>'],
    flags: ['tagline', 'description', 'description-file', 'clear-tagline', 'clear-description'],
    since: MANAGEMENT_SINCE,
    summary: "Set or clear a benchmark's tagline and description",
  },
  {
    path: ['benchmarks', 'mute'],
    args: ['<benchmark-slug>'],
    flags: [],
    since: MANAGEMENT_SINCE,
    summary: "Mute a benchmark for the organization (hides it from the org's run feed)",
  },
  {
    path: ['benchmarks', 'unmute'],
    args: ['<benchmark-slug>'],
    flags: [],
    since: MANAGEMENT_SINCE,
    summary: 'Unmute a benchmark for the organization',
  },
  {
    path: ['benchmarks', 'pause'],
    args: ['<benchmark-slug>'],
    flags: ['start', 'end'],
    since: MANAGEMENT_SINCE,
    summary: 'Pause a reliability benchmark (from --start, default now, until --end or resume)',
  },
  {
    path: ['benchmarks', 'resume'],
    args: ['<benchmark-slug>'],
    flags: [],
    since: MANAGEMENT_SINCE,
    summary: 'Resume a paused reliability benchmark',
  },
  {
    path: ['runs', 'list'],
    args: ['[benchmark-slug]'],
    flags: [
      'limit',
      'offset',
      'participant',
      'since',
      'until',
      'day',
      'tz',
      'source-org',
      'archived',
      'include-muted',
      'benchmark',
    ],
    since: '0.2.0',
    flagsSince: {
      participant: RESULT_FILTERS_SINCE,
      since: RESULT_FILTERS_SINCE,
      until: RESULT_FILTERS_SINCE,
      day: RESULT_FILTERS_SINCE,
      tz: RESULT_FILTERS_SINCE,
      'source-org': RESULT_FILTERS_SINCE,
      archived: MANAGEMENT_SINCE,
      'include-muted': MANAGEMENT_SINCE,
      benchmark: FEED_SINCE,
    },
    summary: 'List benchmark runs (omit the slug to list runs across every benchmark you can read)',
  },
  {
    path: ['runs', 'feed'],
    args: [],
    flags: ['benchmark', 'include-archived', 'include-muted', 'limit'],
    since: FEED_SINCE,
    summary: "The organization's newest runs across benchmarks, with stats (the dashboard feed)",
  },
  {
    path: ['runs', 'days'],
    args: [],
    flags: ['benchmark', 'include-archived', 'include-muted', 'tz'],
    since: FEED_SINCE,
    summary: 'Run counts per local day across benchmarks',
  },
  {
    path: ['runs', 'day'],
    args: ['<day>'],
    flags: ['benchmark', 'include-archived', 'include-muted', 'tz', 'all', 'cursor'],
    since: FEED_SINCE,
    summary: 'Runs of one local day across benchmarks (--all follows every page)',
  },
  {
    path: ['runs', 'show'],
    args: ['<benchmark-slug>', '<runId>'],
    flags: [],
    since: '0.2.0',
    summary: 'Show a single run',
  },
  {
    path: ['runs', 'run-again'],
    args: ['<benchmark-slug>', '<runId>'],
    flags: ['wait', 'timeout'],
    since: '0.9.3',
    summary: 'Run the benchmark of a run again on the latest code (--wait polls until it reports a run)',
  },
  {
    path: ['runs', 'run-again-status'],
    args: ['<benchmark-slug>', '<runAgainId>'],
    flags: [],
    since: '0.9.3',
    summary: 'Show run-again progress: the run it reported, or null while pending',
  },
  {
    path: ['runs', 'archive'],
    args: ['<runId...>'],
    flags: ['yes'],
    since: MANAGEMENT_SINCE,
    summary: 'Archive up to 100 runs (asks first; -y to skip)',
  },
  {
    path: ['runs', 'unarchive'],
    args: ['<runId...>'],
    flags: ['yes'],
    since: MANAGEMENT_SINCE,
    summary: 'Unarchive up to 100 runs (asks first; -y to skip)',
  },
  {
    path: ['results'],
    args: ['<benchmark-slug>'],
    flags: ['run', 'participant', 'steps', 'since', 'until', 'day', 'tz', 'source-org', 'limit', 'offset'],
    since: '0.2.0',
    flagsSince: {
      participant: RESULT_FILTERS_SINCE,
      steps: RESULT_FILTERS_SINCE,
      since: RESULT_FILTERS_SINCE,
      until: RESULT_FILTERS_SINCE,
      day: RESULT_FILTERS_SINCE,
      tz: RESULT_FILTERS_SINCE,
      'source-org': RESULT_FILTERS_SINCE,
      limit: RESULT_FILTERS_SINCE,
      offset: RESULT_FILTERS_SINCE,
    },
    summary: 'Show benchmark or run results',
  },
  {
    path: ['reliability'],
    args: ['<benchmark-slug>'],
    flags: ['day', 'participant', 'from', 'to', 'bucket', 'tz', 'metrics', 'breakdown', 'source-org'],
    // Merged after 0.9.1 was published; 0.9.1 on npm has no `reliability`.
    since: '0.9.2',
    summary:
      'Reliability uptime view for a type=reliability benchmark, or one participant on one day with --day --participant',
  },
  {
    path: ['reliability', 'cards'],
    args: [],
    flags: ['include-muted'],
    since: FEED_SINCE,
    summary: "The organization's reliability cards: uptime, last status and pause state per reliability benchmark",
  },
  {
    path: ['activity'],
    args: [],
    flags: ['days', 'benchmark'],
    since: FEED_SINCE,
    summary: 'Run counts per day for the organization or one benchmark (--days 1..90)',
  },
  {
    path: ['run-again'],
    args: ['<benchmark-slug>'],
    flags: ['wait', 'timeout', 'interval'],
    since: FEED_SINCE,
    summary: 'Run a daily benchmark again, once per organization and UTC day (needs a user login; --wait polls until the run starts)',
  },
  {
    path: ['run-again', 'status'],
    args: ['<benchmark-slug>'],
    flags: ['request'],
    since: FEED_SINCE,
    summary: "Today's Run again availability and quota, or one request with --request <runAgainId>",
  },
  {
    path: ['iterations'],
    args: ['<benchmark-slug>'],
    flags: ['run', 'participant', 'steps'],
    since: '0.3.0',
    summary: 'Show per-iteration step latencies',
  },
  {
    path: ['artifacts', 'list'],
    args: ['<benchmark-slug>', '<runId>'],
    flags: ['worker'],
    since: '0.2.0',
    summary: 'List run artifacts',
  },
  {
    path: ['logs'],
    args: ['<benchmark-slug>', '<runId>'],
    flags: ['participant', 'worker', 'max-lines'],
    since: '0.6.0',
    summary: 'Show participant worker logs (parsed, like the dashboard log view)',
  },
  {
    path: ['export'],
    args: ['<benchmark-slug>'],
    flags: ['run', 'out'],
    since: '0.2.0',
    summary: 'Export benchmark or run results to JSON',
  },
  {
    path: ['fork'],
    args: ['<benchmark-slug>'],
    flags: ['as', 'source-org', 'ref'],
    since: '0.9.0',
    summary: 'Fork a catalog benchmark into your org as a private benchmark that tracks the upstream bench file',
  },
];

export function findCommand(path: readonly (string | undefined)[]): BenchCommand | undefined {
  return COMMANDS.find(
    (command) => command.path.length === path.length && command.path.every((word, i) => word === path[i]),
  );
}

/**
 * Flags accepted by any command under `group` (`runs` → `runs list` ∪ `runs show`),
 * for parsing options before the subcommand is known.
 */
export function groupFlags(group: string): readonly string[] {
  const flags = new Set<string>();
  for (const command of COMMANDS) {
    if (command.path[0] === group) command.flags.forEach((flag) => flags.add(flag));
  }
  return [...flags];
}
