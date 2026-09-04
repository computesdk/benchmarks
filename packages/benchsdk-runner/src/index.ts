// High-level authoring DSL
export { defineBenchmarkConfig, defineTask, TaskError, BenchmarkConfigError, validateBenchmarkConfig } from './bench-config.js';
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
  BenchmarkConfigErrorItem,
} from './bench-config.js';

// Operator / runner entrypoints
export { NoAvailableParticipantsError } from './no-available-participants.js';
export { runBenchmark, runBenchmarkWorker, parseCliArgs, mergeConfig } from './runner.js';
export type { CliArgs, RunBenchmarkWorkerOptions, RunBenchmarkOptions, PlatformConfig } from './runner.js';
export { defineOnComplete } from './bench-config.js';
export { run, runBenchmarkFile } from './cli.js';
export type { BenchSdkConfig } from './cli.js';

// Scoring
export { score, lowerIsBetter, higherIsBetter, validateScoringSpec, ScoringSpecError, scoringConfigToSpec } from './scoring.js';
export type { ScoringSpec, MetricScoring, BenchmarkScoreResult, BenchmarkScoringConfig, BenchmarkScoringMetric, BenchmarkScoringSuccess, BenchmarkScoringWeights } from './scoring.js';

// Re-export low-level worker and API primitives so `@benchsdk/runner` is the
// single package operators need. `@benchsdk/client` re-exports these for
// backwards compatibility.
export {
  runWorker,
  BenchmarkReporter,
  claimBenchmarkReporter,
  createSystemMetricsCollector,
  filterParticipantsByEnv,
  selectParticipants,
} from '@benchsdk/worker';
export type {
  BaseParticipant,
  BenchmarkReporterArtifactInput,
  BenchmarkReporterBarrierInput,
  BenchmarkReporterBarrierResult,
  BenchmarkReporterConfig,
  BenchmarkReporterHeartbeatInput,
  BenchmarkReporterProgress,
  BenchmarkSystemMetricsCollector,
  BenchmarkSystemMetricsSample,
} from '@benchsdk/worker';

export { BenchmarkApiError, createBenchmarkClient } from '@benchsdk/api';
export type { BenchmarkClient, BenchmarkClientConfig } from '@benchsdk/api';
export type {
  BenchmarkArtifactDownload,
  BenchmarkAssignment,
  BenchmarkArtifact,
  BenchmarkConcurrencyPoint,
  BenchmarkLogLevel,
  BenchmarkLogOptions,
  BenchmarkStepOutcome,
  BenchmarkAnalyticsReadiness,
  BenchmarkEventRateBucket,
  BenchmarkFailurePoint,
  BenchmarkParticipant,
  BenchmarkResource,
  BenchmarkResultLatencySummary,
  BenchmarkResultsOverview,
  BenchmarkResultsOverviewAnalytics,
  BenchmarkResultsOverviewInput,
  BenchmarkResultsOverviewRun,
  BenchmarkResultSummary,
  BenchmarkRun,
  BenchmarkRunImports,
  BenchmarkRunAnalyticsSummary,
  BenchmarkRunImportsSummary,
  BenchmarkRunImportItem,
  BenchmarkRunResults,
  BenchmarkRunStatus,
  BenchmarkRunSummaryInput,
  BenchmarkRunSummaryMetric,
  BenchmarkRunSummaryResult,
  BenchmarkRunSummaryRunMetadata,
  BenchmarkRunSummaryScalar,
  BenchmarkRunTaskResults,
  BenchmarkRunTaskResultsInput,
  BenchmarkRunTimeline,
  BenchmarkRunTimelineInput,
  BenchmarkRunWorker,
  BenchmarkStepResultSummary,
  BenchmarkTaskBucket,
  BenchmarkWorkerAttempt,
  BenchmarkWorkerStatus,
  ClaimWorkerInput,
  CreateWorkerArtifactInput,
  CreateWorkerArtifactResponse,
  CreateRunInput,
  DefineStepOptions,
  JsonObject,
  JsonValue,
  PlanWorkersInput,
  RunProgress,
  RunProgressConcurrency,
  RunProgressParticipant,
  RunProgressParticipantCounts,
  RunProgressStatus,
  RunProgressSummary,
  RunProgressTaskCounts,
  RunProgressWorkerCounts,
  RunWorkerContext,
  RunWorkerOptions,
  RunWorkerResult,
  SendTaskResultsInput,
  TaskStepRecord,
  TaskResultRecord,
  TaskResultsResponse,
  TaskFunction,
  UpdateBenchmarkInput,
  UpdateParticipantInput,
  UpdateRunInput,
  UpdateWorkerInput,
  UpsertBenchmarkInput,
  UpsertParticipantInput,
  UploadWorkerArtifactInput,
  WorkerConcurrencySample,
  WorkerFinishContext,
  WorkerHeartbeatInput,
} from '@benchsdk/api';
