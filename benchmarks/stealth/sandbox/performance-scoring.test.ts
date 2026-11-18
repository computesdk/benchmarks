import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERFORMANCE_CANDIDATE_VERSION,
  PERFORMANCE_PROFILES,
  performanceFsApiRankScore,
  scorePerformanceCandidate,
  type PerformanceBenchmarkId,
  type PerformanceMetricSummary,
} from './performance-scoring.js';

// Failure modes: cap/floor ties, wrong percentile direction, missing samples
// becoming perfect zero latency, nonfinite inputs, dropped completion gates,
// rounding before ranking, and a peer affecting an absolute calibration.
// All fixtures are synthetic. No benchmark imports, credentials or providers.
const stats = (value: number): PerformanceMetricSummary => ({ median: value, p95: value, p99: value });
const score = (id: PerformanceBenchmarkId, metrics: Record<string, PerformanceMetricSummary>, successRate = 1) =>
  scorePerformanceCandidate(id, { metrics, successRate });

test('all candidate profiles are explicit, independent and preserve weight totals', () => {
  assert.equal(Object.keys(PERFORMANCE_PROFILES).length, 6);
  for (const id of Object.keys(PERFORMANCE_PROFILES) as PerformanceBenchmarkId[]) {
    const profile = PERFORMANCE_PROFILES[id];
    assert.equal(profile.activation, 'review-only');
    const sum = profile.metrics.reduce((sum, m) => sum + m.weights.median + m.weights.p95 + m.weights.p99, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12);
  }
});

test('OCI latency remains discriminating above the former 6000 ms floor', () => {
  const a = score('oci-tti-stealth', { ttiMs: stats(12_000) });
  const b = score('oci-tti-stealth', { ttiMs: stats(24_000) });
  assert.equal(a.state, 'scored');
  assert.equal(a.methodology, PERFORMANCE_CANDIDATE_VERSION);
  assert.ok(a.compositeScore! > b.compositeScore! && b.compositeScore! > 0);
  assert.equal(score('oci-tti-stealth', { ttiMs: stats(6000) }).compositeScore, 50);
});

test('tail latency remains a penalty and curves act on the raw median', () => {
  const base = score('oci-tti-stealth', { ttiMs: stats(6000) }).compositeScore!;
  const badTail = score('oci-tti-stealth', { ttiMs: { median: 6000, p95: 12_000, p99: 24_000 } }).compositeScore!;
  const expected = 0.6 * 50 + 0.25 * (100 / 3) + 0.15 * 20;
  assert.ok(Math.abs(badTail - expected) < 1e-12);
  assert.ok(badTail < base);
  // The median of raw [0, 12000] is 6000; averaging transformed scores
  // would incorrectly yield (100 + 100/3)/2 instead of 50.
  assert.equal(base, 50);
});

test('CPU throughput distinguishes values above 2000 and below the former 50 floor', () => {
  const cpu = (x: number) => score('sandbox-cpu-stealth', {
    singleCoreMBps: stats(x), multiCorePerVcpuMBps: stats(x),
  }).compositeScore!;
  assert.ok(cpu(4000) < cpu(8000));
  assert.ok(cpu(10) > 0 && cpu(20) > cpu(10));
  assert.equal(cpu(2000), 50);
  // Preserve the existing upper throughput percentile direction explicitly.
  const upper = score('sandbox-cpu-stealth', {
    singleCoreMBps: { median: 2000, p95: 4000, p99: 8000 },
    multiCorePerVcpuMBps: { median: 2000, p95: 4000, p99: 8000 },
  }).compositeScore!;
  assert.ok(upper > cpu(2000));
});

test('CPU burst preserves delivery and retains differences beyond 8x', () => {
  const burst = (x: number) => score('sandbox-cpu-burst-stealth', { burstHeadroom: stats(x) }).compositeScore!;
  assert.equal(burst(0), 0);
  assert.equal(burst(0.5), 30);
  assert.equal(burst(1), 60);
  assert.equal(burst(8), 80);
  assert.ok(burst(1.01) > 60);
  assert.ok(burst(16) > burst(8) && burst(16) < 100);
  assert.ok(burst(0.999) < burst(1));
});

test('filesystem API preserves completion tiers and uncapped complete-sweep speed', () => {
  const partial = performanceFsApiRankScore(4, 5);
  const slowComplete = performanceFsApiRankScore(5, 5, 60_000, 6000);
  const fastComplete = performanceFsApiRankScore(5, 5, 600, 6000);
  const fasterComplete = performanceFsApiRankScore(5, 5, 300, 6000);
  assert.equal(partial, 80);
  assert.ok(slowComplete! > 100 && slowComplete! > partial!);
  assert.ok(fasterComplete! > fastComplete! && fasterComplete! < 200);
  assert.equal(performanceFsApiRankScore(2, 5, 1, 6000), performanceFsApiRankScore(2, 5, 10000, 6000));
  assert.equal(performanceFsApiRankScore(5, 5), undefined);
  assert.equal(performanceFsApiRankScore(5, 5, NaN, 6000), undefined);
  assert.equal(performanceFsApiRankScore(5, 5, -1, 6000), undefined);
  assert.equal(performanceFsApiRankScore(6, 5, 1, 6000), undefined);
  assert.equal(performanceFsApiRankScore(5, 5, 0, 6000), 200);
  const result = score('sandbox-fs-api-stealth', { performanceRankScoreV2: stats(fastComplete!) });
  assert.ok(Math.abs(result.compositeScore! - fastComplete! / 2) < 1e-12);
  assert.equal(score('sandbox-fs-api-stealth', { rankScore: stats(200) }).state, 'insufficient');
});

test('filesystem IO retains slow differences while success still gates the score', () => {
  const io = (x: number, successRate = 1) => score('sandbox-fs-io-stealth', { totalMs: stats(x) }, successRate).compositeScore!;
  assert.ok(io(16_000) > io(32_000) && io(32_000) > 0);
  assert.equal(io(8000, 0.5), io(8000) * 0.5);
  assert.equal(io(1, 0), 0);
});

test('rootfs keeps every existing weight and discriminates above throughput ceilings', () => {
  const metrics = { createMs: stats(4000), destroyMs: stats(3000), seqWriteMBps: stats(500), seqReadMBps: stats(1000), smallFileOpsPerSec: stats(500) };
  assert.equal(score('sandbox-rootfs-stealth', metrics).compositeScore, 50);
  const faster = { ...metrics, seqWriteMBps: stats(2000), seqReadMBps: stats(4000), smallFileOpsPerSec: stats(2000) };
  assert.ok(score('sandbox-rootfs-stealth', faster).compositeScore! > 50);
  const noWrite = score('sandbox-rootfs-stealth', { ...metrics, seqWriteMBps: stats(0) });
  assert.ok(Math.abs(noWrite.compositeScore! - 35) < 1e-12);
});

test('failed, unsupported, missing and measured zero remain distinct', () => {
  const missing = scorePerformanceCandidate('oci-tti-stealth', { metrics: {}, successRate: null });
  const failed = score('oci-tti-stealth', {}, 0);
  const unsupported = scorePerformanceCandidate('oci-tti-stealth', { metrics: {}, successRate: 0, availability: 'unsupported' });
  const zero = score('oci-tti-stealth', { ttiMs: stats(0) });
  assert.equal(missing.state, 'missing');
  assert.equal(missing.compositeScore, null);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.compositeScore, 0);
  assert.equal(unsupported.state, 'unsupported');
  assert.equal(unsupported.compositeScore, 0);
  assert.equal(zero.state, 'scored');
  assert.equal(zero.compositeScore, 100);
  assert.equal(score('oci-tti-stealth', {}).state, 'insufficient');
  assert.equal(score('oci-tti-stealth', { ttiMs: stats(-1) }).state, 'insufficient');
  assert.equal(score('oci-tti-stealth', { ttiMs: stats(Infinity) }).state, 'insufficient');
  assert.throws(() => score('oci-tti-stealth', {}, NaN), /successRate/);
  assert.throws(() => score('oci-tti-stealth', {}, 1.01), /successRate/);
  assert.throws(() => scorePerformanceCandidate('oci-tti-stealth', { metrics: {}, successRate: 1, availability: 'unsupported' }), /unsupported/);
});

test('missing required metrics never redistribute their weight; unused percentiles may be absent', () => {
  assert.equal(score('sandbox-cpu-stealth', { singleCoreMBps: stats(2000) }).state, 'insufficient');
  const burst = scorePerformanceCandidate('sandbox-cpu-burst-stealth', { metrics: { burstHeadroom: { median: 1 } }, successRate: 1 });
  assert.equal(burst.compositeScore, 60);
  const noMedian = scorePerformanceCandidate('sandbox-cpu-burst-stealth', { metrics: { burstHeadroom: { p95: 1 } }, successRate: 1 });
  assert.equal(noMedian.state, 'insufficient');
});

test('precision and ties come only from measured inputs, independently of peers', () => {
  const input = { ttiMs: stats(6000) };
  const original = score('oci-tti-stealth', input);
  score('oci-tti-stealth', { ttiMs: stats(1) });
  assert.deepEqual(score('oci-tti-stealth', input), original);
  assert.ok(score('oci-tti-stealth', { ttiMs: stats(6000.001) }).compositeScore! < original.compositeScore!);
  assert.equal(score('oci-tti-stealth', { ttiMs: stats(6000) }).compositeScore, original.compositeScore);
});
