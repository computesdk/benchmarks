import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { benchmarkResultsDir } from './results.js';
import { writeSnapshotLegacyResults } from '../../sandbox/sandbox-snapshot.js';

const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
const before = process.env.BENCH_RESULTS_DIR;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'current-results-'));
try {
  delete process.env.BENCH_RESULTS_DIR;
  assert.equal(benchmarkResultsDir('sandbox_snapshot'), path.join(repoDir, 'results/sandbox_snapshot'));
  process.env.BENCH_RESULTS_DIR = 'results/current-run-attempt/provider';
  assert.equal(benchmarkResultsDir('sandbox_fs_io/medium'), path.join(repoDir, 'results/current-run-attempt/provider/sandbox_fs_io/medium'));
  const stale = path.join(fixture, 'history/sandbox_snapshot');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'latest.json'), '{"results":[{"provider":"historical"}]}');
  process.env.BENCH_RESULTS_DIR = path.join(fixture, 'current-run-attempt/provider');
  await writeSnapshotLegacyResults([], { resultsDir: benchmarkResultsDir('sandbox_snapshot') });
  const fresh = JSON.parse(fs.readFileSync(path.join(benchmarkResultsDir('sandbox_snapshot'), 'latest.json'), 'utf8'));
  assert.deepEqual(fresh.results, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stale, 'latest.json'), 'utf8')).results[0].provider, 'historical');
  assert.equal(fs.existsSync(path.join(fixture, 'current-run-attempt/other-provider')), false);
  const workflows = ["sandbox-snapshot","filesystem-snapshot","sandbox-fidelity","sandbox-snapshot-fanout","sandbox-pause-resume","sandbox-burst-survival","sandbox-cpu-burst","sandbox-fs-io","sandbox-fs-api","sandbox-rootfs","sandbox-volumes","oci-tti","sandbox-ci-capabilities","os-capabilities","sandbox-cpu"];
  for (const workflow of workflows) {
    const yaml = fs.readFileSync(path.join(repoDir, '.github/workflows', 'stealth-' + workflow + '.yml'), 'utf8');
    assert.ok(!yaml.includes('\n  collect:'), workflow);
    assert.ok(!/git (?:add|commit|push).*results/.test(yaml), workflow);
    assert.ok(!/path: results\//.test(yaml), workflow);
  }
  const input = path.join(fixture, 'artifacts/provider/sandbox_snapshot');
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(input, '2026-01-01.json'), JSON.stringify({ results: [{ provider: 'fresh', compositeScore: 1 }] }));
  const output = path.join(fixture, 'github-output');
  const merge = () => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(repoDir, 'benchmarks/stealth/src/merge-results.ts'), '--input', path.join(fixture, 'artifacts')], {
    cwd: fixture,
    env: { ...process.env, BENCHMARK_SLUG: 'sandbox-snapshot', GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  const merged = merge();
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'artifact_paths<<BENCH_ARTIFACTS\nresults/sandbox_snapshot/latest.json\nBENCH_ARTIFACTS\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'results/sandbox_snapshot/latest.json'), 'utf8')).results[0].provider, 'fresh');
  fs.unlinkSync(path.join(input, '2026-01-01.json'));
  fs.writeFileSync(output, '');
  const empty = merge();
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  console.log('current-run artifact isolation tests passed');
} finally {
  if (before === undefined) delete process.env.BENCH_RESULTS_DIR;
  else process.env.BENCH_RESULTS_DIR = before;
  fs.rmSync(fixture, { recursive: true, force: true });
}
