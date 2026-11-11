import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: vi.fn(async () => null), loadCredentials: vi.fn(async () => null) };
});

// Any command that gets past flag parsing and validation stops here instead
// of touching the network or the credential store.
vi.mock('../client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client.js')>();
  return {
    ...actual,
    createApiClient: vi.fn(async () => {
      throw new Error('API_REACHED');
    }),
  };
});

import { run, flagTakesValue } from '../cli.js';
import { COMMANDS, type BenchCommand } from '../commands.js';

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface Invocation {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

interface CallLog {
  mock: { calls: unknown[][] };
}

let logSpy: CallLog;
let errorSpy: CallLog;
let exitCodes: (number | undefined)[];

beforeEach(() => {
  exitCodes = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code);
    throw new ExitCalled(code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function invoke(argv: string[]): Promise<Invocation> {
  try {
    await run(argv);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
  }
  const join = (spy: CallLog) => spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  // run() exits from inside its own try block on success, so a later exit
  // call can follow the first; the first one is the real exit code.
  return { exitCode: exitCodes[0], stdout: join(logSpy), stderr: join(errorSpy) };
}

const POSITIONAL_SAMPLES: Record<string, string> = {
  '<benchmark-slug>': 'demo-bench',
  '[benchmark-slug]': 'demo-bench',
  '<runId>': 'run-1',
  '<runAgainId>': 'run-again-1',
  '<runId...>': 'run-1',
  '<slug>': 'demo-org',
  '<day>': '2026-11-01',
  '<workerId>': 'worker-1',
  '<artifactId>': 'artifact-1',
};

/** A sample value per flag; `null` marks a switch that takes no value. */
const FLAG_SAMPLES: Record<string, string | null> = {
  limit: '5',
  offset: '0',
  'max-lines': '10',
  run: 'run-1',
  participant: 'e2b',
  steps: 'create',
  worker: 'worker-1',
  out: '/tmp/bench-export',
  since: '2026-11-01',
  until: '2026-11-02',
  day: '2026-11-01',
  tz: 'UTC',
  'source-org': 'computesdk',
  from: '2026-11-01',
  to: '2026-11-02',
  bucket: 'day',
  metrics: 'latency',
  breakdown: 'region',
  as: 'my-fork',
  ref: 'abc123',
  status: 'all',
  yes: null,
  tagline: 'A tagline',
  description: 'A description',
  'description-file': '/tmp/bench-cli-test-missing-description.md',
  'clear-tagline': null,
  'clear-description': null,
  start: '2026-11-01T00:00:00Z',
  end: '2026-11-02T00:00:00Z',
  archived: 'include',
  'include-muted': null,
  'include-archived': null,
  benchmark: 'demo-bench',
  all: null,
  cursor: '2026-11-01T00:00:00Z,run-1',
  days: '7',
  wait: null,
  timeout: '1',
  interval: '1',
  request: 'req-1',
  sort: 'name',
  order: 'asc',
  group: 'public',
  category: 'sandbox',
  owner: 'acme',
  q: 'cold',
  'rank-by': 'task',
  stat: 'median',
  dimension: 'us-east',
  timeline: null,
  'bucket-ms': '1000',
  tasks: null,
  'bucket-size': '10',
  'failure-limit': '5',
  type: 'tasks',
};

function flagArgs(flag: string): string[] {
  const sample = FLAG_SAMPLES[flag];
  return sample === null ? [`--${flag}`] : [`--${flag}`, sample];
}

function positionalsFor(command: BenchCommand): string[] {
  return command.args.map((arg) => {
    const sample = POSITIONAL_SAMPLES[arg];
    if (!sample) throw new Error(`No sample value for argument ${arg} of bench ${command.path.join(' ')}`);
    return sample;
  });
}

const label = (command: BenchCommand) => command.path.join(' ');

describe('COMMANDS table', () => {
  it('lists each command path once', () => {
    const paths = COMMANDS.map(label);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every command a semver since, a summary, and bare flag names', () => {
    for (const command of COMMANDS) {
      expect(command.since, label(command)).toMatch(/^\d+\.\d+\.\d+$/);
      expect(command.summary.length, label(command)).toBeGreaterThan(0);
      for (const flag of command.flags) expect(flag, label(command)).toMatch(/^[a-z][a-z-]*$/);
      for (const [flag, since] of Object.entries(command.flagsSince ?? {})) {
        expect(command.flags, `${label(command)} flagsSince`).toContain(flag);
        expect(since, `${label(command)} --${flag}`).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });

  it('has a sample for every flag, matching whether the flag takes a value', () => {
    for (const command of COMMANDS) {
      for (const flag of command.flags) {
        expect(FLAG_SAMPLES, `add a sample value for --${flag}`).toHaveProperty([flag]);
        expect(FLAG_SAMPLES[flag] !== null, `--${flag} takes a value`).toBe(flagTakesValue(flag));
      }
    }
  });
});

describe.each(COMMANDS.map((command) => [label(command), command] as const))('bench %s', (_name, command) => {
  it('prints its own help for --help', async () => {
    const result = await invoke([...command.path, '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith(`Usage: bench ${command.path[0]}`)).toBe(true);
    expect(result.stdout.startsWith('Usage: bench [options]')).toBe(false);
    for (const word of command.path) expect(result.stdout).toContain(word);
  });

  it('exits non-zero on a flag another command accepts', async () => {
    const foreign = Object.keys(FLAG_SAMPLES).find((flag) => !command.flags.includes(flag))!;
    const result = await invoke([...command.path, ...positionalsFor(command), ...flagArgs(foreign)]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Unknown option for this command: --${foreign}`);
    expect(result.stderr).not.toContain('API_REACHED');
  });

  it('exits non-zero on a flag no command accepts', async () => {
    const result = await invoke([...command.path, ...positionalsFor(command), '--no-such-flag', 'x']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option: --no-such-flag');
  });

  it.each(command.flags.map((flag) => [flag]))('accepts --%s', async (flag) => {
    expect(FLAG_SAMPLES, `add a sample value for --${flag}`).toHaveProperty([flag]);
    const result = await invoke([...command.path, ...positionalsFor(command), ...flagArgs(flag)]);
    // Reaching the API, or failing a flag-combination check, both mean the
    // flag itself was accepted.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('Unknown option');
  });
});
