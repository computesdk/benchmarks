import { describe, expect, it, vi } from 'vitest';
import { runBenchmarkFile } from '../cli';
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

  it('validates a benchmark with --check instead of executing tasks', async () => {
    await expect(
      runBenchmarkFile(['run', fixture('good.bench.ts'), '--check', '--dry-run']),
    ).rejects.toThrow(/Benchmark check failed/);
  });

  it('loads a project config file via --config and applies defaults', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    try {
      await runBenchmarkFile(['run', fixture('local.bench.ts'), '--config', fixture('bench.config.ts')]);
      const knobLine = logs.find((l) => l.includes('Knobs:'));
      expect(knobLine).toMatch(/iterations=2/);
      expect(knobLine).toMatch(/concurrency=2/);
    } finally {
      spy.mockRestore();
    }
  });
});
