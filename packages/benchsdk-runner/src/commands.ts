/**
 * The verbs `@benchsdk/runner` handles itself before handing everything else
 * to `@benchsdk/cli`. Mirrors `USAGE` in `cli.ts` and the flags `bench run`
 * reads (`shiftPlatformFlags`, `--check`, `parseCliArgs`); `bench __manifest`
 * publishes it next to the `@benchsdk/cli` `COMMANDS` table.
 */
export interface RunnerCommand {
  readonly path: readonly string[];
  readonly args: readonly string[];
  /** Flags including the leading `--`. A bench file may accept more via `customCliFlags`. */
  readonly flags: readonly string[];
  /** First `@benchsdk/runner` version that shipped the command. */
  readonly since: string;
  readonly flagsSince?: Readonly<Record<string, string>>;
  readonly summary: string;
}

export const RUNNER_COMMANDS: readonly RunnerCommand[] = [
  {
    path: ['run'],
    args: ['<file.bench.ts>'],
    flags: [
      '--shape',
      '--provider',
      '--run-key',
      '--benchmark',
      '--slug',
      '--name',
      '--iterations',
      '--concurrency',
      '--stagger-delay-ms',
      '--group-by',
      '--deadline-ms',
      '--scheduled-for',
      '--no-ingest',
      '--dry-run',
      '--check',
      '--validate',
      '--base-url',
      '--api-key',
    ],
    since: '0.2.0',
    flagsSince: {
      '--no-ingest': '0.3.0',
      '--dry-run': '0.3.0',
      '--check': '0.5.0',
      '--validate': '0.5.0',
      '--deadline-ms': '0.6.3',
      '--scheduled-for': '0.8.0',
    },
    summary: 'Execute a benchmark file',
  },
  {
    path: ['check'],
    args: ['<file.bench.ts>'],
    flags: ['--base-url', '--api-key', '--shape', '--provider', '--no-ingest', '--dry-run'],
    since: '0.5.0',
    summary: 'Validate config, auth, participants and scoring for a benchmark file without running it',
  },
];
