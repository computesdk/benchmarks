// Pre-fix commit 986f1c4 is red; the candidate must pass this unchanged contract.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeSandbox, loadCpu, output, taskContext } from './source-harness.mjs';

async function requireRejectedProtocol(stdout, stderr = '') {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([
    { exitCode: 0, stdout, stderr },
    { exitCode: 0, stdout, stderr: '' },
  ]);
  const { timing } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
  assert.ok(timing.error, 'invalid protocol must have an explicit error');
}

for (const phase of ['singleMs', 'multiMs']) {
  for (const value of ['0', '-1', 'NaN', 'Infinity', '9'.repeat(400), '10ms', '1e3', '1.5']) {
    test(`reject ${phase}=${value.length > 30 ? 'overflow' : value}`, async () => {
      await requireRejectedProtocol(output({ [phase]: value }));
    });
  }
}

for (const field of ['singleBytes', 'multiBytes']) {
  for (const value of [
    '0', '-1', 'NaN', 'Infinity', '1', '4096bytes',
    // Numeric prefixes equal the exact expected total: byte equality alone
    // after parseInt is insufficient; lexical validity needs its own coverage.
    '4294967296bytes', '4294967296.5',
  ]) {
    test(`reject wrong/malformed ${field}=${value}`, async () => {
      await requireRejectedProtocol(output({ [field]: value }));
    });
  }
}

test('reject absent logical_cpus before deriving expected multi bytes', async () => {
  await requireRejectedProtocol(output({ omit: ['nproc'] }));
});

test('derive expected multi bytes from actual valid NPROC, not a fixed two-worker constant', async () => {
  await requireRejectedProtocol(output({ nproc: '3' }));
});

for (const nproc of ['0', '-1', 'NaN', 'Infinity', '1.5', '2cores']) {
  test(`reject invalid logical_cpus=${nproc}`, async () => {
    await requireRejectedProtocol(output({ nproc }));
  });
}

test('preserve very small positive throughput at full precision', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([{ exitCode: 0, stdout: output({ singleMs: '9007199254740991', multiMs: '9007199254740991' }), stderr: '' }]);
  const { timing } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
  assert.equal(timing.error, undefined);
  assert.ok(timing.singleCoreMBps > 0 && timing.singleCoreMBps < 0.05);
});

test('DONE must be exact rather than a marker prefix', async () => {
  await requireRejectedProtocol(output({ done: 'BENCH_DONE_not_complete' }));
});

test('raw Bash arithmetic stderr must reject complete-looking output', async () => {
  await requireRejectedProtocol(output(),
    '/tmp/cpu-benchmark.sh: line 66: 0780000: value too great for base (error token is "0780000")\n');
});

test('valid file recovery must not mask original arithmetic stderr', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([
    { exitCode: 0, stdout: output({ omit: ['singleMs'] }), stderr: 'value too great for base\n' },
    { exitCode: 0, stdout: output(), stderr: '' },
  ]);
  const { timing } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
  assert.ok(timing.error, 'recovered metrics must not mask substantive arithmetic stderr');
});

test('conflicting stream/file phase records cannot silently become a valid union', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([
    { exitCode: 0, stdout: output({ singleMs: '100', omit: ['done'] }), stderr: '' },
    { exitCode: 0, stdout: output({ singleMs: '200' }), stderr: '' },
  ]);
  const { timing } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
  assert.ok(timing.error, 'conflicting measurements need an explicit failure');
});

test('anomalous adapter nonzero file-read status cannot supply successful recovery', async () => {
  // The actual cat command has `|| true`: this models an anomalous adapter
  // response, not the normal exit status of a missing guest result file.
  const cpu = loadCpu();
  const sandbox = fakeSandbox([
    { exitCode: 0, stdout: output({ omit: ['singleMs'] }), stderr: '' },
    { exitCode: 1, stdout: output(), stderr: 'fixture read failed' },
  ]);
  const { timing } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
  assert.ok(timing.error);
});

test('task must validate invalid metrics before ctx.measure', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([{ exitCode: 0, stdout: output({ singleMs: '0' }), stderr: '' }]);
  const ctx = taskContext(sandbox);
  let error;
  try { await cpu.task(ctx); } catch (caught) { error = caught; }
  assert.equal(sandbox.destroyed, 1, 'even invalid output must destroy the local sandbox');
  assert.equal(ctx.measurements.length, 0, 'invalid output must not emit measures');
  assert.ok(error, 'invalid output must reject the task');
});

test('task must reject BENCH_ERROR before emitting measures', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([{
    exitCode: 0, stdout: output(), stderr: 'BENCH_ERROR\tmulti\tworker_failed\n',
  }]);
  const ctx = taskContext(sandbox);
  let error;
  try { await cpu.task(ctx); } catch (caught) { error = caught; }
  assert.equal(sandbox.destroyed, 1);
  assert.ok(error);
  assert.equal(ctx.measurements.length, 0, 'known failed output must not emit measures');
});

test('failed task cannot attach successful scored phase steps', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([{
    exitCode: 0, stdout: output(), stderr: 'BENCH_ERROR\tmulti\tworker_failed\n',
  }]);
  const ctx = taskContext(sandbox);
  let error;
  try { await cpu.task(ctx); } catch (caught) { error = caught; }
  assert.equal(sandbox.destroyed, 1);
  assert.ok(error);
  assert.ok(!error.steps?.some((step) => step.status === 'success'), 'invalid phases must not be marked successful');
});

for (const stderr of ['BENCH_ERROR\trecovery\tfailed\n', 'value too great for base\n']) {
  test(`recovery stderr cannot mask a substantive error: ${stderr.trim()}`, async () => {
    const cpu = loadCpu();
    const sandbox = fakeSandbox([
      { exitCode: 0, stdout: output({ omit: ['singleMs'] }), stderr: '' },
      { exitCode: 0, stdout: output(), stderr },
    ]);
    const { timing } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
    assert.ok(timing.error);
    assert.equal(timing.done, false);
    assert.equal(timing.singleCoreMBps, undefined);
  });
}

test('logical_cpus record cannot hide trailing tab-separated fields', async () => {
  await requireRejectedProtocol(output({ nproc: '2\textra' }));
});

test('empty BENCH_ERROR still signals failure', async () => {
  await requireRejectedProtocol(output(), 'BENCH_ERROR\n');
});

test('conflicting duplicate records in one channel reject', async () => {
  await requireRejectedProtocol(output({ extra: 'BENCH_PHASE\tsingle\t101\n' }));
});

test('invalid stream record cannot be repaired into success by complete result file', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([
    { exitCode: 0, stdout: output({ singleMs: 'NaN' }), stderr: '' },
    { exitCode: 0, stdout: output(), stderr: '' },
  ]);
  const { timing } = await cpu.runCpuBenchmark(sandbox, 'local-fixture', 1000);
  assert.ok(timing.error);
});

test('zero-rounded scaling factor rejects before success', async () => {
  await requireRejectedProtocol(output({ singleMs: '1', multiMs: '1000000' }));
});

test('small positive per-vCPU throughput retains full precision', async () => {
  const cpu = loadCpu();
  const sandbox = fakeSandbox([{
    exitCode: 0, stdout: output({ singleMs: '30000000', multiMs: '30000000' }), stderr: '',
  }]);
  const ctx = taskContext(sandbox);
  ctx.phase = 'xlarge';
  const result = await cpu.task(ctx);
  assert.ok(result.data.multiCorePerVcpuMBps > 0 && result.data.multiCorePerVcpuMBps < 0.05);
  assert.equal(result.data.multiCorePerVcpuMBps, result.data.multiCoreMBps / 8);
  assert.equal(ctx.measurements.length, 1);
  assert.ok(result.steps.every((step) => step.status === 'success'));
  assert.equal(sandbox.destroyed, 1);
});
