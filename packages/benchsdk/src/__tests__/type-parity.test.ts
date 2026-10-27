import { describe, expect, it } from 'vitest';
import * as runner from '@benchsdk/runner';
import * as client from '../index';
import { createBenchmarkClient, runBenchmark, runBenchmarkWorker, runWorker, defineBenchmarkConfig, defineTask } from '../index';
import type {
  BenchmarkClient,
  BenchmarkConfig,
  BenchmarkIndexConfig,
  BenchmarkType,
  CreateRunArtifactInput,
  CreateRunArtifactResponse,
  UploadRunArtifactInput,
  UpsertBenchmarkInput,
} from '../index';

/**
 * Compile-time assertion: every value exported by `@benchsdk/runner` is also
 * exported by `@benchsdk/client`.
 */
type AssertRunnerExportsAreClientExports = keyof typeof runner extends keyof typeof import('../index') ? true : never;
const _typeAssertion: AssertRunnerExportsAreClientExports = true;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
void _typeAssertion;

/** Compile-time assertions: the benchmark type/index config surface and the
 * run-level artifact upload methods exist with the declared shapes. */
type AssertConfigDeclaresTypeAndIndex = BenchmarkConfig extends { type?: BenchmarkType; index?: BenchmarkIndexConfig } ? true : never;
const _configAssertion: AssertConfigDeclaresTypeAndIndex = true;

type AssertUpsertInputDeclaresType = UpsertBenchmarkInput extends { type?: string } ? true : never;
const _upsertAssertion: AssertUpsertInputDeclaresType = true;

type AssertClientDeclaresRunArtifacts = BenchmarkClient extends {
  createRunArtifact(slug: string, runId: string, input: CreateRunArtifactInput): Promise<CreateRunArtifactResponse>;
  uploadRunArtifact(slug: string, runId: string, input: UploadRunArtifactInput): Promise<CreateRunArtifactResponse>;
} ? true : never;
const _clientAssertion: AssertClientDeclaresRunArtifacts = true;

void _configAssertion;
void _upsertAssertion;
void _clientAssertion;

describe('@benchsdk/client parity', () => {
  it('re-exports the runner value surface', () => {
    const runnerKeys = Object.keys(runner).sort().filter((k) => k !== 'createBenchmarkClient');
    const clientMod = client as Record<string, unknown>;
    for (const key of runnerKeys) {
      expect(clientMod[key]).toBe((runner as Record<string, unknown>)[key]);
    }
  });

  it('exposes the run-level artifact methods on the client', () => {
    const c = createBenchmarkClient({ baseUrl: 'https://platform.test/api/v1', apiKey: 'key' });
    expect(typeof c.createRunArtifact).toBe('function');
    expect(typeof c.uploadRunArtifact).toBe('function');
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
