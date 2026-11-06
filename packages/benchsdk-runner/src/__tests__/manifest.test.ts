import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '@benchsdk/cli';
import { parseCliArgs } from '../runner.js';
import { RUNNER_COMMANDS } from '../commands.js';

// `pretest` builds dist/, so this exercises the real `bench` binary.
const packageRoot = join(__dirname, '..', '..');
const bin = join(packageRoot, 'dist', 'bin.cjs');
const committedPath = join(packageRoot, 'cli-manifest.json');

function benchManifest(...args: string[]): string {
  return execFileSync(process.execPath, [bin, '__manifest', ...args], { encoding: 'utf8' });
}

interface ManifestCommand {
  path: string[];
  args: string[];
  flags: string[];
  summary: string;
  since: string;
  package: string;
  flagsSince?: Record<string, string>;
}

describe('bench __manifest', () => {
  it('prints exactly the committed cli-manifest.json (regenerate with `pnpm --filter @benchsdk/runner run manifest`)', () => {
    expect(benchManifest()).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('describes the bench binary and the packages it is built from', () => {
    const manifest = JSON.parse(benchManifest());
    const runnerPkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const cliPkg = JSON.parse(readFileSync(join(packageRoot, '..', 'benchsdk-cli', 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      bin: 'bench',
      package: '@benchsdk/runner',
      version: runnerPkg.version,
      source: { repo: 'computesdk/benchmarks', released: false },
      cli: { package: '@benchsdk/cli', version: cliPkg.version },
    });
    expect(manifest.globalFlags).toEqual(
      expect.arrayContaining(['--base-url', '--api-key', '--org', '--format', '--json', '--help']),
    );
  });

  it('lists the runner verbs, then every @benchsdk/cli command with --flags and since', () => {
    const { commands } = JSON.parse(benchManifest()) as { commands: ManifestCommand[] };
    expect(commands.map((c) => c.path.join(' '))).toEqual([
      ...RUNNER_COMMANDS.map((c) => c.path.join(' ')),
      ...COMMANDS.map((c) => c.path.join(' ')),
    ]);
    expect(commands.find((c) => c.path.join(' ') === 'run')?.package).toBe('@benchsdk/runner');
    expect(commands.find((c) => c.path.join(' ') === 'fork')?.package).toBe('@benchsdk/cli');
    for (const command of commands) {
      expect(command.since, command.path.join(' ')).toMatch(/^\d+\.\d+\.\d+$/);
      for (const flag of command.flags) expect(flag).toMatch(/^--[a-z][a-z-]*$/);
      for (const flag of Object.keys(command.flagsSince ?? {})) expect(command.flags).toContain(flag);
    }
    const reliability = commands.find((c) => c.path.join(' ') === 'reliability');
    expect(reliability?.flags).toEqual(expect.arrayContaining(['--day', '--from', '--bucket', '--source-org']));
  });

  it('stamps source.released with --released', () => {
    expect(JSON.parse(benchManifest('--released')).source.released).toBe(true);
  });

  it('exits non-zero on an unknown argument', () => {
    const result = spawnSync(process.execPath, [bin, '__manifest', '--bogus'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: bench __manifest [--released]');
  });
});

describe('RUNNER_COMMANDS', () => {
  // Flags `bench run` consumes itself before handing the rest to parseCliArgs.
  const handledBeforeParse = new Set(['--base-url', '--api-key', '--check', '--validate']);
  const samples: Record<string, string[]> = {
    '--benchmark': ['demo-bench'],
    '--slug': ['demo-bench'],
    '--name': ['Demo'],
    '--shape': ['burst'],
    '--run-key': ['key-1'],
    '--provider': ['e2b'],
    '--iterations': ['2'],
    '--concurrency': ['2'],
    '--stagger-delay-ms': ['0'],
    '--deadline-ms': ['1000'],
    '--group-by': ['round'],
    '--scheduled-for': ['2026-11-01T00:00:00Z'],
    '--no-ingest': [],
    '--dry-run': [],
  };

  it.each(RUNNER_COMMANDS.flatMap((c) => c.flags.map((flag) => [c.path.join(' '), flag])))(
    'bench %s accepts %s',
    (_command, flag) => {
      if (handledBeforeParse.has(flag)) return;
      expect(samples[flag], `add a sample value for ${flag}`).toBeDefined();
      expect(() => parseCliArgs([flag, ...samples[flag]])).not.toThrow();
    },
  );
});
