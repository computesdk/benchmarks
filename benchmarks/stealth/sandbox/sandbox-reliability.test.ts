import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskContext } from '@benchsdk/runner';
import type { ProviderConfig } from './types.js';
import { providers } from './sandbox-reliability.providers.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';

const exceptionListeners = new Set(process.listeners('uncaughtException'));
const rejectionListeners = new Set(process.listeners('unhandledRejection'));
const { config, task, beforeExit } = await import('./sandbox-reliability.bench.js');
for (const listener of process.listeners('uncaughtException')) {
  if (!exceptionListeners.has(listener)) process.removeListener('uncaughtException', listener);
}
for (const listener of process.listeners('unhandledRejection')) {
  if (!rejectionListeners.has(listener)) process.removeListener('unhandledRejection', listener);
}

for (const name of ['gravixlayer', 'promigence', 'createos', 'codesandbox', 'kosa8']) {
  assert.ok(!providers.some((provider) => provider.name === name), `${name} must not be in the reliability roster`);
  assert.ok(!config.participants.some((participant) => participant.name === name), `${name} must not be measured`);
}
assert.deepEqual(config.participants, providers.filter((provider) => !provider.manualOnly));
assert.equal(config.concurrency, config.participants.length);

function fixture(options: {
  createDelay?: number;
  createError?: Error;
  probeError?: Error;
  destroyError?: Error;
} = {}) {
  let destroys = 0;
  let probes = 0;
  const logs: string[] = [];
  const measurements: unknown[] = [];
  const deadlines = new Map<string, number | undefined>();
  const sandbox = {
    sandboxId: 'reliability-exact-native-id',
    runCommand: async () => {
      probes += 1;
      if (options.probeError) throw options.probeError;
      return { exitCode: 0, stdout: 'RELIABILITY_OK hash=abc', stderr: '', durationMs: 3 };
    },
    destroy: async () => {
      destroys += 1;
      if (options.destroyError) throw options.destroyError;
    },
  };
  const ctx: TaskContext<ProviderConfig> = {
    participant: {
      name: 'reliability-test',
      requiredEnvVars: [],
      timeout: 5,
      createCompute: () => ({ sandbox: { create: async () => {
        if (options.createDelay) await delay(options.createDelay);
        if (options.createError) throw options.createError;
        return sandbox;
      } } }),
    },
    taskIndex: 0,
    step: (async (name, fn, opts) => {
      deadlines.set(name, opts?.timeoutMs);
      return withTimeout(Promise.resolve().then(fn), opts?.timeoutMs ?? 1_000, `${name} step timed out`);
    }) as TaskContext<ProviderConfig>['step'],
    measure: (value) => { measurements.push(value); },
    log: (message, opts) => { logs.push(`${message} ${JSON.stringify(opts?.meta)}`); },
  };
  return { ctx, logs, measurements, deadlines, destroys: () => destroys, probes: () => probes };
}

const normal = fixture();
const result = await task(normal.ctx);
assert.equal(result?.data?.provider, 'reliability-test');
assert.equal(normal.destroys(), 1);
assert.equal(normal.measurements.length, 1);
assert.equal(normal.deadlines.get('create'), 5);
assert.equal(normal.deadlines.get('probe'), 40_000);
assert.equal(normal.deadlines.get('destroy'), 35_000);

const failedProbe = fixture({ probeError: new Error('probe refused') });
await assert.rejects(Promise.resolve(task(failedProbe.ctx)), /probe refused/);
assert.equal(failedProbe.destroys(), 1);
assert.equal(failedProbe.measurements.length, 0);

const late = fixture({ createDelay: 25 });
await assert.rejects(Promise.resolve(task(late.ctx)), /create step timed out/);
assert.equal(late.probes(), 0);
assert.equal(late.measurements.length, 0);
await beforeExit();
assert.equal(late.destroys(), 1);
assert.ok(late.logs.some((line) => line.includes('late sandbox') && line.includes('reliability-exact-native-id')));

const lateRejection = fixture({ createDelay: 25, createError: new Error('late provider rejection') });
await assert.rejects(Promise.resolve(task(lateRejection.ctx)), /create step timed out/);
await drainLateCleanups(100);
assert.equal(lateRejection.destroys(), 0);
assert.ok(lateRejection.logs.some((line) => line.includes('late provider rejection')));

const failedDestroy = fixture({ destroyError: new Error('delete refused') });
await assert.rejects(Promise.resolve(task(failedDestroy.ctx)), (error: unknown) => {
  const e = error as Error & { data: Record<string, unknown> };
  assert.match(e.message, /cleanup failed/);
  assert.equal(e.data.sandboxId, 'reliability-exact-native-id');
  assert.equal(e.data.destroyError, 'delete refused');
  return true;
});
assert.equal(failedDestroy.destroys(), 1);
assert.equal(failedDestroy.measurements.length, 0);

const bothFailed = fixture({ probeError: new Error('primary probe failed'), destroyError: new Error('cleanup also failed') });
await assert.rejects(Promise.resolve(task(bothFailed.ctx)), /primary probe failed/);
assert.equal(bothFailed.destroys(), 1);
assert.ok(bothFailed.logs.some((line) => line.includes('cleanup also failed') && line.includes('reliability-exact-native-id')));

console.log('sandbox-reliability lifecycle tests passed');
