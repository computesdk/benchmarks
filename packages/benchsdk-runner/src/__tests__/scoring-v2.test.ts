import { describe, expect, it } from 'vitest';
import { score, scoringConfigToSpec, type BenchmarkScoringConfig } from '../scoring.js';

const config: BenchmarkScoringConfig = {
  version: 2, methodology: 'fixture-reference-100-v1', success: { requireData: { verified: true } },
  metrics: [{ key: 'time', ceiling: 100, transform: { kind: 'reciprocal', reference: 100 }, weights: { median: 0.6, p95: 0.25, p99: 0.15 }, trim: 0 }],
};
function evaluate(data: unknown[], spec = config) {
  return score({ participants: [{ participant: 'fixture', records: data.map((d, taskIndex) => ({ status: 'success', taskIndex, data: d })) }] } as never, scoringConfigToSpec(spec))[0];
}
describe('versioned continuous scoring', () => {
  it('aggregates raw percentiles before transforming and preserves full precision', () => {
    const row = evaluate([100, 200, 400, 800].map(time => ({ time, verified: true })));
    expect(row.compositeScore).toBeCloseTo(0.6 * 25 + 0.4 * 100 / 9, 12);
    expect(row.metrics[0].median).toBe(300);
    expect(row.scoringVersion).toBe(config.methodology);
    expect(evaluate([{ time: 200, verified: true }]).compositeScore).toBeGreaterThan(evaluate([{ time: 201, verified: true }]).compositeScore!);
  });
  it('does not admit unverified fast failures or discard missing required evidence', () => {
    expect(evaluate([{ time: 100, verified: true }, { time: 0, verified: false }]).compositeScore).toBe(25);
    expect(evaluate([{ verified: true }]).compositeScore).toBeNull();
    expect(evaluate([{ time: 100, verified: true }, { verified: true }]).compositeScore).toBeNull();
    expect(evaluate([{ time: -1, verified: true }]).compositeScore).toBeNull();
    expect(evaluate([{ time: Infinity, verified: true }]).compositeScore).toBeNull();
    expect(evaluate([]).compositeScore).toBeNull();
    expect(evaluate([{ time: 0, verified: false }]).compositeScore).toBe(0);
    expect(evaluate([{ time: 0, verified: true }]).compositeScore).toBe(100);
  });
  it('preserves legacy capped and rounded output and rejects unknown contracts', () => {
    const legacy = { metrics: [{ key: 'time', ceiling: 100, weights: { median: 1, p95: 0, p99: 0 } }] };
    expect(evaluate([{ time: 200 }], legacy).compositeScore).toBe(0);
    for (const invalid of [ { ...config, version: 3 }, { ...config, methodology: '' }, { ...config, version: undefined }, { ...config, metrics: [{ ...config.metrics[0], transform: { kind: 'unknown', reference: 100 } }] } ]) {
      expect(() => evaluate([], invalid as never)).toThrow();
    }
  });
  it('rejects ambiguous v2 metric contracts', () => {
    for (const patch of [
      { higherIsBetter: 'yes' },
      { weights: { median: 1, p95: 0, p99: 0, unknown: 1 } },
      { transform: { kind: 'reciprocal', reference: 100, unknown: 1 } },
    ]) expect(() => evaluate([], { ...config, metrics: [{ ...config.metrics[0], ...patch }] } as never)).toThrow();
    expect(() => evaluate([], { ...config, metrics: [config.metrics[0], { ...config.metrics[0], weights: { median: 0, p95: 0, p99: 0 } }] })).toThrow();
  });
});
