import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { getVolumeAdapter, MOUNT_PATH } from './volumes-adapters.js';
import {
  ensureSuperserveVolumeTemplate,
  SUPERSERVE_VOLUME_TEMPLATE_NAME,
  superserveVolumeTemplateId,
  superserveVolumeTemplateSpec,
} from './superserve-volume-template.js';

test('Superserve mounts the same bounded volume on replacement guests', async (t) => {
  const previous = process.env.SUPERSERVE_VOLUME_TEMPLATE_ID;
  delete process.env.SUPERSERVE_VOLUME_TEMPLATE_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.SUPERSERVE_VOLUME_TEMPLATE_ID;
    else process.env.SUPERSERVE_VOLUME_TEMPLATE_ID = previous;
  });
  const creates: unknown[] = [];
  const attachments: unknown[] = [];
  const volumeCreates: unknown[] = [];
  const deleted: unknown[] = [];
  const compute = {
    volume: {
      create: async (options: unknown) => {
        volumeCreates.push(options);
        return { id: 'volume-id', name: 'fixture-volume' };
      },
      delete: async (id: string) => { deleted.push(id); },
    },
    sandbox: {
      create: async (options: unknown) => {
        creates.push(options);
        return { attachVolume: async (...args: unknown[]) => { attachments.push(args); } };
      },
    },
  };
  const adapter = getVolumeAdapter('superserve');
  assert.ok(adapter);
  const volume = await adapter.createVolume('fixture-volume', MOUNT_PATH, compute);
  const original = { templateId: 'node-22-docker', timeout: 600_000 };
  const args = { compute, sandboxOptions: original, volume, mountPath: MOUNT_PATH };
  const first = await adapter.createMounted(args);
  const replacement = await adapter.createMounted(args);
  assert.notEqual(first.sandbox, replacement.sandbox);
  assert.deepEqual(volumeCreates, [{ name: 'fixture-volume', sizeBytes: 1024 * 1024 * 1024 }]);
  assert.deepEqual(creates, [
    { templateId: SUPERSERVE_VOLUME_TEMPLATE_NAME, timeout: 600_000 },
    { templateId: SUPERSERVE_VOLUME_TEMPLATE_NAME, timeout: 600_000 },
  ]);
  assert.deepEqual(original, { templateId: 'node-22-docker', timeout: 600_000 });
  assert.deepEqual(attachments, [[volume, MOUNT_PATH], [volume, MOUNT_PATH]]);
  await adapter.destroyVolume(volume, compute);
  assert.deepEqual(deleted, ['volume-id']);
});

test('a selected prepared template UUID is used only for Superserve volume guests', async (t) => {
  const id = '00000000-0000-4000-8000-000000000001';
  const previous = process.env.SUPERSERVE_VOLUME_TEMPLATE_ID;
  process.env.SUPERSERVE_VOLUME_TEMPLATE_ID = id;
  t.after(() => {
    if (previous === undefined) delete process.env.SUPERSERVE_VOLUME_TEMPLATE_ID;
    else process.env.SUPERSERVE_VOLUME_TEMPLATE_ID = previous;
  });
  let options: unknown;
  const compute = { sandbox: { create: async (value: unknown) => { options = value; return { attachVolume: async () => {} }; } } };
  await getVolumeAdapter('superserve')!.createMounted({ compute, volume: { id: 'volume-id', name: 'fixture-volume' }, mountPath: MOUNT_PATH });
  assert.deepEqual(options, { templateId: id });
  await getVolumeAdapter('novita')!.createMounted({ compute, sandboxOptions: { templateId: 'other-template' }, volume: { id: 'other-volume', name: 'other' }, mountPath: MOUNT_PATH });
  assert.deepEqual(options, { templateId: 'other-template' });
  process.env.SUPERSERVE_VOLUME_TEMPLATE_ID = 'not-a-uuid';
  assert.throws(superserveVolumeTemplateId, /must be a template UUID/);
});

test('Superserve destroys a newly created guest when runtime attachment fails', async () => {
  const failure = new Error('attachment denied');
  let destroyed = 0;
  const compute = {
    sandbox: {
      create: async () => ({
        attachVolume: async () => { throw failure; },
        destroy: async () => { destroyed++; },
      }),
    },
  };
  await assert.rejects(
    () => getVolumeAdapter('superserve')!.createMounted({ compute, volume: { id: 'volume-id', name: 'fixture-volume' }, mountPath: MOUNT_PATH }),
    (error) => error === failure,
  );
  assert.equal(destroyed, 1);
});

test('Superserve volume deletion failures remain failures', async () => {
  const failure = new Error('volume remains attached');
  await assert.rejects(
    () => getVolumeAdapter('superserve')!.destroyVolume(
      { id: 'volume-id', name: 'fixture-volume' },
      { volume: { delete: async () => { throw failure; } } },
    ),
    (error) => error === failure,
  );
});

function templateFixture(status = 'ready', createError?: Error) {
  const actions: unknown[] = [];
  const template = {
    id: 'template-id',
    getInfo: async () => { actions.push('info'); return { status }; },
    rebuild: async () => { actions.push('rebuild'); },
    waitUntilReady: async () => { actions.push('wait'); },
  };
  const api = {
    create: async (options: unknown) => {
      actions.push(['create', options]);
      if (createError) throw createError;
      return template;
    },
    list: async (options: unknown) => {
      actions.push(['list', options]);
      return [{ id: 'wrong-id', name: SUPERSERVE_VOLUME_TEMPLATE_NAME + '-other' }, { id: template.id, name: SUPERSERVE_VOLUME_TEMPLATE_NAME }];
    },
    connect: async (id: string, options: unknown) => { actions.push(['connect', id, options]); return template; },
  };
  return { api, actions };
}

test('new volume templates finish building before setup succeeds', async () => {
  const { api, actions } = templateFixture();
  assert.equal(await ensureSuperserveVolumeTemplate('fixture-key', api), 'template-id');
  assert.deepEqual(actions, [['create', { apiKey: 'fixture-key', ...superserveVolumeTemplateSpec() }], 'wait']);
  const step = superserveVolumeTemplateSpec().steps?.find((candidate) => 'run' in candidate);
  assert.ok(step && 'run' in step);
  execFileSync('bash', ['-n'], { input: step.run });
});

test('a ready name collision resolves the exact template UUID and reuses it', async () => {
  const { api, actions } = templateFixture('ready', new Error('HTTP 409: name already exists'));
  assert.equal(await ensureSuperserveVolumeTemplate('fixture-key', api), 'template-id');
  assert.deepEqual(actions.slice(1), [
    ['list', { apiKey: 'fixture-key', namePrefix: SUPERSERVE_VOLUME_TEMPLATE_NAME }],
    ['connect', 'template-id', { apiKey: 'fixture-key' }],
    'info',
  ]);
});

test('a failed existing template waits for the replacement build after reconnecting', async () => {
  let latestBuildId = 'failed-build';
  const waitedBuilds: string[] = [];
  const api = {
    create: async () => { throw new Error('HTTP 409: name already exists'); },
    list: async () => [{ id: 'template-id', name: SUPERSERVE_VOLUME_TEMPLATE_NAME }],
    connect: async (id: string, options: { apiKey: string }) => {
      assert.equal(id, 'template-id');
      assert.deepEqual(options, { apiKey: 'fixture-key' });
      const cachedBuildId = latestBuildId;
      return {
        id,
        getInfo: async () => ({ status: cachedBuildId === 'failed-build' ? 'failed' : 'building' }),
        rebuild: async () => { latestBuildId = 'replacement-build'; },
        waitUntilReady: async () => {
          waitedBuilds.push(cachedBuildId);
          if (cachedBuildId === 'failed-build') throw new Error('Template build failed: failed-build');
        },
      };
    },
  };
  assert.equal(await ensureSuperserveVolumeTemplate('fixture-key', api), 'template-id');
  assert.equal(latestBuildId, 'replacement-build');
  assert.deepEqual(waitedBuilds, ['replacement-build']);
});

test('an in-progress existing template is awaited without starting another build', async () => {
  const { api, actions } = templateFixture('building', new Error('HTTP 409: name already exists'));
  await ensureSuperserveVolumeTemplate('fixture-key', api);
  assert.deepEqual(actions.slice(-2), ['info', 'wait']);
});

test('unrelated create errors and missing conflicting templates stop setup', async () => {
  const failure = new Error('authentication failed');
  const first = templateFixture('ready', failure);
  await assert.rejects(() => ensureSuperserveVolumeTemplate('fixture-key', first.api), (error) => error === failure);
  assert.equal(first.actions.length, 1);
  const second = templateFixture('ready', new Error('HTTP 409'));
  second.api.list = async () => [];
  await assert.rejects(() => ensureSuperserveVolumeTemplate('fixture-key', second.api), /no matching template/);
});

test('a missing API key stops setup before any API request', async () => {
  const { api, actions } = templateFixture();
  await assert.rejects(() => ensureSuperserveVolumeTemplate('', api), /SUPERSERVE_API_KEY/);
  assert.equal(actions.length, 0);
});

test('a supplied template UUID is checked without creating or rebuilding it', async () => {
  const { api, actions } = templateFixture();
  const id = '00000000-0000-4000-8000-000000000001';
  await ensureSuperserveVolumeTemplate('fixture-key', api, id);
  assert.deepEqual(actions, [['connect', id, { apiKey: 'fixture-key' }], 'wait']);
});
