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
    flags: ['limit', 'offset'],
    since: '0.2.0',
    summary: 'List benchmarks',
  },
  {
    path: ['runs', 'list'],
    args: ['[benchmark-slug]'],
    flags: ['limit', 'offset', 'participant', 'since', 'until', 'day', 'tz', 'source-org'],
    since: '0.2.0',
    flagsSince: {
      participant: RESULT_FILTERS_SINCE,
      since: RESULT_FILTERS_SINCE,
      until: RESULT_FILTERS_SINCE,
      day: RESULT_FILTERS_SINCE,
      tz: RESULT_FILTERS_SINCE,
      'source-org': RESULT_FILTERS_SINCE,
    },
    summary: 'List benchmark runs (omit the slug to list runs across every benchmark you can read)',
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
