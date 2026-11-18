import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskContext } from '@benchsdk/runner';
import { task } from './sandbox-fidelity.bench.js';
import type { ProviderConfig } from './types.js';

function fixture(writeDelayMs: number, timeout: number) {
  let destroys = 0;
  const sandbox = {
    sandboxId: 'fidelity-budget-test',
    runCommand: async (command: string) => ({
      exitCode: 0,
      stdout: command === 'pwd' ? '/workspace\n' : '',
    }),
    filesystem: {
      mkdir: async () => {},
      writeFile: async (_path: string, content: string) => {
        if (content.length === 256 * 1024) await delay(writeDelayMs);
      },
      readFile: async () => '',
      exists: async () => false,
    },
    destroy: async () => { destroys += 1; },
  };
  const ctx: TaskContext<ProviderConfig> = {
    participant: {
      name: 'fidelity-budget-test',
      requiredEnvVars: [],
      timeout,
      createCompute: () => ({ sandbox: { create: async () => sandbox } }),
    },
    taskIndex: 0,
    step: (async (_name: string, fn: () => unknown) => fn()) as TaskContext<ProviderConfig>['step'],
    measure: () => {},
    log: () => {},
  };
  return { ctx, destroys: () => destroys };
}

const withinBudget = fixture(1_100, 5_000);
const result = await task(withinBudget.ctx);
assert.ok(result?.data);
assert.ok(Number(result.data.populateMs) >= 1_000, 'setup may take longer than one second');
assert.equal(result.data.snapshotSupported, false);
assert.equal(withinBudget.destroys(), 1);

const overBudget = fixture(200, 100);
await assert.rejects(Promise.resolve(task(overBudget.ctx)), /Filesystem population timed out/);
assert.equal(overBudget.destroys(), 1, 'a real deadline still cleans up the sandbox');

console.log('sandbox-fidelity budget tests passed');
