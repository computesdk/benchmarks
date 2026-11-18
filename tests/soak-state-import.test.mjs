import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freshState, readState, writeState } from '../benchmarks/stealth/sandbox/sandbox-soak.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(repo, 'benchmarks/stealth/scripts/import-soak-state.mjs');
const run = (directory, provider, state) => spawnSync(process.execPath, [script], {
  cwd: directory, encoding: 'utf8', env: { ...process.env, SOAK_PROVIDER: provider, SOAK_STATE_JSON: JSON.stringify(state) },
});

test('exported state preserves sandbox identity, chain progress and orphan cleanup across two shifts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-handoff-'));
  try {
    const state = { ...freshState(4), sandboxId: 'private-sandbox-fixture', workdir: '/workspace/soak', verifiedLines: 123,
      headHash: 'a'.repeat(64), headTs: 1700000000, ticksAttempted: 12, ticksPassed: 11, ticksFailed: 1,
      orphanedSandboxIds: ['private-orphan-fixture'], lastCheckAt: new Date().toISOString() };
    const result = run(directory, 'e2b', state);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(state.sandboxId), 'do not log private state');
    const file = path.join(directory, 'results/sandbox_soak/state/e2b.json');
    const first = readState(file);
    assert.deepEqual(first, state);
    const next = { ...first, verifiedLines: 124, ticksAttempted: 13, ticksPassed: 12 };
    writeState(file, next);
    assert.deepEqual(readState(file), next);
    assert.equal(readState(file).sandboxId, state.sandboxId);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const [name, provider, change] of [
  ['path traversal', '../e2b', {}],
  ['unknown provider', 'unknown-provider', {}],
  ['invalid chain progress', 'e2b', { verifiedLines: -1 }],
  ['invalid epoch', 'e2b', { epochStartedAt: 'not-a-date' }],
  ['unexpected payload fields', 'e2b', { apiKey: 'must-not-store' }],
]) {
  test(`reject ${name} without writing state`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-invalid-'));
    try {
      const result = run(directory, provider, { ...freshState(), ...change });
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(directory, 'results')), false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

test('refuse to overwrite staged provider state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-existing-'));
  try {
    const first = { ...freshState(), sandboxId: 'existing-fixture' };
    assert.equal(run(directory, 'e2b', first).status, 0);
    assert.notEqual(run(directory, 'e2b', { ...first, sandboxId: 'stale-fixture' }).status, 0);
    assert.equal(readState(path.join(directory, 'results/sandbox_soak/state/e2b.json')).sandboxId, first.sandboxId);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('handoff shares the production execution lock and exact provider cache namespace', () => {
  const read = (name) => fs.readFileSync(path.join(repo, '.computesdk/workflows', name), 'utf8');
  const handoff = read('stealth-soak-state-import.yml');
  const soak = read('stealth-sandbox-soak.yml');
  assert.equal(handoff.match(/^  group: (.+)$/m)[1], soak.match(/^  group: (.+)$/m)[1]);
  const key = (source) => source.match(/^          key: (.+)$/m)[1];
  assert.equal(key(handoff).replace('inputs.provider', 'matrix.provider'), key(soak));
  assert.match(handoff, /steps.seeded.outputs.cache-hit/);
  assert.match(handoff, /vars.STEALTH_BENCHMARKS_ENABLED != 'true'/);
});
