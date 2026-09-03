import { describe, expect, it } from 'vitest';
import { defineBenchmarkConfig, defineTask, TaskError } from '../bench-config';
import type { BaseParticipant } from '@benchsdk/worker';

const participants: BaseParticipant[] = [{ name: 'e2b', requiredEnvVars: [] }];

describe('defineBenchmarkConfig', () => {
  it('returns the config unchanged when valid', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      iterations: 5,
      concurrency: 1,
      staggerDelayMs: 0,
      participants,
    });
    expect(config.benchmarkSlug).toBe('sandbox-tti-local');
    expect(config.iterations).toBe(5);
  });

  it('allows the minimal shape (slug + name + participants)', () => {
    const config = defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants });
    expect(config.iterations).toBeUndefined();
  });

  it('carries an onComplete hook when provided', () => {
    const onComplete = () => {};
    const config = defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, onComplete });
    expect(config.onComplete).toBe(onComplete);
  });

  it('requires benchmarkSlug', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: '', benchmarkName: 'n', participants })).toThrow('benchmarkSlug is required');
  });

  it('requires benchmarkName', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: '', participants })).toThrow('benchmarkName is required');
  });

  it('rejects non-integer or < 1 iterations', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, iterations: 0 })).toThrow('iterations');
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, iterations: 1.5 })).toThrow('iterations');
  });

  it('rejects concurrency < 1', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, concurrency: 0 })).toThrow('concurrency');
  });

  it('rejects negative staggerDelayMs', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, staggerDelayMs: -1 })).toThrow('staggerDelayMs');
  });

  it('accepts staggerDelayMs of 0', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, staggerDelayMs: 0 })).not.toThrow();
  });

  it('accepts a valid phases array', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      phases: [{ name: 'cold', iterations: 3 }, { name: 'warm', iterations: 3 }],
    });
    expect(config.phases).toHaveLength(2);
  });

  it('rejects phases and iterations together', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, iterations: 2, phases: [{ name: 'cold', iterations: 1 }] }),
    ).toThrow('mutually exclusive');
  });

  it('rejects an empty phases array', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, phases: [] })).toThrow('non-empty');
  });

  it('rejects a phase with non-integer or < 1 iterations', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, phases: [{ name: 'cold', iterations: 0 }] })).toThrow('cold');
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, phases: [{ name: 'cold', iterations: 1.5 }] })).toThrow('cold');
  });

  it('rejects duplicate phase names', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, phases: [{ name: 'cold', iterations: 1 }, { name: 'cold', iterations: 1 }] }),
    ).toThrow('duplicate phase name');
  });

  it('accepts a valid shapes map', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      shapes: {
        burst: { slug: 'sandbox-burst-local', name: 'Burst' },
        staggered: { slug: 'sandbox-staggered-local', staggerDelayMs: 200 },
      },
    });
    expect(config.shapes?.burst.slug).toBe('sandbox-burst-local');
  });

  it('rejects a shape without a lowercase slug', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, shapes: { burst: { slug: 'Burst' } } }),
    ).toThrow('burst');
  });

  it('rejects a shape with a negative staggerDelayMs', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, shapes: { s: { slug: 'ok', staggerDelayMs: -1 } } }),
    ).toThrow('staggerDelayMs');
  });

  it('carries a display manifest when valid', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: {
        description: 'A test benchmark',
        metrics: [{ key: 'throughputMbps', label: 'Throughput', unit: 'Mbps', direction: 'higher-better' }],
        steps: [{ key: 'create', label: 'Create sandbox' }],
        overview: { defaultMetric: 'throughputMbps', defaultLayout: 'ranking' },
      },
    });
    expect(config.display?.overview?.defaultLayout).toBe('ranking');
    expect(config.display?.metrics?.[0].key).toBe('throughputMbps');
  });

  it('rejects an invalid display direction', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { metrics: [{ key: 'x', label: 'X', direction: 'up' as any }] },
      }),
    ).toThrow('direction');
  });

  it('rejects duplicate display metric keys', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: {
          metrics: [
            { key: 'x', label: 'X' },
            { key: 'x', label: 'X2' },
          ],
        },
      }),
    ).toThrow('duplicate');
  });

  it('rejects an empty or non-string display defaultMetric', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { overview: { defaultMetric: '' } },
      }),
    ).toThrow('display.overview.defaultMetric');
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { overview: { defaultMetric: 123 as any } },
      }),
    ).toThrow('display.overview.defaultMetric');
  });

  it('rejects a display defaultMetric not declared in metrics', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: {
          metrics: [{ key: 'x', label: 'X' }],
          overview: { defaultMetric: 'y' },
        },
      }),
    ).toThrow("'y' is not declared in display.metrics");
  });

  it('accepts a display defaultMetric that matches a declared metric key', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: {
        metrics: [{ key: 'x', label: 'X' }],
        overview: { defaultMetric: 'x' },
      },
    });
    expect(config.display?.overview?.defaultMetric).toBe('x');
  });

  it('accepts scoring without unit when display.metrics declares it', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: {
        metrics: [{ key: 'ttiMs', label: 'Time to interactive', unit: 'ms' }],
      },
      scoring: {
        metrics: [{ key: 'ttiMs', ceiling: 10000, weights: { median: 1, p95: 0, p99: 0 } }],
      },
    });
    expect(config.scoring?.metrics[0].unit).toBeUndefined();
  });

  it('rejects a scoring unit that conflicts with display.metrics', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: {
          metrics: [{ key: 'ttiMs', label: 'Time to interactive', unit: 'ms' }],
        },
        scoring: {
          metrics: [{ key: 'ttiMs', unit: 's', ceiling: 10000, weights: { median: 1, p95: 0, p99: 0 } }],
        },
      }),
    ).toThrow("scoring.metrics[0].unit 's' conflicts with display.metrics[0].unit 'ms'");
  });

  it('does not throw a TypeError when display.metrics is malformed', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        // @ts-expect-error intentionally malformed
        display: { metrics: 'not-an-array' },
        scoring: {
          metrics: [{ key: 'ttiMs', ceiling: 10000, weights: { median: 1, p95: 0, p99: 0 } }],
        },
      }),
    ).toThrow('display.metrics must be an array');
  });

  it('allows a display defaultMetric when metrics is omitted', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: { overview: { defaultMetric: 'anything' } },
    });
    expect(config.display?.overview?.defaultMetric).toBe('anything');
  });
});

describe('defineTask', () => {
  it('returns the task function unchanged', () => {
    const fn = async () => {};
    expect(defineTask(fn)).toBe(fn);
  });

  it('rejects a non-function', () => {
    // @ts-expect-error the array form has been removed
    expect(() => defineTask([])).toThrow('task function');
  });
});

describe('TaskError', () => {
  it('carries code, data, and steps and names itself', () => {
    const err = new TaskError('boom', { code: 'probe_failed', data: { mode: 'cold' }, steps: [{ name: 'ttft', status: 'success', latencyMs: 5 }] });
    expect(err.name).toBe('TaskError');
    expect(err.message).toBe('boom');
    expect(err.code).toBe('probe_failed');
    expect(err.data).toEqual({ mode: 'cold' });
    expect(err.steps).toEqual([{ name: 'ttft', status: 'success', latencyMs: 5 }]);
    expect(err).toBeInstanceOf(Error);
  });

  it('allows construction without options', () => {
    const err = new TaskError('boom');
    expect(err.code).toBeUndefined();
    expect(err.data).toBeUndefined();
    expect(err.steps).toBeUndefined();
  });
});
