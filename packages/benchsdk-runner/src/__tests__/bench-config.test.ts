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
    expect(() => defineBenchmarkConfig({ benchmarkSlug: '', benchmarkName: 'n', participants })).toThrow(/benchmarkSlug.*is required/);
  });

  it('requires benchmarkName', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: '', participants })).toThrow(/benchmarkName.*is required/);
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
        metrics: [{ key: 'throughputMbps', label: 'Throughput', unit: 'Mbps', direction: 'higher-better' }],
        steps: [{ key: 'create', label: 'Create sandbox' }],
        overview: { defaultMetric: 'throughputMbps', defaultLayout: 'ranking' },
      },
    });
    expect(config.display?.overview?.defaultLayout).toBe('ranking');
    expect(config.display?.metrics?.[0].key).toBe('throughputMbps');
  });

  it('carries a byStep matrix layout and supportedPct default metric', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: {
        metrics: [{ key: 'checksPassed', label: 'Checks passed' }],
        byStep: { defaultLayout: 'matrix' },
        overview: { defaultMetric: 'supportedPct' },
      },
    });
    expect(config.display?.byStep?.defaultLayout).toBe('matrix');
    expect(config.display?.overview?.defaultMetric).toBe('supportedPct');
  });

  it('rejects an invalid byStep defaultLayout', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { byStep: { defaultLayout: 'grid' as any } },
      }),
    ).toThrow("display.byStep.defaultLayout must be 'table', 'bars', 'time', or 'matrix'");
  });

  it('rejects an unexpected byStep key', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { byStep: { columns: [] } as any },
      }),
    ).toThrow("display.byStep contains unexpected key");
  });

  it('carries byStep hidden step and metric defaults', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: { byStep: { hiddenSteps: ['create', 'destroy'], hiddenMetrics: ['cpuStealPercent'] } },
    });
    expect(config.display?.byStep?.hiddenSteps).toEqual(['create', 'destroy']);
    expect(config.display?.byStep?.hiddenMetrics).toEqual(['cpuStealPercent']);
  });

  it('rejects a non-array byStep hidden list', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { byStep: { hiddenSteps: 'create' as any } },
      }),
    ).toThrow('display.byStep.hiddenSteps must be an array');
  });

  it('rejects a non-string entry in a byStep hidden list', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { byStep: { hiddenMetrics: ['x', 1 as any] } },
      }),
    ).toThrow('display.byStep.hiddenMetrics[1]');
  });

  it('rejects a non-string display metric unit', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { metrics: [{ key: 'x', label: 'X', unit: 123 as any }] },
      }),
    ).toThrow('display.metrics[0].unit must be a string');
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

  it('accepts compositeScore as a default metric when scoring is declared', () => {
    const composite = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: {
        metrics: [{ key: 'x', label: 'X' }],
        overview: { defaultMetric: 'compositeScore' },
      },
      scoring: {
        metrics: [{ key: 'x', ceiling: 100, weights: { median: 1, p95: 0, p99: 0 } }],
      },
    });
    expect(composite.display?.overview?.defaultMetric).toBe('compositeScore');
  });

  it('accepts task as a default metric without declaring it', () => {
    const task = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      display: {
        metrics: [{ key: 'x', label: 'X' }],
        overview: { defaultMetric: 'task' },
      },
    });
    expect(task.display?.overview?.defaultMetric).toBe('task');
  });

  it('rejects compositeScore as a default metric without scoring or onScore', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: {
          metrics: [{ key: 'x', label: 'X' }],
          overview: { defaultMetric: 'compositeScore' },
        },
      }),
    ).toThrow("compositeScore");
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

  it('rejects unknown keys in display', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { extra: 'value' } as any,
      }),
    ).toThrow("display contains unexpected key: 'extra'");
  });

  it('rejects unknown keys in display.metrics', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { metrics: [{ key: 'x', label: 'X', extra: 1 }] as any },
      }),
    ).toThrow("display.metrics[0] contains unexpected key: 'extra'");
  });

  it('rejects unknown keys in display.steps', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { steps: [{ key: 'x', label: 'X', extra: 1 }] as any },
      }),
    ).toThrow("display.steps[0] contains unexpected key: 'extra'");
  });

  it('rejects unknown keys in display.overview', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        display: { overview: { defaultMetric: 'x', extra: true } as any },
      }),
    ).toThrow("display.overview contains unexpected key: 'extra'");
  });

  it('carries a valid index type declaration', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      type: 'index',
      index: {
        layout: 'matrix',
        spec: { cell: { unit: 'score', decimals: 2, direction: 'higher-better' }, highlight: 'best-in-row' },
      },
    });
    expect(config.type).toBe('index');
    expect(config.index?.layout).toBe('matrix');
  });

  it('accepts standard type without a config block', () => {
    const config = defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, type: 'standard' });
    expect(config.type).toBe('standard');
  });

  it('rejects an unknown type', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, type: 'histogram' as any }),
    ).toThrow(/type.*must be 'standard', 'index', or 'reliability'/);
  });

  it("rejects an index block without type: 'index'", () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        index: { layout: 'matrix' },
      }),
    ).toThrow(/index.*requires type: 'index'/);
  });

  it("rejects an index block paired with a non-index type", () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        type: 'standard',
        index: { layout: 'matrix' },
      }),
    ).toThrow(/index.*requires type: 'index'/);
  });

  it("rejects type: 'index' without an index block", () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, type: 'index' }),
    ).toThrow(/index.*is required when type is 'index'/);
  });

  it('rejects a non-object index block', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, type: 'index', index: 'matrix' as any }),
    ).toThrow('index must be an object');
  });

  it('rejects an index block without a layout', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, type: 'index', index: {} as any }),
    ).toThrow('index.layout');
  });

  it('rejects an unknown index layout', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, type: 'index', index: { layout: 'grid' } }),
    ).toThrow('index.layout must be one of: model-matrix, matrix');
  });

  it('rejects a non-object index spec', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        type: 'index',
        index: { layout: 'matrix', spec: 'x' as any },
      }),
    ).toThrow('index.spec must be a plain object');
  });

  it('rejects unknown keys in the index block', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        type: 'index',
        index: { layout: 'matrix', extra: true } as any,
      }),
    ).toThrow("index contains unexpected key: 'extra'");
  });
});

describe('reliability config', () => {
  const reliable = (reliability: unknown) =>
    defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      type: 'reliability',
      reliability: reliability as any,
    });

  it('carries a valid reliability declaration', () => {
    const config = reliable({
      interval: '1m',
      graceMs: 120_000,
      degradedWhen: { data: { placementFallback: true } },
      target: { uptime: 0.999 },
      layout: 'series',
      sections: [
        { type: 'uptime', windows: ['24h', '7d'] },
        { type: 'slot-grid' },
        { type: 'metric', metric: 'latency', stats: ['p50', 'p95'] },
        { type: 'breakdown', by: 'provider', label: 'By provider' },
        { type: 'incidents', outcomes: ['failed', 'missed'] },
      ],
      feedCard: { strip: '24h', stat: 'uptime' },
    });
    expect(config.type).toBe('reliability');
    expect(config.reliability?.interval).toBe('1m');
  });

  it('carries a minimal reliability declaration (interval only)', () => {
    const config = reliable({ interval: '30s' });
    expect(config.reliability?.interval).toBe('30s');
  });

  it("rejects a reliability block without type: 'reliability'", () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        reliability: { interval: '1m' },
      }),
    ).toThrow(/reliability.*requires type: 'reliability'/);
  });

  it("rejects a reliability block paired with a non-reliability type", () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        type: 'index',
        index: { layout: 'matrix' },
        reliability: { interval: '1m' },
      }),
    ).toThrow(/reliability.*requires type: 'reliability'/);
  });

  it("rejects type: 'reliability' without a reliability block", () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, type: 'reliability' }),
    ).toThrow(/reliability.*is required when type is 'reliability'/);
  });

  it('rejects a non-object reliability block', () => {
    expect(() => reliable('1m')).toThrow('reliability must be an object');
    expect(() => reliable(null)).toThrow('reliability must be an object');
    expect(() => reliable([])).toThrow('reliability must be an object');
  });

  it('requires an interval', () => {
    expect(() => reliable({})).toThrow('reliability.interval');
  });

  it.each(['1', 'abc', 'm', '5x', '-5m'])('rejects malformed interval %s', (interval) => {
    expect(() => reliable({ interval })).toThrow('reliability.interval');
  });

  it.each(['0s', '29s', '15s'])('rejects interval %s below the 30s minimum', (interval) => {
    expect(() => reliable({ interval })).toThrow(/reliability\.interval.*30s/);
  });

  it.each(['30s', '45s', '1m', '5m', '1h', '24h'])('accepts interval %s at or above the 30s minimum', (interval) => {
    const config = reliable({ interval });
    expect(config.reliability?.interval).toBe(interval);
  });

  it('rejects a non-positive or non-integer graceMs', () => {
    for (const graceMs of [0, -1, 1.5, 'x' as any]) {
      expect(() => reliable({ interval: '1m', graceMs })).toThrow('reliability.graceMs');
    }
  });

  it('rejects a degradedWhen without a data object', () => {
    expect(() => reliable({ interval: '1m', degradedWhen: {} })).toThrow('reliability.degradedWhen.data');
    expect(() => reliable({ interval: '1m', degradedWhen: 'x' })).toThrow('reliability.degradedWhen');
  });

  it('rejects non-scalar values in degradedWhen.data', () => {
    expect(() =>
      reliable({ interval: '1m', degradedWhen: { data: { nested: {} } } }),
    ).toThrow(/reliability\.degradedWhen\.data\.nested.*string, number, or boolean/);
  });

  it('accepts string, number, and boolean values in degradedWhen.data', () => {
    const config = reliable({
      interval: '1m',
      degradedWhen: { data: { fallback: true, code: 'pin_refused', attempt: 2 } },
    });
    expect(config.reliability?.degradedWhen?.data).toEqual({ fallback: true, code: 'pin_refused', attempt: 2 });
  });

  it.each([0, 1, 1.5, -0.5, '0.9' as any])('rejects out-of-range target.uptime %s', (uptime) => {
    expect(() => reliable({ interval: '1m', target: { uptime } })).toThrow(/reliability\.target\.uptime.*between 0 and 1/);
  });

  it('rejects an unknown layout', () => {
    expect(() => reliable({ interval: '1m', layout: 'grid' })).toThrow(/reliability\.layout.*series/);
  });

  it('rejects a non-array sections list', () => {
    expect(() => reliable({ interval: '1m', sections: 'uptime' })).toThrow('reliability.sections must be an array');
  });

  it('rejects an unknown section type (the runner is the strict check)', () => {
    expect(() => reliable({ interval: '1m', sections: [{ type: 'heatmap' }] })).toThrow(
      /reliability\.sections\[0\]\.type.*uptime.*slot-grid.*metric.*breakdown.*incidents/,
    );
  });

  it('rejects a section without a type', () => {
    expect(() => reliable({ interval: '1m', sections: [{}] })).toThrow('reliability.sections[0].type');
    expect(() => reliable({ interval: '1m', sections: ['uptime'] })).toThrow('reliability.sections[0]');
  });

  it('rejects unknown keys in a section', () => {
    expect(() =>
      reliable({ interval: '1m', sections: [{ type: 'uptime', windows: ['24h'], extra: 1 }] }),
    ).toThrow(/reliability\.sections\[0\].*unexpected key.*'extra'/);
  });

  it('rejects unknown windows in an uptime section', () => {
    expect(() =>
      reliable({ interval: '1m', sections: [{ type: 'uptime', windows: ['1h'] }] }),
    ).toThrow(/reliability\.sections\[0\]\.windows.*24h.*7d.*30d/);
  });

  it('requires a metric name in a metric section', () => {
    expect(() => reliable({ interval: '1m', sections: [{ type: 'metric' }] })).toThrow('reliability.sections[0].metric');
  });

  it('accepts the built-in latency metric without a display.metrics declaration', () => {
    const config = reliable({ interval: '1m', sections: [{ type: 'metric', metric: 'latency' }] });
    expect(config.reliability?.sections?.[0]).toEqual({ type: 'metric', metric: 'latency' });
  });

  it('accepts a metric section for a metric declared in display.metrics', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      participants,
      type: 'reliability',
      display: { metrics: [{ key: 'workloadMs', label: 'Workload' }] },
      reliability: { interval: '1m', sections: [{ type: 'metric', metric: 'workloadMs' }] },
    });
    expect(config.reliability?.sections?.[0]).toEqual({ type: 'metric', metric: 'workloadMs' });
  });

  it('rejects a metric section for a metric not declared in display.metrics', () => {
    expect(() =>
      defineBenchmarkConfig({
        benchmarkSlug: 's',
        benchmarkName: 'n',
        participants,
        type: 'reliability',
        display: { metrics: [{ key: 'other', label: 'Other' }] },
        reliability: { interval: '1m', sections: [{ type: 'metric', metric: 'workloadMs' }] },
      }),
    ).toThrow(/metric.*workloadMs.*not declared in display\.metrics/);
  });

  it('rejects unknown stats in a metric section', () => {
    expect(() =>
      reliable({ interval: '1m', sections: [{ type: 'metric', metric: 'latency', stats: ['p90'] }] }),
    ).toThrow(/reliability\.sections\[0\]\.stats.*p50.*p95.*p99/);
  });

  it('requires a breakdown.by name', () => {
    expect(() => reliable({ interval: '1m', sections: [{ type: 'breakdown' }] })).toThrow('reliability.sections[0].by');
  });

  it('rejects unknown outcomes in an incidents section', () => {
    expect(() =>
      reliable({ interval: '1m', sections: [{ type: 'incidents', outcomes: ['crashed'] }] }),
    ).toThrow(/reliability\.sections\[0\]\.outcomes.*failed.*missed.*degraded/);
  });

  it('rejects invalid feedCard values and keys', () => {
    expect(() => reliable({ interval: '1m', feedCard: { strip: '7d' } })).toThrow('reliability.feedCard.strip');
    expect(() => reliable({ interval: '1m', feedCard: { stat: 'uptime' } })).not.toThrow();
    expect(() => reliable({ interval: '1m', feedCard: { stat: 'checks' } })).toThrow('reliability.feedCard.stat');
    expect(() => reliable({ interval: '1m', feedCard: { extra: 1 } })).toThrow(/reliability\.feedCard.*unexpected key.*'extra'/);
  });

  it('rejects unknown keys in the reliability block', () => {
    expect(() => reliable({ interval: '1m', extra: true })).toThrow("reliability contains unexpected key: 'extra'");
  });
});

describe('malformed nested containers', () => {
  it('rejects a null or primitive phase instead of crashing', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, phases: [null as any] })).toThrow('phases[0]');
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, phases: ['x' as any] })).toThrow('phases[0]');
  });

  it('rejects a phase with a missing or non-string name', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, phases: [{ iterations: 1 } as any] })).toThrow('phases[0]');
  });

  it('rejects malformed participants without crashing', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants: [null as any] }),
    ).toThrow('participants[0]');
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants: ['x' as any] }),
    ).toThrow('participants[0]');
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants: [{ requiredEnvVars: [] } as any] }),
    ).toThrow('participants[0].name');
  });

  it('rejects a shapes value that is not a plain object', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, shapes: ['x' as any] })).toThrow('shapes');
  });

  it('rejects a malformed shape entry without crashing', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, shapes: { burst: null as any } }),
    ).toThrow("shapes['burst']");
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', participants, shapes: { burst: { slug: 'BAD' } as any } }),
    ).toThrow("shapes['burst']");
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

  it('renders a formatted toString with code, step, and timeout', () => {
    const err = new TaskError('timed out', { code: 'step_timeout', step: 'create', timeoutMs: 5000, data: { participant: 'local' } });
    const text = err.toString();
    expect(text).toContain('[TaskError (step_timeout)] timed out');
    expect(text).toContain('step: create');
    expect(text).toContain('timeoutMs: 5000');
    expect(text).toContain('"local"');
  });
});
