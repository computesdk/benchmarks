import { describe, expect, it } from 'vitest';
import * as runner from '@benchsdk/runner';
import * as client from '../index';
import { createBenchmarkClient, runBenchmark, runBenchmarkWorker, runWorker, defineBenchmarkConfig, defineTask } from '../index';

/**
 * Compile-time assertion: every value exported by `@benchsdk/runner` is also
 * exported by `@benchsdk/client`.
 */
type AssertRunnerExportsAreClientExports = keyof typeof runner extends keyof typeof import('../index') ? true : never;
const _typeAssertion: AssertRunnerExportsAreClientExports = true;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
void _typeAssertion;

describe('@benchsdk/client parity', () => {
  it('re-exports the runner value surface', () => {
    const runnerKeys = Object.keys(runner).sort().filter((k) => k !== 'createBenchmarkClient');
    const clientMod = client as Record<string, unknown>;
    for (const key of runnerKeys) {
      expect(clientMod[key]).toBe((runner as Record<string, unknown>)[key]);
    }
  });

  it('keeps createBenchmarkClient().runWorker callable', () => {
    const c = createBenchmarkClient({ baseUrl: 'https://platform.test/api/v1', apiKey: 'key' });
    expect(typeof c.runWorker).toBe('function');
    // The client's runWorker is the same underlying implementation exposed as
    // the standalone runWorker export.
    expect(runWorker).toBeTypeOf('function');
  });

  it('re-exports runner DSL helpers unchanged', () => {
    expect(runBenchmark).toBe(runner.runBenchmark);
    expect(runBenchmarkWorker).toBe(runner.runBenchmarkWorker);
    expect(defineBenchmarkConfig).toBe(runner.defineBenchmarkConfig);
    expect(defineTask).toBe(runner.defineTask);
  });
});
