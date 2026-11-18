import {
  score,
  scoringConfigToSpec,
  type BenchmarkRunOutcome,
  type BenchmarkScoringConfig,
  type BenchmarkScoringMetric,
  type ParticipantRecords,
} from '@benchsdk/runner';

export type ContinuousScoringMetric = BenchmarkScoringMetric & {
  transform?: { kind: 'reciprocal'; reference: number };
};

export type ContinuousScoringConfig = Omit<BenchmarkScoringConfig, 'metrics'> & {
  precision: 'full';
  metrics: ContinuousScoringMetric[];
};

export function fullPrecisionScoring(config: BenchmarkScoringConfig): ContinuousScoringConfig {
  return { ...config, precision: 'full' };
}

export function reciprocalScoring(config: BenchmarkScoringConfig, keys?: readonly string[]): ContinuousScoringConfig {
  return {
    ...config,
    precision: 'full',
    metrics: config.metrics.map((metric) => ({
      ...metric,
      ...(metric.weights.median + metric.weights.p95 + metric.weights.p99 > 0 && (!keys || keys.includes(metric.key))
        ? { transform: { kind: 'reciprocal' as const, reference: metric.ceiling } }
        : {}),
    })),
  };
}

function outcome(participants: ParticipantRecords[]): BenchmarkRunOutcome {
  return {
    runId: 'local-scoring',
    dashboardUrl: '',
    participants,
    config: { iterations: 1, concurrency: 1, staggerDelayMs: 0, groupBy: 'participant' },
  };
}

export function assertContinuousRunner(): void {
  const config = reciprocalScoring({
    metrics: [{ key: 'latencyMs', ceiling: 3, weights: { median: 1, p95: 0, p99: 0 } }],
  });
  const spec = scoringConfigToSpec(config) as ReturnType<typeof scoringConfigToSpec> & {
    precision?: string;
    metrics: ContinuousScoringMetric[];
  };
  const fail = () => {
    throw new Error('Continuous scoring requires a compatible @benchsdk/runner release; refusing to run with ignored transform or precision fields');
  };
  if (spec.precision !== 'full' || spec.metrics[0]?.transform?.reference !== 3) fail();
  const records = [{
    taskIndex: 0,
    status: 'success' as const,
    data: { latencyMs: 2 },
    latencyMs: 2,
  }] as ParticipantRecords['records'];
  const result = score(outcome([{ participant: 'probe', records }]), spec)[0];
  if (result?.compositeScore !== 100 / (1 + 2 / 3)) fail();
}

export function scoreParticipantRecords(participants: ParticipantRecords[], config: BenchmarkScoringConfig) {
  assertContinuousRunner();
  return score(outcome(participants), scoringConfigToSpec(config));
}
