import { describe, expect, it } from 'vitest';
import { score, validateScoringSpec, ScoringSpecError, lowerIsBetter, higherIsBetter, scoringConfigToSpec } from '../scoring';
import type { ScoringSpec } from '../scoring';
import type { BenchmarkRunOutcome } from '../bench-config';
import type { TaskResultRecord } from '@benchsdk/api';

describe('validateScoringSpec', () => {
  it('does not throw when declared weights sum to 1.0 across all metrics', () => {
    const spec: ScoringSpec = {
      metrics: [
        lowerIsBetter('uploadMs', { unit: 'ms', ceiling: 30000, weights: { median: 0.25, p95: 0.10, p99: 0.05 } }),
        lowerIsBetter('downloadMs', { unit: 'ms', ceiling: 30000, weights: { median: 0.35, p95: 0.15, p99: 0.05 } }),
        higherIsBetter('throughputMbps', { unit: 'mbps', floor: 1, ceiling: 1000, weights: { median: 0.05, p95: 0, p99: 0 } }),
      ],
    };
    expect(() => validateScoringSpec(spec)).not.toThrow();
  });

  it('does not throw for a single metric whose weights alone sum to 1.0', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 10000, weights: { median: 0.60, p95: 0.25, p99: 0.15 } })],
    };
    expect(() => validateScoringSpec(spec)).not.toThrow();
  });

  it('throws ScoringSpecError with a per-metric breakdown when weights sum to less than 1.0', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 10000, weights: { median: 0.5, p95: 0.2, p99: 0.1 } })],
    };
    expect(() => validateScoringSpec(spec)).toThrow(ScoringSpecError);
    expect(() => validateScoringSpec(spec)).toThrow('Scoring spec weights sum to 0.800, expected 1.0');
    expect(() => validateScoringSpec(spec)).toThrow('ttiMs=0.800');
  });

  it('throws when weights sum to more than 1.0', () => {
    const spec: ScoringSpec = {
      metrics: [
        lowerIsBetter('a', { unit: 'ms', ceiling: 1000, weights: { median: 0.6, p95: 0.3, p99: 0.2 } }),
        lowerIsBetter('b', { unit: 'ms', ceiling: 1000, weights: { median: 0.3, p95: 0, p99: 0 } }),
      ],
    };
    expect(() => validateScoringSpec(spec)).toThrow('Scoring spec weights sum to 1.400, expected 1.0');
  });

  it('does not throw for a boundary case just inside the tolerance', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('a', { unit: 'ms', ceiling: 1000, weights: { median: 1.009, p95: 0, p99: 0 } })],
    };
    expect(() => validateScoringSpec(spec)).not.toThrow();
  });

  it('throws for a boundary case just outside the tolerance', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('a', { unit: 'ms', ceiling: 1000, weights: { median: 1.011, p95: 0, p99: 0 } })],
    };
    expect(() => validateScoringSpec(spec)).toThrow(ScoringSpecError);
  });

  it('throws for no declared metrics (weights sum to 0)', () => {
    const spec: ScoringSpec = { metrics: [] };
    expect(() => validateScoringSpec(spec)).toThrow('(no metrics declared)');
  });
});

describe('score with groupBy', () => {
  const spec: ScoringSpec = {
    groupBy: 'file_size',
    metrics: [lowerIsBetter('uploadMs', { unit: 'ms', ceiling: 1000, weights: { median: 1, p95: 0, p99: 0 } })],
  };

  function record(taskIndex: number, status: string, data: Record<string, unknown>): TaskResultRecord {
    return { taskIndex, status, data: data as TaskResultRecord['data'] };
  }

  it('emits one row per group value', () => {
    const results = score(
      {
        participants: [
          {
            participant: 'aws-s3',
            records: [
              record(0, 'success', { file_size: '1MB', uploadMs: 100 }),
              record(1, 'success', { file_size: '4MB', uploadMs: 400 }),
            ],
          },
        ],
      } as unknown as BenchmarkRunOutcome,
      spec,
    );

    const grouped = results.filter((r) => r.dimensions?.file_size != null);
    expect(grouped.map((r) => r.dimensions.file_size)).toEqual(['1MB', '4MB']);
    expect(grouped.every((r) => r.successRate === 1)).toBe(true);
    // Run-wide aggregate across every group.
    expect(results.find((r) => r.dimensions?.file_size == null)?.successRate).toBe(1);
  });

  it('counts a failure against its own group instead of a separate row', () => {
    const results = score(
      {
        participants: [
          {
            participant: 'aws-s3',
            records: [
              record(0, 'success', { file_size: '1MB', uploadMs: 100 }),
              record(1, 'error', { file_size: '1MB' }),
            ],
          },
        ],
      } as unknown as BenchmarkRunOutcome,
      spec,
    );

    const groupRow = results.find((r) => r.dimensions?.file_size === '1MB');
    expect(groupRow).toBeDefined();
    expect(groupRow!.successRate).toBe(0.5);
    // Run-wide aggregate spans both records.
    expect(results.find((r) => r.dimensions?.file_size == null)?.successRate).toBe(0.5);
  });

  it('keeps a participant with no records as a skipped row', () => {
    const results = score(
      { participants: [{ participant: 'aws-s3', records: [] }] } as unknown as BenchmarkRunOutcome,
      spec,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provider: 'aws-s3', skipped: true, successRate: 0 });
  });
});

describe('score resolves missing metric unit from display.metrics', () => {
  function record(taskIndex: number, status: string, data: Record<string, unknown>): TaskResultRecord {
    return { taskIndex, status, data: data as TaskResultRecord['data'] };
  }

  it('fills in the unit from display.metrics when the scoring metric omits it', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('durationMs', { ceiling: 500, weights: { median: 1, p95: 0, p99: 0 } })],
    };
    const outcome = {
      participants: [
        {
          participant: 'demo',
          records: [record(0, 'success', { durationMs: 100 })],
        },
      ],
    } as unknown as BenchmarkRunOutcome;

    const results = score(outcome, spec, [{ key: 'durationMs', label: 'Duration', unit: 'ms' }]);
    expect(results[0].metrics[0]).toMatchObject({ name: 'durationMs', unit: 'ms', median: 100 });
  });

  it('prefers the unit declared in the scoring metric over display.metrics', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('durationMs', { ceiling: 500, unit: 's', weights: { median: 1, p95: 0, p99: 0 } })],
    };
    const outcome = {
      participants: [
        {
          participant: 'demo',
          records: [record(0, 'success', { durationMs: 100 })],
        },
      ],
    } as unknown as BenchmarkRunOutcome;

    const results = score(outcome, spec, [{ key: 'durationMs', label: 'Duration', unit: 'ms' }]);
    expect(results[0].metrics[0].unit).toBe('s');
  });
});

describe('scoringConfigToSpec', () => {
  it('derives unit from display.metrics when omitted in scoring.metrics', () => {
    const spec = scoringConfigToSpec(
      {
        metrics: [{ key: 'ttiMs', ceiling: 10000, weights: { median: 1, p95: 0, p99: 0 } }],
      },
      undefined,
      {
        metrics: [{ key: 'ttiMs', label: 'Time to interactive', unit: 'ms' }],
      },
    );

    expect(spec.metrics[0].name).toBe('ttiMs');
    expect(spec.metrics[0].unit).toBe('ms');
  });

  it('uses the scoring metric unit as a fallback when display.metrics is absent', () => {
    const spec = scoringConfigToSpec({
      metrics: [{ key: 'ttiMs', unit: 'ms', ceiling: 10000, weights: { median: 1, p95: 0, p99: 0 } }],
    });

    expect(spec.metrics[0].unit).toBe('ms');
  });

  it('lets display.metrics override a scoring metric unit', () => {
    const spec = scoringConfigToSpec(
      {
        metrics: [{ key: 'ttiMs', unit: 's', ceiling: 10000, weights: { median: 1, p95: 0, p99: 0 } }],
      },
      undefined,
      {
        metrics: [{ key: 'ttiMs', label: 'Time to interactive', unit: 'ms' }],
      },
    );

    expect(spec.metrics[0].unit).toBe('ms');
  });

  it('falls back to an empty unit when neither scoring nor display declares one', () => {
    const spec = scoringConfigToSpec({
      metrics: [{ key: 'ttiMs', ceiling: 10000, weights: { median: 1, p95: 0, p99: 0 } }],
    });

    expect(spec.metrics[0].unit).toBe('');
  });
});

describe('scoringConfigToSpec success rule', () => {
  const spec = scoringConfigToSpec({
    success: { requireData: { verified: true } },
    metrics: [{ key: 'forkMs', unit: 'ms', ceiling: 1000, weights: { median: 1, p95: 0, p99: 0 } }],
  });

  function record(taskIndex: number, status: string, data: Record<string, unknown>): TaskResultRecord {
    return { taskIndex, status, data: data as TaskResultRecord['data'] };
  }

  it('excludes a record whose required data field does not match', () => {
    const results = score(
      {
        participants: [
          {
            participant: 'tigris',
            records: [
              record(0, 'success', { verified: true, forkMs: 100 }),
              record(1, 'success', { verified: false, forkMs: 900 }),
            ],
          },
        ],
      } as unknown as BenchmarkRunOutcome,
      spec,
    );

    expect(results[0].successRate).toBe(0.5);
    // Only the verified record's timing is aggregated.
    expect(results[0].metrics[0].median).toBe(100);
  });

  it('counts every successful record when no success rule is declared', () => {
    const plain = scoringConfigToSpec({
      metrics: [{ key: 'forkMs', unit: 'ms', ceiling: 1000, weights: { median: 1, p95: 0, p99: 0 } }],
    });
    const results = score(
      {
        participants: [
          {
            participant: 'tigris',
            records: [
              record(0, 'success', { verified: true, forkMs: 100 }),
              record(1, 'success', { verified: false, forkMs: 900 }),
            ],
          },
        ],
      } as unknown as BenchmarkRunOutcome,
      plain,
    );

    expect(results[0].successRate).toBe(1);
    expect(results[0].metrics[0].median).toBe(500);
  });
});
