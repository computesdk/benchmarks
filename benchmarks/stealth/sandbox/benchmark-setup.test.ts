import assert from 'node:assert/strict';
import type { TaskContext } from '@benchsdk/runner';
import type { ProviderConfig } from './types.js';
import { getCiSandboxOptions } from './resource-options.js';
import { PROVIDER_SIZE_OPTIONS } from './sizes.js';
import { task } from './sandbox-pause-resume.bench.js';

const lease = 3_600_000;
const base = { timeout: 600_000, hardTtl: 900, templateId: 'custom' };
assert.deepEqual(getCiSandboxOptions('sail', base, lease), { timeout: lease, hardTtl: 900, templateId: 'custom', sizeClass: 'xl' });
assert.equal(base.timeout, 600_000);
assert.equal(getCiSandboxOptions('sail', base, 240_000, 'deadline').timeout, 240_000);
assert.deepEqual(getCiSandboxOptions('sandbox0', { hardTtl: 900 }, lease), { memory: 16384, timeout: lease, ttl: 3600, hardTtl: 3600 });
assert.deepEqual(getCiSandboxOptions('sandbox0', { hardTtl: 900 }, 240_000, 'deadline'), { timeout: 240_000, ttl: 240, hardTtl: 240 });
assert.equal(getCiSandboxOptions('e2b', { timeout: 600_000 }, lease).timeout, lease);
const mosaic = getCiSandboxOptions('mosaic', {}, lease);
for (const [key, value] of Object.entries(PROVIDER_SIZE_OPTIONS.mosaic.xlarge!)) assert.equal(mosaic[key], value);

async function pauseFixture(snapshotWorkdir?: string, capabilityPath?: string) {
  const files = new Map<string, string>();
  const directories: string[] = [];
  let created: unknown;
  let destroyed = 0;
  let paused = false;
  const sandbox = {
    sandboxId: 'setup-fixture-id',
    filesystem: {
      mkdir: async (dir: string) => { directories.push(dir); },
      writeFile: async (file: string, content: string) => { files.set(file, content); },
      readFile: async (file: string) => files.get(file) ?? '',
      exists: async (file: string) => files.has(file),
    },
    runCommand: async (command: string) => ({ stdout: command === 'pwd' ? '/root\n' : '', stderr: '', exitCode: 0 }),
    pause: async () => { paused = true; },
    resume: async () => { paused = false; },
    getInfo: async () => ({ status: paused ? 'paused' : 'running' }),
    destroy: async () => { destroyed++; },
  };
  const compute = {
    sandbox: { create: async (options: unknown) => { created = options; return sandbox; } },
    snapshot: { capabilities: { path: capabilityPath, createOptions: { snapshotVolume: true } } },
  };
  const ctx: TaskContext<ProviderConfig> = {
    participant: { name: 'setup-fixture', requiredEnvVars: [], snapshotWorkdir, sandboxOptions: { image: 'base' }, createCompute: () => compute },
    taskIndex: 0,
    step: (async (_name: string, fn: () => unknown) => fn()) as TaskContext<ProviderConfig>['step'],
    measure: () => {},
    log: () => {},
  };
  const result = await task(ctx);
  assert.equal(result?.data?.verifyPassed, true);
  assert.equal(destroyed, 1);
  assert.deepEqual(created, { image: 'base', snapshotVolume: true });
  assert.ok(directories[0].startsWith(`${capabilityPath ?? snapshotWorkdir ?? '/root'}/bench-pause-resume-`));
}

await pauseFixture('/workspace');
await pauseFixture('/ignored', '/volume');
await pauseFixture();
console.log('shared benchmark setup tests passed');
