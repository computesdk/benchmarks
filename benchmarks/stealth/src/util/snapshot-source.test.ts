import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkSourceIntact, resolveSnapshotDir, startSourceHeartbeat } from './snapshot.js';

const exec = promisify(execFile);

async function testHeartbeatLaunch(forceFork: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot heartbeat-'));
  const writerPidFile = join(directory, 'writer-pid');
  const setsid = (await exec('sh', ['-c', 'command -v setsid'])).stdout.trim();
  const nohup = (await exec('sh', ['-c', 'command -v nohup'])).stdout.trim();
  const sandbox = {
    sandboxId: 'local-heartbeat',
    async runCommand(command: string) {
      try {
        const { stdout } = await exec('sh', ['-c', command], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TMPDIR: directory },
          timeout: 10_000,
        });
        return { exitCode: 0, stdout };
      } catch (error) {
        const failure = error as { code: number; stdout: string };
        return { exitCode: failure.code, stdout: failure.stdout };
      }
    },
  };
  try {
    await writeFile(join(directory, 'setsid'), `#!/bin/sh\nexec "${setsid}" ${forceFork ? '-f ' : ''}"$@"\n`, { mode: 0o755 });
    await writeFile(join(directory, 'nohup'), `#!/bin/sh\necho "$$" > "${writerPidFile}"\nexec "${nohup}" "$@"\n`, { mode: 0o755 });
    const heartbeat = await startSourceHeartbeat(sandbox, `launch-${forceFork}`);
    assert.equal(heartbeat.pid, Number((await readFile(writerPidFile, 'utf8')).trim()), 'track the writer, not the setsid launcher');
    assert.equal((await checkSourceIntact(kept, sandbox, heartbeat)).sourceIntact, true);
    process.kill(heartbeat.pid, 'SIGKILL');
    assert.equal((await checkSourceIntact(kept, sandbox, heartbeat)).sourceIntact, false);
  } finally {
    const pid = Number(await readFile(writerPidFile, 'utf8').catch(() => ''));
    if (pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const hb = { pid: 42, file: '/tmp/hb' };
const kept = { snapshot: { capabilities: { source: 'kept' } } };
const destroyed = (found: unknown) => ({
  snapshot: { capabilities: { source: 'destroyed' } },
  sandbox: { getById: async () => found },
});
const box = (outputs: Array<string | Error>) => {
  let i = 0;
  return {
    sandboxId: 'sbx-1',
    async runCommand() {
      const out = outputs[Math.min(i++, outputs.length - 1)];
      if (out instanceof Error) throw out;
      return { exitCode: 0, stdout: out };
    },
  };
};

async function main() {
  await testHeartbeatLaunch(false);
  await testHeartbeatLaunch(true);

  const root = box(['/']);
  assert.deepEqual(await resolveSnapshotDir(root, kept, 1_000, '/workspace/'), { dir: '/workspace', source: 'configured' });
  const volume = { snapshot: { capabilities: { scope: 'volume', path: '/cache', excludes: ['/tmp'] } } };
  assert.deepEqual(await resolveSnapshotDir(root, volume, 1_000, '/workspace'), { dir: '/cache', source: 'capability' });
  await assert.rejects(resolveSnapshotDir(root, kept, 1_000, 'workspace'), /snapshot workdir/);
  const excludes = { snapshot: { capabilities: { excludes: ['/tmp'] } } };
  await assert.rejects(resolveSnapshotDir(root, excludes, 1_000, '/tmp/../tmp/payload'), /snapshot workdir/);
  assert.deepEqual(await resolveSnapshotDir(box(['/home/user']), kept), { dir: '/home/user', source: 'workdir' });

  // A probe that throws is not proof the source is gone: cleanup must still destroy it.
  const unreachable = await checkSourceIntact(kept, box([new Error('ECONNRESET')]), hb);
  assert.equal(unreachable.sourceIntact, false);
  assert.equal(unreachable.sourceGone, false);
  assert.match(unreachable.reason ?? '', /unreachable after snapshot: ECONNRESET/);

  // Only getById finding nothing proves the source is gone.
  const gone = await checkSourceIntact(destroyed(null), box(['alive\n1']), hb);
  assert.equal(gone.sourceIntact, false);
  assert.equal(gone.sourceGone, true);

  // A rejected getById (transient API error) is not proof either: fall through to the probes.
  const flaky = {
    snapshot: { capabilities: { source: 'destroyed' } },
    sandbox: { getById: async () => { throw new Error('503'); } },
  };
  const lookupFailed = await checkSourceIntact(flaky, box(['alive\n3', 'alive\n8\n1000\n1100']), hb);
  assert.equal(lookupFailed.sourceGone, false);
  assert.equal(lookupFailed.sourceIntact, true);

  // Declared destroyed but still there (and alive) is checked, not excused.
  const alive = await checkSourceIntact(destroyed(box(['alive\n3', 'alive\n8\n1000\n1100\n3600\n3700'])), box([]), hb);
  assert.equal(alive.sourceIntact, true);
  assert.equal(alive.snapshotFreezeMs, 2500);

  // PID gone (e.g. Vercel's stop-on-snapshot, then auto-resume) fails without claiming gone.
  const dead = await checkSourceIntact(kept, box(['dead\n5', 'dead\n5\n1000\n1100']), hb);
  assert.equal(dead.sourceIntact, false);
  assert.equal(dead.sourceGone, false);
  assert.match(dead.reason ?? '', /heartbeat pid 42 gone/);

  // Alive but heartbeat not advancing fails.
  const stalled = await checkSourceIntact(kept, box(['alive\n5', 'alive\n5\n1000\n1100']), hb);
  assert.equal(stalled.sourceIntact, false);
  assert.match(stalled.reason ?? '', /heartbeat stopped/);

  console.log('snapshot-source: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
