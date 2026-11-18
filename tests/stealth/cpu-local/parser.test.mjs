import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeSandbox, loadCpu, output, taskContext } from './source-harness.mjs';

async function run(responses) {
  const cpu = loadCpu();
  const sandbox = fakeSandbox(responses);
  return { ...(await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000)), sandbox, cpu };
}

test('complete actual parser/run path produces both finite positive rates', async () => {
  const { timing, sandbox } = await run([{ exitCode: 0, stdout: output(), stderr: '' }]);
  assert.equal(timing.error, undefined);
  assert.equal(timing.done, true);
  assert.equal(timing.singleMs, 100);
  assert.equal(timing.multiMs, 200);
  assert.ok(Number.isFinite(timing.singleCoreMBps) && timing.singleCoreMBps > 0);
  assert.ok(Number.isFinite(timing.multiCoreMBps) && timing.multiCoreMBps > 0);
  assert.equal(sandbox.calls.length, 1, 'complete stream must not need recovery');
});

test('CRLF protocol remains valid', async () => {
  const { timing } = await run([{ exitCode: 0, stdout: output().replaceAll('\n', '\r\n'), stderr: '' }]);
  assert.equal(timing.error, undefined);
  assert.equal(timing.singleMs, 100);
});

for (const nproc of [1, 3]) {
  test(`valid ${nproc}-worker production byte totals remain accepted`, async () => {
    const { timing } = await run([{
      exitCode: 0,
      stdout: output({ nproc: String(nproc), multiBytes: String(nproc * 2048 * 1048576) }),
      stderr: '',
    }]);
    assert.equal(timing.error, undefined);
    assert.equal(timing.vcpus, nproc);
    assert.ok(Number.isFinite(timing.multiCoreMBps) && timing.multiCoreMBps > 0);
  });
}

test('genuine truncated stdout plus complete matching result file recovers', async () => {
  const { timing, sandbox } = await run([
    { exitCode: 0, stdout: output({ omit: ['singleMs', 'singleBytes'] }), stderr: '' },
    { exitCode: 0, stdout: output(), stderr: '' },
  ]);
  assert.equal(timing.error, undefined);
  assert.equal(timing.singleMs, 100);
  assert.equal(sandbox.calls[1].command, 'cat /tmp/cpu-bench-results.txt 2>/dev/null || true');
  assert.equal(sandbox.calls.length, 2);
});

test('missing logical_cpus in stream recovers from a complete matching file', async () => {
  const { timing } = await run([
    { exitCode: 0, stdout: output({ omit: ['nproc'] }), stderr: '' },
    { exitCode: 0, stdout: output(), stderr: '' },
  ]);
  assert.equal(timing.error, undefined);
  assert.equal(timing.vcpus, 2);
});

test('identical duplicate records and benign stderr remain valid', async () => {
  const { timing } = await run([{
    exitCode: 0,
    stdout: output({ extra: 'BENCH_PHASE\tsingle\t100\nBENCH_BYTES\tsingle\t4294967296\n' }),
    stderr: 'fixture informational warning\n',
  }]);
  assert.equal(timing.error, undefined);
});

test('benign recovery stderr does not invalidate matching complete records', async () => {
  const { timing } = await run([
    { exitCode: 0, stdout: output({ omit: ['singleMs'] }), stderr: '' },
    { exitCode: 0, stdout: output(), stderr: 'fixture informational warning\n' },
  ]);
  assert.equal(timing.error, undefined);
});

for (const field of ['singleMs', 'multiMs', 'singleBytes', 'multiBytes', 'done']) {
  test(`missing ${field} remains a failure after incomplete file recovery`, async () => {
    const incomplete = output({ omit: [field] });
    const { timing } = await run([
      { exitCode: 0, stdout: incomplete, stderr: '' },
      { exitCode: 0, stdout: incomplete, stderr: '' },
    ]);
    assert.ok(timing.error);
  });
}

test('thrown recovery does not convert incomplete stream into success', async () => {
  const { timing } = await run([
    { exitCode: 0, stdout: output({ omit: ['singleMs'] }), stderr: '' },
    new Error('local fixture file read failed'),
  ]);
  assert.ok(timing.error);
});

test('structured stderr error rejects complete-looking DONE and metrics', async () => {
  const { timing } = await run([{
    exitCode: 0, stdout: output(), stderr: 'BENCH_ERROR\tmulti\tworker_failed\n',
  }]);
  assert.match(timing.error, /worker_failed/);
});

test('recovery cannot erase structured error from original stderr', async () => {
  const { timing } = await run([
    { exitCode: 0, stdout: output({ omit: ['singleMs'] }), stderr: 'BENCH_ERROR\tsingle\tfailed\n' },
    { exitCode: 0, stdout: output(), stderr: '' },
  ]);
  assert.match(timing.error, /failed/);
});

test('nonzero command exit rejects complete-looking output', async () => {
  const { timing } = await run([{ exitCode: 7, stdout: output(), stderr: 'fixture failed' }]);
  assert.ok(timing.error);
});

test('valid task uses local fake sandbox, records metrics and destroys once', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([{ exitCode: 0, stdout: output(), stderr: '' }]);
  const ctx = taskContext(sandbox);
  const result = await cpu.task(ctx);
  assert.equal(ctx.measurements.length, 1);
  assert.equal(result.data.done, true);
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every((step) => step.status === 'success' && step.latencyMs > 0));
  assert.equal(sandbox.destroyed, 1);
  assert.deepEqual(ctx.stepNames, ['create', 'cpu', 'destroy']);
});

test('unsupported tier remains unsupported before any local sandbox operation', async () => {
  const cpu = loadCpu({ supported: false });
  const sandbox = fakeSandbox([]);
  const ctx = taskContext(sandbox);
  await assert.rejects(cpu.task(ctx), (error) => error.code === 'size_not_supported' && error.data.supported === false);
  assert.equal(sandbox.calls.length, 0);
  assert.equal(sandbox.destroyed, 0);
  assert.equal(ctx.measurements.length, 0);
  assert.equal(ctx.stepNames.length, 0);
});

test('valid xlarge task retains per-vCPU normalization and phase steps', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([{ exitCode: 0, stdout: output(), stderr: '' }]);
  const ctx = taskContext(sandbox);
  ctx.phase = 'xlarge';
  const result = await cpu.task(ctx);
  assert.equal(result.data.multiCorePerVcpuMBps, result.data.multiCoreMBps / 8);
  assert.equal(result.steps.length, 2);
  assert.equal(ctx.measurements.length, 1);
  assert.equal(sandbox.destroyed, 1);
});
