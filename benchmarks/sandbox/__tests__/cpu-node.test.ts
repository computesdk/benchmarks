import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, scoreMetric, SUITE_CONFIG } from '../cpu-node.js';
import type { CpuNodeWorkloadResult } from '../cpu-node.js';

describe('scoring: cpu-node', () => {
  test('scoreMetric clamps to [0, 100]', () => {
    const suite = SUITE_CONFIG;
    assert.equal(scoreMetric(0, suite), 0); // guard: value <= 0 returns 0
    assert.equal(scoreMetric(suite.ceiling, suite), 0);
    assert.equal(scoreMetric(suite.ceiling * 2, suite), 0);
  });

  test('computeStats returns zeros for empty results', () => {
    const stats = computeStats([], SUITE_CONFIG);
    assert.equal(stats.n, 0);
    assert.equal(stats.compositeScore, 0);
  });

  test('computeStats handles all-failure iterations', () => {
    const results: CpuNodeWorkloadResult[] = [
      { ok: false, suite: 'cpu-node', reason: 'error', error: 'test', meta: {} },
      { ok: false, suite: 'cpu-node', reason: 'timeout', error: 'test', meta: {} },
    ];
    const stats = computeStats(results, SUITE_CONFIG);
    assert.equal(stats.n, 0);
    assert.equal(stats.successRate, 0);
  });

  test('computeStats produces median and score for successful runs', () => {
    const suite = SUITE_CONFIG;
    const val = suite.ceiling * 0.5;
    const results: CpuNodeWorkloadResult[] = [
      { ok: true, suite: 'cpu-node', metric: { value: val, unit: suite.unit, higherIsBetter: suite.higherIsBetter }, meta: {} },
      { ok: true, suite: 'cpu-node', metric: { value: val, unit: suite.unit, higherIsBetter: suite.higherIsBetter }, meta: {} },
      { ok: true, suite: 'cpu-node', metric: { value: val, unit: suite.unit, higherIsBetter: suite.higherIsBetter }, meta: {} },
    ];
    const stats = computeStats(results, suite);
    assert.equal(stats.n, 3);
    assert.equal(stats.median, val);
    assert.equal(stats.successRate, 1);
  });
});
