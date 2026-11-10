import { describe, expect, it } from 'vitest';
import { score, scoringConfigToSpec, ScoringSpecError, type BenchmarkScoringConfig, type ScoringSpec } from '../scoring';
import type { BenchmarkRunOutcome } from '../bench-config';
import type { TaskResultRecord } from '@benchsdk/api';
import fixtures from './fixtures/continuous-scoring.json';

const config = (): BenchmarkScoringConfig => ({
  precision: 'full',
  metrics: [{ key: 'x', ceiling: 100, weights: { median: 1, p95: 0, p99: 0 }, transform: { kind: 'reciprocal', reference: 10 } }],
});
const outcome = (records: TaskResultRecord[]) => ({ participants: [{ participant: 'fixture', records }] }) as unknown as BenchmarkRunOutcome;
const record = (data: Record<string, number | boolean>, status = 'success'): TaskResultRecord => ({ taskIndex: 0, status, data });
const run = (cfg: BenchmarkScoringConfig, records: TaskResultRecord[]) => score(outcome(records), scoringConfigToSpec(cfg));

describe('continuous scoring real runner path', () => {
  it('preserves per-metric floating-point addition order at full precision', () => {
    const cfg = config();
    cfg.metrics[0].weights.median = .1;
    cfg.metrics.push({ key: 'y', ceiling: 100, transform: { kind: 'reciprocal', reference: 20 }, weights: { median: .6, p95: .2, p99: .1 } });
    expect(run(cfg, [record({ x: 1, y: 50 })])[0].compositeScore).toBe(34.80519480519481);
  });

  it('fails closed if new full-precision math produces a nonfinite final score', () => {
    const cfg = config();
    delete cfg.metrics[0].transform;
    cfg.metrics[0].ceiling = 0;
    expect(() => run(cfg, [record({ x: 0 })])).toThrow(ScoringSpecError);
  });
  it.each(fixtures)('$id matches fixed platform statistics and arithmetic', f => {
    const cfg = config();
    cfg.metrics[0] = { ...cfg.metrics[0], ...f, key: 'x', transform: { kind: 'reciprocal', reference: f.reference } };
    const result = run(cfg, f.values.map(x => record({ x })))[0];
    expect(result.metrics[0]).toMatchObject(f.stats);
    expect(result.compositeScore).toBeCloseTo(f.expected, 12);
    expect(scoringConfigToSpec(cfg).precision).toBe('full');
    expect(scoringConfigToSpec(cfg).metrics[0].transform).toEqual(cfg.metrics[0].transform);
  });

  it('keeps absent flags linear and rounded; full alone removes rounding; transform alone still rounds', () => {
    const cfg = config();
    delete cfg.precision;
    delete cfg.metrics[0].transform;
    expect(run(cfg, [record({ x: 12.3456 })])[0].compositeScore).toBe(87.65);
    cfg.precision = 'full';
    expect(run(cfg, [record({ x: 12.3456 })])[0].compositeScore).toBeCloseTo(87.6544, 12);
    delete cfg.precision;
    cfg.metrics[0].transform = { kind: 'reciprocal', reference: 10 };
    expect(run(cfg, [record({ x: 12.3456 })])[0].compositeScore).toBe(44.75);
  });

  it('keeps completed samples, success gates, error exclusion, and groups unchanged', () => {
    const cfg = config();
    cfg.groupBy = 'group';
    cfg.success = { requireData: { verified: true } };
    const results = run(cfg, [
      record({ x: 10, group: 1, verified: true }),
      record({ x: 30, group: 1, verified: false }),
      record({ x: 1000, group: 1 }, 'error'),
    ]);
    for (const result of results) {
      expect(result.successRate).toBe(1 / 3);
      expect(result.metrics[0].median).toBe(20);
      expect(result.compositeScore).toBeCloseTo(100 / 3 / 3, 12);
    }
    expect(results.map(r => r.dimensions)).toEqual([{}, { group: 1 }]);
  });

  it.each([undefined, NaN, Infinity, -1])('rejects absent/nonfinite/negative required statistics: %s', x => {
    const records = [record(x === undefined ? {} : { x })];
    expect(() => run(config(), records)).toThrow(ScoringSpecError);
  });

  it('rejects a missing weighted metric instead of redistributing its weight', () => {
    const cfg = config();
    cfg.metrics[0].weights.median = .5;
    cfg.metrics.push({ key: 'missing', ceiling: 100, weights: { median: .5, p95: 0, p99: 0 } });
    expect(() => run(cfg, [record({ x: 10 })])).toThrow(ScoringSpecError);
  });

  it('keeps all-failed as observed zero and no records skipped, even with missing samples', () => {
    expect(run(config(), [record({}, 'error')])[0]).toMatchObject({ compositeScore: 0, successRate: 0, skipped: false });
    expect(run(config(), [])[0]).toMatchObject({ compositeScore: 0, skipped: true });
    const cfg = config();
    cfg.success = { requireData: { verified: true } };
    expect(run(cfg, [record({ verified: false })])[0].compositeScore).toBe(0);
  });

  it('ignores missing zero-weight diagnostics', () => {
    const cfg = config();
    cfg.metrics.push({ key: 'diagnostic', ceiling: 100, weights: { median: 0, p95: 0, p99: 0 } });
    expect(run(cfg, [record({ x: 10 })])[0].compositeScore).toBe(50);
  });

  it.each([null, {}, { kind: 'other', reference: 10 }, { kind: 'reciprocal', reference: 0 }, { kind: 'reciprocal', reference: -1 }, { kind: 'reciprocal', reference: Infinity }, { kind: 'reciprocal', reference: '10' }, { kind: 'reciprocal', reference: 10, extra: true }])('rejects invalid transform %j', transform => {
    const cfg = config();
    cfg.metrics[0].transform = transform as unknown as typeof cfg.metrics[0]['transform'];
    expect(() => run(cfg, [record({ x: 10 })])).toThrow(ScoringSpecError);
  });

  it.each([null, '', 'rounded', 2])('rejects unknown precision %j', precision => {
    const cfg = { ...config(), precision } as unknown as BenchmarkScoringConfig;
    expect(() => run(cfg, [record({ x: 10 })])).toThrow(ScoringSpecError);
  });

  it('rejects partial/nonfinite/negative weights in full scoring', () => {
    for (const weights of [{ median: 1 }, { median: NaN, p95: 0, p99: 0 }, { median: 2, p95: -1, p99: 0 }]) {
      const cfg = config();
      cfg.metrics[0].weights = weights as ScoringSpec['metrics'][number]['weights'];
      expect(() => run(cfg, [record({ x: 10 })])).toThrow(ScoringSpecError);
    }
  });
});
