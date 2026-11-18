import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskContext } from '@benchsdk/runner';
import type { ProviderConfig } from './types.js';
import { performanceFsApiRankScore } from './performance-scoring.js';

process.argv.push('--file-size', '40k', '--iterations', '1');
const exceptionListeners = new Set(process.listeners('uncaughtException'));
const rejectionListeners = new Set(process.listeners('unhandledRejection'));
const { task, beforeExit, config } = await import('./sandbox-fs-api.bench.js');
for (const listener of process.listeners('uncaughtException')) {
  if (!exceptionListeners.has(listener)) process.removeListener('uncaughtException', listener);
}
for (const listener of process.listeners('unhandledRejection')) {
  if (!rejectionListeners.has(listener)) process.removeListener('unhandledRejection', listener);
}

function fixture(options: { workdir?: string; failRead?: boolean; destroy?: () => Promise<void>; createDelay?: number; timeout?: number } = {}) {
  const files = new Map<string, string>();
  const directories: string[] = [];
  const logs: { message: string; meta?: unknown }[] = [];
  let destroys = 0;
  const sandbox = {
    sandboxId: 'fs-api-test-native-id',
    filesystem: {
      mkdir: async (dir: string) => { directories.push(dir); },
      writeFile: async (file: string, content: string) => { files.set(file, content); },
      readFile: async (file: string) => {
        if (options.failRead && file.includes('sweep-')) throw new Error('read transport failed');
        return files.get(file) ?? '';
      },
      exists: async (file: string) => files.has(file),
      remove: async (file: string) => { files.delete(file); },
    },
    destroy: async () => { destroys += 1; await options.destroy?.(); },
  };
  const ctx: TaskContext<ProviderConfig> = {
    participant: {
      name: 'fs-api-test',
      requiredEnvVars: [],
      snapshotWorkdir: options.workdir,
      timeout: options.timeout,
      destroyTimeoutMs: 10,
      createCompute: () => ({ sandbox: { create: async () => {
        if (options.createDelay) await delay(options.createDelay);
        return sandbox;
      } } }),
    },
    taskIndex: 0,
    step: (async (_name: string, fn: () => unknown) => fn()) as TaskContext<ProviderConfig>['step'],
    measure: () => {},
    log: (message, opts) => { logs.push({ message, meta: opts?.meta }); },
  };
  return { ctx, directories, logs, destroys: () => destroys };
}

const workspace = fixture({ workdir: '/workspace/' });
const result = await task(workspace.ctx);
assert.ok(result?.data);
assert.equal(result.data.baseDir, '/workspace/bench/fs-fs-api-test');
assert.equal(result.data.sandboxId, 'fs-api-test-native-id');
assert.equal(result.data.verified, true);
assert.equal(result.data.rankScore, result.data.performanceRankScoreV2);
assert.equal(result.data.performanceRankScoreV2, performanceFsApiRankScore(
  1, 1, Number(result.data.sweepRtMs), Number(result.data.sweepTargetMs),
));
assert.equal(config.scoring!.metrics.find((metric) => metric.key === 'rankScore')!.weights.p99, 1);
assert.deepEqual(config.scoring!.metrics.find((metric) => metric.key === 'performanceRankScoreV2')!.weights,
  { median: 0, p95: 0, p99: 0 });
assert.deepEqual(workspace.directories, ['/workspace/bench/fs-fs-api-test']);
assert.equal(workspace.destroys(), 1);

const relative = fixture();
const relativeResult = await task(relative.ctx);
assert.equal(relativeResult?.data?.baseDir, 'bench/fs-fs-api-test');

const broken = fixture({ failRead: true, destroy: async () => { throw new Error('delete refused'); } });
await assert.rejects(Promise.resolve(task(broken.ctx)), (error: unknown) => {
  const e = error as Error & { data: Record<string, unknown> };
  assert.match(e.message, /read transport failed/);
  assert.equal(e.data.sandboxId, 'fs-api-test-native-id');
  assert.equal(e.data.destroyFailed, true);
  assert.equal(e.data.destroyError, 'delete refused');
  return true;
});
assert.equal(broken.destroys(), 1);
assert.ok(broken.logs.some((l) => JSON.stringify(l.meta).includes('fs-api-test-native-id') && l.message.includes('destroy failed')));

const hanging = fixture({ failRead: true, destroy: () => new Promise(() => {}) });
await assert.rejects(Promise.resolve(task(hanging.ctx)), (error: unknown) => {
  assert.equal((error as { data: Record<string, unknown> }).data.destroyError, 'Destroy timeout');
  return true;
});

const late = fixture({ createDelay: 20, timeout: 5 });
await assert.rejects(Promise.resolve(task(late.ctx)), /Sandbox creation timed out/);
await beforeExit();
assert.equal(late.destroys(), 1);
assert.ok(late.logs.some((l) => l.message.includes('late sandbox') && JSON.stringify(l.meta).includes('fs-api-test-native-id')));

console.log('sandbox-fs-api harness tests passed');
