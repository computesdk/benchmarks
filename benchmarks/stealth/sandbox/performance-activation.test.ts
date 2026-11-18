import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TaskResultRecord } from '@benchsdk/client';
import type { BenchmarkScoringConfig } from '@benchsdk/runner';
import { config as oci } from './oci-tti.bench.js';
import { config as cpu } from './cpu.bench.js';
import { config as burst } from './sandbox-cpu-burst.bench.js';
import { config as api } from './sandbox-fs-api.bench.js';
import { config as io } from './sandbox-fs-io.bench.js';
import { config as rootfs } from './rootfs.bench.js';
import { runtimeRecordScore } from './performance-runtime-scoring.js';
import { cpuBurstScore, SUITE_CONFIG, writeCpuBurstResultsJson } from './sandbox-cpu-burst.js';
import { recordsToCpuBurstResults } from './sandbox-cpu-burst-legacy-results.js';
import { recordsToFsIoResults } from './sandbox-fs-io-legacy-results.js';
import { recordsToSandboxFilesystemResults } from './sandbox-fs-api-legacy-results.js';
import { computeFsIoStats } from './sandbox-fs-io.js';
import { computeSandboxFilesystemStats } from './sandbox-fs-api.js';
import { performanceFsApiRankScore } from './performance-scoring.js';
import { assertPlatformParity } from './performance-platform-parity.js';

// Actual config and exporter wiring. No provider invocation or stored results.
// Failure modes: dead candidate fields, pre-stat curves, precision loss,
// dropped error records, status-free matrix evidence and divergent exporters.
const record = (data: Record<string, unknown>, status = 'success') => ({ taskIndex: 0, status, data }) as TaskResultRecord;
const fixture = (records: TaskResultRecord[]) => [{ participant: 'fixture', records }];
const points = (config: BenchmarkScoringConfig, records: TaskResultRecord[]) => runtimeRecordScore(records, config)!.compositeScore;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const configs = [oci, cpu, burst, api, io, rootfs];

test('actual performance manifests agree exactly with platform recomputation', {
  skip: !process.env.BENCHSDK_PLATFORM_SCORING_ENTRYPOINT,
}, async () => {
  for (const config of configs) {
    const scoring = config.scoring!;
    const raw = Object.fromEntries(scoring.metrics.filter(m => Object.values(m.weights).some(w => w > 0))
      .map(m => [m.key, m.ceiling / 2]));
    Object.assign(raw, scoring.success?.requireData ?? {});
    const samples = Array.from({ length: 25 }, (_, i) => record({ ...raw,
      ...Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => [key, (value as number) + i / 1000])),
      ...scoring.success?.requireData,
    }));
    await assertPlatformParity(scoring, samples);
    await assertPlatformParity(scoring, [...samples, record({}, 'error')]);
    await assertPlatformParity(scoring, [record({}, 'error')]);
    await assertPlatformParity(scoring, [record({ ...scoring.success?.requireData })]);
  }
});

test('all six actual manifests select full precision and the calibrated weighted transforms', () => {
  for (const config of configs) assert.equal((config.scoring as { precision?: string }).precision, 'full');
  for (const [config, references] of [
    [oci, { ttiMs: 6000 }], [cpu, { multiCorePerVcpuMBps: 2000, singleCoreMBps: 2000 }],
    [io, { totalMs: 8000 }], [rootfs, { createMs: 4000, seqWriteMBps: 500, seqReadMBps: 1000, smallFileOpsPerSec: 500, destroyMs: 3000 }],
  ] as const) {
    for (const [key, reference] of Object.entries(references)) {
      const metric = config.scoring!.metrics.find(m => m.key === key)!;
      assert.deepEqual((metric as typeof metric & { transform?: unknown }).transform, { kind: 'reciprocal', reference });
    }
  }
  assert.equal(burst.scoring!.metrics.find(m => m.key === 'cpuBurstScore')!.weights.median, 1);
  assert.equal(api.scoring!.metrics.find(m => m.key === 'rankScore')!.weights.p99, 1);
});

test('actual OCI score separates old floor ties and aggregates raw samples before curves', () => {
  const a = points(oci.scoring!, [record({ verified: true, ttiMs: 12000.1234 })]);
  const b = points(oci.scoring!, [record({ verified: true, ttiMs: 24000.1234 })]);
  assert.ok(a > b && b > 0);
  assert.notEqual(a, Math.round(a * 100) / 100);
  const score = points(oci.scoring!, [0, 12000].map(ttiMs => record({ verified: true, ttiMs })));
  near(score, 0.6 * 50 + 0.25 * (100 / 3) + 0.15 * (100 / 3));
  assert.equal(points(oci.scoring!, [record({ verified: false, ttiMs: 0 })]), 0);
});

test('CPU throughput remains continuous above caps and zero throughput stays zero', () => {
  const score = (value: number) => points(cpu.scoring!, [record({ done: true, multiCorePerVcpuMBps: value, singleCoreMBps: value })]);
  assert.ok(score(8000) > score(4000));
  assert.ok(score(20) > score(10) && score(10) > 0);
  assert.equal(score(0), 0);
});

test('CPU burst real unit score and legacy exporter share the runner median and reliability', async () => {
  assert.equal(cpuBurstScore(1, SUITE_CONFIG), 60);
  assert.equal(cpuBurstScore(8, SUITE_CONFIG), 80);
  assert.ok(cpuBurstScore(16, SUITE_CONFIG) > 80);
  const headroom = 8.123456789;
  const records = [record({ ok: true, suite: 'cpu-burst', metric: { value: headroom, unit: 'x', higherIsBetter: true },
    meta: {}, cpuBurstScore: cpuBurstScore(headroom, SUITE_CONFIG) }), record({}, 'error')];
  const result = recordsToCpuBurstResults(fixture(records))[0];
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[1].meta.taskStatus, 'error');
  near(result.compositeScore, points(burst.scoring!, records));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'performance-precision-'));
  try {
    const file = path.join(dir, 'fixture.json');
    await writeCpuBurstResultsJson([result], file);
    const saved = JSON.parse(await readFile(file, 'utf8')).results[0];
    assert.equal(saved.iterations[0].metric.value, headroom);
    assert.equal(saved.compositeScore, result.compositeScore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('filesystem I/O exporter and combined matrix use actual percentile weights and all statuses', () => {
  const records = [8000.123456, 16000.87654, 24000.333].map(totalMs => record({ totalMs, verified: true, provider: 'fixture' }));
  records.push(record({}, 'error'));
  const converted = recordsToFsIoResults(fixture(records), 'default')[0];
  assert.equal(converted.iterations.length, records.length);
  near(converted.compositeScore, points(io.scoring!, records));
  const split = records.map(r => recordsToFsIoResults(fixture([r]), 'default')[0].iterations);
  near(computeFsIoStats(split.flat()).compositeScore, points(io.scoring!, records));
  assert.ok(points(io.scoring!, [records[0]]) > points(io.scoring!, [records[1]]));
  assert.equal(points(io.scoring!, [record({ totalMs: 0, verified: false })]), 0);
});

test('filesystem API completion tiers and full-sweep speed are active in exporter and matrix rank', () => {
  const fast = performanceFsApiRankScore(5, 5, 1000.1234, 5000)!;
  const slow = performanceFsApiRankScore(5, 5, 2000.1234, 5000)!;
  assert.ok(fast > slow && slow > 100);
  const records = [record({ provider: 'fixture', verified: true, rankScore: slow, wallClockMs: 1 }),
    record({ provider: 'fixture', verified: true, rankScore: fast, wallClockMs: 1 }), record({}, 'error')];
  const converted = recordsToSandboxFilesystemResults(fixture(records))[0];
  assert.equal(converted.iterations.length, 3);
  near(converted.compositeScore, points(api.scoring!, records));
  near(computeSandboxFilesystemStats(converted.iterations).compositeScore, points(api.scoring!, records));
  assert.equal(points(api.scoring!, [record({ verified: false, rankScore: 200 })]), 0);
});

test('rootfs transform preserves its destruction gate and missing evidence never earns a perfect score', () => {
  const data = { createMs: 8000, seqWriteMBps: 1000, seqReadMBps: 2000, smallFileOpsPerSec: 1000, destroyMs: 6000, destroyPassed: 1 };
  const base = points(rootfs.scoring!, [record(data)]);
  assert.ok(points(rootfs.scoring!, [record({ ...data, seqWriteMBps: 2000 })]) > base);
  assert.equal(points(rootfs.scoring!, [record({ ...data, destroyPassed: 0 })]), 0);
  const missing = points(rootfs.scoring!, [record({ destroyPassed: 1 })]);
  assert.equal(missing, 0);
});
