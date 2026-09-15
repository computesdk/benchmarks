import { describe, expect, it, vi } from 'vitest';
import { runBenchmarkFile, runCheck } from '../cli';
import { resolveProjectConfig } from '../project-config.js';
import { NoAvailableParticipantsError } from '../no-available-participants.js';
import { AuthError } from '@benchsdk/cli';

const fixture = (name: string) => `src/__tests__/fixtures/${name}`;

describe('runBenchmarkFile', () => {
  it('rejects retired imperative commands (there is no `create`)', async () => {
    await expect(runBenchmarkFile(['create', 'benchmark', 'sandbox'])).rejects.toThrow(/Usage:/);
    await expect(runBenchmarkFile(['create', 'run'])).rejects.toThrow(/Usage:/);
  });

  it('rejects when the command is not `run`', async () => {
    await expect(runBenchmarkFile([])).rejects.toThrow(/Usage:/);
    await expect(runBenchmarkFile(['nope', fixture('good.bench.ts')])).rejects.toThrow(/Usage:/);
  });

  it('rejects when no file is given, or a flag stands where the file should', async () => {
    await expect(runBenchmarkFile(['run'])).rejects.toThrow(/Usage:/);
    await expect(runBenchmarkFile(['run', '--shape', 'burst'])).rejects.toThrow(/Usage:/);
  });

  it('rejects a module that does not export a config', async () => {
    await expect(runBenchmarkFile(['run', fixture('no-config.bench.ts')])).rejects.toThrow(/must export a `config`/);
  });

  it('rejects a module that does not export a task', async () => {
    await expect(runBenchmarkFile(['run', fixture('no-task.bench.ts')])).rejects.toThrow(/must export a `task`/);
  });

  it('imports a valid module and drives the run, surfacing NoAvailableParticipantsError', async () => {
    process.env.BENCHMARKS_PLATFORM_API_KEY = 'test-key';
    try {
      // The fixture's participant requires an env var that is never set, so the
      // run env-gates to zero participants after auth is validated. Extra CLI
      // flags after the file are forwarded to the runner without error.
      await expect(
        runBenchmarkFile(['run', fixture('good.bench.ts'), '--iterations', '3']),
      ).rejects.toBeInstanceOf(NoAvailableParticipantsError);
    } finally {
      delete process.env.BENCHMARKS_PLATFORM_API_KEY;
    }
  });

  it('rejects before checking participants when no platform credentials are set', async () => {
    delete process.env.BENCHMARKS_PLATFORM_API_KEY;
    delete process.env.BENCHMARKS_PLATFORM_TOKEN;
    await expect(
      runBenchmarkFile(['run', fixture('good.bench.ts'), '--iterations', '3']),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('fails bench check --dry-run when no participants are available', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('good.bench.ts'), '--check', '--dry-run']),
    ).rejects.toThrow(/Benchmark check failed/);
  });

  it('passes bench check --dry-run without platform credentials when participants are available', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--check', '--dry-run']),
    ).resolves.toBeUndefined();
  });

  it('fails bench check when platform credentials are missing', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--check']),
    ).rejects.toThrow(/Benchmark check failed/);
  });

  it('rejects a missing task during --check', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('no-task.bench.ts'), '--check', '--dry-run']),
    ).rejects.toThrow(/must export a `task`/);
  });

  it('rejects --base-url without a value instead of consuming the next flag', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('good.bench.ts'), '--base-url', '--dry-run']),
    ).rejects.toThrow(/Usage:/);
  });

  it('rejects --base-url without a value during bench check', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--check', '--base-url', '--dry-run']),
    ).rejects.toThrow(/Usage:/);
  });

  it('rejects --api-key without a value during bench check', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--check', '--api-key', '--dry-run']),
    ).rejects.toThrow(/Usage:/);
  });

  it('catches a misconfigured onScore during --check', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('bad-onscore.bench.ts'), '--check', '--dry-run']),
    ).rejects.toThrow(/Benchmark check failed/);
  });

  it('rejects --base-url when its value is another flag', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--base-url', '--dry-run']),
    ).rejects.toThrow(/Usage:/);
  });

  it('loads bench.config.ts via --config and applies defaults', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    try {
      await runBenchmarkFile(['run', fixture('local.bench.ts'), '--config', fixture('config-project/bench.config.ts')]);
      const knobLine = logs.find((l) => l.includes('Knobs:'));
      expect(knobLine).toMatch(/iterations=2/);
      expect(knobLine).toMatch(/concurrency=2/);
    } finally {
      spy.mockRestore();
    }
  });

  it('lets CLI flags override bench.config.ts values', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    try {
      await runBenchmarkFile(['run', fixture('local.bench.ts'), '--config', fixture('config-project/bench.config.ts'), '--iterations', '1']);
      expect(logs.find((l) => l.includes('Knobs:'))).toMatch(/iterations=1/);
    } finally {
      spy.mockRestore();
    }
  });

  it('auto-loads bench.config.ts from cwd when present', async () => {
    const { config, configPath } = await resolveProjectConfig(fixture('config-project'));
    expect(configPath).toMatch(/fixtures\/config-project\/bench\.config\.ts$/);
    expect(config).toEqual({ iterations: 2, concurrency: 2, dryRun: true });

    const missing = await resolveProjectConfig(fixture(''));
    expect(missing).toEqual({ config: {} });
  });

  it('rejects a config file with invalid field types as a BenchmarkConfigError', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--config', fixture('invalid.config.ts'), '--dry-run']),
    ).rejects.toThrow(/iterations: must be a positive integer[\s\S]*dryRun: must be a boolean/);
  });

  it('rejects a config file that is not an object', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--config', fixture('array.config.ts'), '--dry-run']),
    ).rejects.toThrow(/config: must be an object/);
  });

  it('rejects --config when its value is another flag', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('local.bench.ts'), '--config', '--dry-run']),
    ).rejects.toThrow(/Usage:/);
  });

  it('rejects bench run --check with an unknown shape', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('shapes.bench.ts'), '--check', '--dry-run', '--shape', 'nope']),
    ).rejects.toThrow(/Unknown --shape "nope"/);
  });
});

describe('runCheck', () => {
  it('rejects an unknown shape', async () => {
    await expect(
      runCheck(['check', fixture('shapes.bench.ts'), '--dry-run', '--shape', 'nope']),
    ).rejects.toThrow(/Unknown --shape "nope"/);
  });
});
