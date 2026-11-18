import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fakeSandbox, loadCpu, output, scriptSourceUrl } from './source-harness.mjs';

function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

test('actual quoted upload and explicit Bash launch preserve a tiny script byte-for-byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-quoted-fixture-'));
  const scriptPath = path.join(dir, 'cpu-benchmark.sh');
  const resultsPath = path.join(dir, 'cpu-bench-results.txt');
  const payload = '$HOME `printf expanded` $(printf expanded) \\ \' "'.padEnd(64, '.');
  assert.equal(Buffer.byteLength(payload), 64);
  const digest = createHash('sha256').update(payload).digest('hex');
  const multiDigest = createHash('sha256').update(payload + payload).digest('hex');
  // This is deliberately a tiny fixture, NOT the production hashing script.
  // All protocol output is mirrored so real recovery can also be exercised.
  const script = `#!/usr/bin/env bash
set -euo pipefail
payload=${shellQuote(payload)}
hash="$(printf '%s' "$payload" | sha256sum)"
printf 'BENCH_META\\tfixture_hash\\t%s\\n' "\${hash%% *}" > "$CPU_FIXTURE_RESULTS"
hash="$(printf '%s%s' "$payload" "$payload" | sha256sum)"
printf 'BENCH_META\\tfixture_multi_hash\\t%s\\n' "\${hash%% *}" >> "$CPU_FIXTURE_RESULTS"
printf 'BENCH_META\\tlogical_cpus\\t2\\nBENCH_PHASE\\tsingle\\t1\\nBENCH_BYTES\\tsingle\\t64\\nBENCH_PHASE\\tmulti\\t1\\nBENCH_BYTES\\tmulti\\t128\\nBENCH_DONE\\n' >> "$CPU_FIXTURE_RESULTS"
cat "$CPU_FIXTURE_RESULTS"
`;
  const cpu = loadCpu({ script });
  const executeTinyOnly = (command) => {
    assert.match(command, /^cat > \/tmp\/cpu-benchmark\.sh <<'__CPU_BENCH_HEREDOC_[a-z0-9]+__'\n/);
    assert.match(command, /\nBENCH_PROVIDER=local-fixture bash \/tmp\/cpu-benchmark\.sh$/);
    assert.equal(command.split('/tmp/cpu-benchmark.sh').length - 1, 2);
    // Relocate ONLY the wrapper's guest /tmp upload/launch paths. Script bytes
    // and quoted heredoc delimiter are untouched; no shared /tmp filename is used.
    const relocated = command.replaceAll('/tmp/cpu-benchmark.sh', shellQuote(scriptPath));
    const result = spawnSync('/bin/sh', ['-c', relocated], {
      cwd: dir,
      env: { PATH: process.env.PATH, CPU_FIXTURE_RESULTS: resultsPath },
      encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  try {
    const sandbox = fakeSandbox([executeTinyOnly]);
    const { timing, output: captured } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
    // The wrapper deliberately adds one separator newline before the marker.
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), script + '\n');
    assert.match(captured.stdout, new RegExp(`BENCH_META\\tfixture_hash\\t${digest}\\n`));
    assert.match(captured.stdout, new RegExp(`BENCH_META\\tfixture_multi_hash\\t${multiDigest}\\n`));
    // Tiny counts are correct for this fixture but intentionally not eligible
    // for the unchanged production workload. Do not add a production test bypass.
    assert.match(timing.error, /unexpected benchmark bytes/);
    assert.match(captured.stdout, /BENCH_BYTES\tsingle\t64\nBENCH_PHASE\tmulti\t1\nBENCH_BYTES\tmulti\t128\n/);
    assert.equal(timing.singleMs, 1);
    assert.equal(timing.multiMs, 1);
    assert.equal(timing.done, false);
    assert.equal(sandbox.calls.length, 1);

    const recoverySandbox = fakeSandbox([
      (command) => {
        const result = executeTinyOnly(command);
        // Simulate loss of stream lines only; leave the actual file intact.
        return { ...result, stdout: result.stdout.split('\n').filter(
          (line) => !line.startsWith('BENCH_PHASE\tsingle\t') && !line.startsWith('BENCH_BYTES\tsingle\t'),
        ).join('\n') };
      },
      (command) => {
        assert.equal(command, 'cat /tmp/cpu-bench-results.txt 2>/dev/null || true');
        const recovered = spawnSync('/bin/sh', ['-c',
          command.replace('/tmp/cpu-bench-results.txt', shellQuote(resultsPath)),
        ], {
          cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8',
          timeout: 3000, maxBuffer: 64 * 1024,
        });
        assert.ifError(recovered.error);
        assert.equal(recovered.status, 0, recovered.stderr);
        return { exitCode: recovered.status, stdout: recovered.stdout, stderr: recovered.stderr };
      },
    ]);
    const recovered = await cpu.runCpuBenchmark(recoverySandbox, 'local-fixture', 1000);
    assert.match(recovered.timing.error, /unexpected benchmark bytes/);
    assert.equal(recovered.timing.singleMs, 1);
    assert.equal(recoverySandbox.calls.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real generated production command is measured but never executed', async (t) => {
  const script = fs.readFileSync(scriptSourceUrl, 'utf8');
  const sandbox = fakeSandbox([{ exitCode: 0, stdout: output(), stderr: '' }]);
  await loadCpu({ script }).runCpuBenchmark(sandbox, 'local-fixture', 1000);
  const scriptBytes = Buffer.byteLength(script);
  const commandBytes = Buffer.byteLength(sandbox.calls[0].command);
  assert.ok(scriptBytes < 4000, `script target exceeded: ${scriptBytes}`);
  assert.ok(commandBytes > scriptBytes, 'wrapper must count toward command size');
  t.diagnostic(JSON.stringify({
    scriptBytes, generatedCommandBytes: commandBytes,
    providerName: 'local-fixture',
    note: 'Measured local generated command only; adapter/native envelopes and provider caps are not verified.',
  }));
});
