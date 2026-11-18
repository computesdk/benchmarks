import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { TaskResultRecord } from '@benchsdk/client';
import { recordsToCpuBurstResults } from './sandbox-cpu-burst-legacy-results.js';
import { recordsToFsIoResults } from './sandbox-fs-io-legacy-results.js';
import { recordsToSandboxFilesystemResults } from './sandbox-fs-api-legacy-results.js';
import { writeCpuBurstResultsJson } from './sandbox-cpu-burst.js';
import { writeFsIoResultsJson, computeFsIoStats } from './sandbox-fs-io.js';
import { writeSandboxFilesystemResultsJson, computeSandboxFilesystemStats } from './sandbox-fs-api.js';
import { scoreSessionPersistenceRecords } from '../browser/session-persistence-legacy-results.js';

// Exercise actual matrix entrypoints in an isolated copied source tree. Never
// write checked-in history. Catches copied stale scores, lost error statuses,
// rounding during JSON normalization and divergent combined raw populations.
const record = (data: Record<string, unknown>, status = 'success') => ({ taskIndex: 0, status, data }) as TaskResultRecord;
const participant = (records: TaskResultRecord[]) => [{ participant: 'fixture', records }];
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('actual performance and session matrix scripts retain raw precision, statuses and fixed populations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'performance-matrix-'));
  try {
    await fs.cp(path.join(repo, 'benchmarks'), path.join(root, 'benchmarks'), { recursive: true });
    await fs.symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const artifact = async (kind: string, suffix: string) => {
      const file = path.join(root, 'artifacts', kind, suffix);
      await fs.mkdir(path.dirname(file), { recursive: true });
      return file;
    };
    const run = (script: string, kind: string) => execFileSync(process.execPath, [
      path.join(repo, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'benchmarks/stealth/scripts', script),
      '--input', path.join(root, 'artifacts', kind),
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
    const output = async (kind: string) => JSON.parse(await fs.readFile(path.join(root, 'results', kind, 'latest.json'), 'utf8'));

    const burst = recordsToCpuBurstResults(participant([
      record({ burstHeadroom: 9.123456789 }), record({}, 'error'),
    ]));
    const cpuPath = await artifact('cpu', 'results-fixture/latest.json');
    await writeCpuBurstResultsJson(burst, cpuPath);
    const saved = JSON.parse(await fs.readFile(cpuPath, 'utf8'));
    saved.results[0].compositeScore = -1; // New status-bearing evidence must be recomputed.
    await fs.writeFile(cpuPath, JSON.stringify(saved));
    run('merge-sandbox-cpu-burst-results.ts', 'cpu');
    const cpuMerged = (await output('sandbox_cpu_burst')).results[0];
    assert.equal(cpuMerged.compositeScore, burst[0].compositeScore);
    assert.equal(cpuMerged.iterations[1].meta.taskStatus, 'error');

    const ioA = recordsToFsIoResults(participant([record({ verified: true, totalMs: 9000.123456789 })]), 'default');
    const ioB = recordsToFsIoResults(participant([record({ verified: true, totalMs: 18000.987654321 }), record({}, 'error')]), 'large');
    for (const [mode, result] of [['default', ioA], ['large', ioB]] as const) {
      await writeFsIoResultsJson(result, await artifact('io', `results-${mode}/sandbox_fs_io/${mode}/fixture.json`), mode);
    }
    run('merge-sandbox-fs-io-results.ts', 'io');
    const ioMerged = (await output('sandbox_fs_io')).results[0];
    assert.equal(ioMerged.compositeScore, computeFsIoStats([...ioA[0].iterations, ...ioB[0].iterations]).compositeScore);
    assert.equal(ioMerged.iterations.filter((r: any) => r.meta.taskStatus === 'error').length, 1);

    const apiA = recordsToSandboxFilesystemResults(participant([record({ verified: true, rankScore: 40.123456789, completedSizes: 1, totalSizes: 3, meta: { verified: true } })]));
    const apiB = recordsToSandboxFilesystemResults(participant([record({ verified: true, rankScore: 180.987654321, completedSizes: 3, totalSizes: 3, meta: { verified: true } }), record({}, 'error')]));
    for (const [size, result] of [['40k', apiA], ['1m', apiB]] as const) {
      await writeSandboxFilesystemResultsJson(result, await artifact('api', `results-${size}/sandbox_fs_api/${size}/fixture.json`));
    }
    run('merge-sandbox-fs-api-results.ts', 'api');
    const apiMerged = (await output('sandbox_fs_api')).results[0];
    assert.equal(apiMerged.compositeScore, computeSandboxFilesystemStats([...apiA[0].iterations, ...apiB[0].iterations]).compositeScore);

    const sessionRecords = [record({ resumeSupported: 1, cookiesPreserved: 1, storagePreserved: 1, tabsPreserved: 1,
      reconnectMs: 2222.123456789, totalMs: 5555.987654321 }), record({}, 'error')];
    await fs.writeFile(await artifact('session', 'results-fixture/latest.json'), JSON.stringify({ results: [
      { provider: 'fixture', records: sessionRecords, compositeScore: -1 },
      { provider: 'historical', iterations: [{ resumeSupported: 1 }], compositeScore: 17.123456789 },
    ] }));
    run('merge-browser-session-persistence-results.ts', 'session');
    const sessionMerged = (await output('browser_session_persistence')).results;
    assert.equal(sessionMerged.find((r: any) => r.provider === 'fixture').compositeScore, scoreSessionPersistenceRecords(sessionRecords));
    assert.equal(sessionMerged.find((r: any) => r.provider === 'historical').compositeScore, 17.123456789);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
