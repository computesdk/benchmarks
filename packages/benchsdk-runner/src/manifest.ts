import { COMMANDS, GLOBAL_BOOLEAN_FLAGS, GLOBAL_STRING_FLAGS, getCliVersion } from '@benchsdk/cli';
import { RUNNER_COMMANDS } from './commands.js';

declare const __BENCH_VERSION__: string;

export interface CliManifestCommand {
  path: string[];
  args: string[];
  flags: string[];
  summary: string;
  /** Version of `package` that first shipped the command. */
  since: string;
  /** Flags that shipped after the command, by the `package` version that added them. */
  flagsSince?: Record<string, string>;
  package: '@benchsdk/runner' | '@benchsdk/cli';
}

/** The command tree of the `bench` binary, in the schema shared with `compute __manifest`. */
export interface CliManifest {
  schemaVersion: 1;
  bin: 'bench';
  package: '@benchsdk/runner';
  version: string;
  source: { repo: 'computesdk/benchmarks'; released: boolean };
  cli: { package: '@benchsdk/cli'; version: string };
  /**
   * Flags every `@benchsdk/cli` (platform) command accepts besides its own.
   * The runner verbs (`run`, `check`; `package: '@benchsdk/runner'`) parse
   * their argv before the platform CLI does and accept only the flags they
   * list, so these don't apply to them.
   */
  globalFlags: string[];
  commands: CliManifestCommand[];
}

export const MANIFEST_USAGE = 'Usage: bench __manifest [--released]';

export async function buildCliManifest(options: { released?: boolean } = {}): Promise<CliManifest> {
  const runnerCommands = RUNNER_COMMANDS.map((command) => ({
    path: [...command.path],
    args: [...command.args],
    flags: [...command.flags],
    summary: command.summary,
    since: command.since,
    ...(command.flagsSince ? { flagsSince: { ...command.flagsSince } } : {}),
    package: '@benchsdk/runner' as const,
  }));
  const cliCommands = COMMANDS.map((command) => ({
    path: [...command.path],
    args: [...command.args],
    flags: command.flags.map((flag) => `--${flag}`),
    summary: command.summary,
    since: command.since,
    ...(command.flagsSince
      ? {
          flagsSince: Object.fromEntries(
            Object.entries(command.flagsSince).map(([flag, since]) => [`--${flag}`, since]),
          ),
        }
      : {}),
    package: '@benchsdk/cli' as const,
  }));

  return {
    schemaVersion: 1,
    bin: 'bench',
    package: '@benchsdk/runner',
    version: __BENCH_VERSION__,
    // No git ref: the committed manifest must regenerate byte-for-byte, and
    // whoever vendors it knows which commit they copied it from.
    source: { repo: 'computesdk/benchmarks', released: options.released ?? false },
    cli: { package: '@benchsdk/cli', version: await getCliVersion() },
    globalFlags: [...GLOBAL_STRING_FLAGS, ...GLOBAL_BOOLEAN_FLAGS].map((flag) => `--${flag}`),
    commands: [...runnerCommands, ...cliCommands],
  };
}

/** `bench __manifest [--released]`: hidden; prints the manifest JSON. */
export async function printCliManifest(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--released');
  if (unknown.length > 0) throw new Error(MANIFEST_USAGE);
  const manifest = await buildCliManifest({ released: argv.includes('--released') });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  // The caller exits right after; wait for the write so a piped stdout
  // (asynchronous on some platforms) is not truncated.
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(json, (err) => (err ? reject(err) : resolve())),
  );
}
