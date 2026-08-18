export { defineBenchmarkConfig, defineTask, TaskError } from './bench-config.js';
export type {
  BenchmarkConfig,
  BenchmarkTask,
  TaskContext,
  TaskResult,
  TaskStepOptions,
  Phase,
  GroupBy,
  ParticipantRecords,
  ResolvedRunConfig,
  BenchmarkRunOutcome,
  BenchmarkDisplayConfig,
  BenchmarkMetricDisplay,
  BenchmarkStepDisplay,
  BenchmarkOverviewDisplay,
} from './bench-config.js';
export { NoAvailableParticipantsError } from './no-available-participants.js';
export { runBenchmark, parseCliArgs, mergeConfig } from './runner.js';
export type { CliArgs } from './runner.js';
export { run, runBenchmarkFile } from './cli.js';
export { score, lowerIsBetter, higherIsBetter, validateScoringSpec, ScoringSpecError, scoringConfigToSpec } from './scoring.js';
export type { ScoringSpec, MetricScoring, BenchmarkScoreResult, BenchmarkScoringConfig, BenchmarkScoringMetric, BenchmarkScoringSuccess, BenchmarkScoringWeights } from './scoring.js';
