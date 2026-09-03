export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface BenchmarkClientConfig {
  /** API base URL. Defaults to https://platform.computesdk.com/api/v1. */
  baseUrl?: string;
  /** Bearer token. Defaults to BENCHMARKS_PLATFORM_API_KEY. */
  apiKey?: string;
  /** OAuth/session token. Takes precedence over apiKey when both are set. */
  token?: string;
  /** Explicit organization slug for OAuth requests. Sent as the X-Org-Slug header. */
  orgSlug?: string;
  /** Explicit organization id for OAuth requests. Sent as the X-Organization-Id header (orgSlug takes precedence). */
  orgId?: string;
  /** Custom fetch implementation, mostly useful for tests. */
  fetch?: typeof fetch;
}

export interface BenchmarkResource {
  id: string;
  slug: string;
  name: string;
  status?: string;
  config?: JsonObject;
  defaultRunConfig?: JsonObject;
}

export type BenchmarkRunStatus = 'planned' | 'in_progress' | 'completed' | 'failed';
export type BenchmarkWorkerStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BenchmarkRun {
  id: string;
  benchmarkId: string;
  name?: string | null;
  status: BenchmarkRunStatus | string;
  /** Idempotency key: runs created with the same key (per org + benchmark) are the same run. */
  runKey?: string | null;
  totalTasks: number;
  /** The run declared no size: `totalTasks` is the sum of what its participants declare. */
  participantSized?: boolean;
  workerCount: number;
  config?: JsonObject;
  createdAt?: string;
  updatedAt?: string;
}

export interface BenchmarkParticipant {
  id: string;
  benchmarkId: string;
  runId: string;
  slug: string;
  label?: string | null;
  provider?: string | null;
  status: BenchmarkRunStatus | string;
  totalTasks: number;
  workerCount: number;
  config?: JsonObject;
}

export interface BenchmarkRunWorker {
  id: string;
  benchmarkId: string;
  runId: string;
  participantId: string;
  workerIndex: number;
  workerCount: number;
  taskIndexStart: number;
  taskIndexEnd: number;
  targetConcurrency: number;
  status: BenchmarkWorkerStatus | string;
  progressDone?: number;
  progressInFlight?: number;
  progressErrors?: number;
  progressTotal?: number;
  currentStep?: string | null;
  concurrency?: WorkerConcurrencySample[];
}

export interface BenchmarkWorkerAttempt {
  id: string;
  benchmarkId: string;
  runId: string;
  participantId: string;
  workerId: string;
  attemptNumber: number;
  status: string;
}

export interface BenchmarkAssignment {
  benchmarkId: string;
  benchmarkSlug: string;
  runId: string;
  participantId: string;
  participantSlug: string;
  provider?: string | null;
  workerId: string;
  workerIndex: number;
  workerCount: number;
  attemptId: string;
  attemptNumber: number;
  taskRange: {
    start: number;
    end: number;
    count: number;
  };
  targetConcurrency: number;
  config?: JsonObject;
}

export interface UpsertBenchmarkInput {
  name: string;
  status?: string;
  config?: JsonObject;
  defaultRunConfig?: JsonObject;
}

export interface UpdateBenchmarkInput {
  name?: string;
  status?: string;
  config?: JsonObject;
  defaultRunConfig?: JsonObject;
}

export interface CreateRunInput {
  /**
   * Idempotency key for get-or-create: sibling callers passing the same key
   * (per org + benchmark) converge on one run instead of each opening its own.
   */
  runKey?: string;
  /** Omit to open a participant-sized run: each participant declares its own size when it registers. */
  totalTasks?: number;
  workerCount?: number;
  participants?: string[];
  config?: JsonObject;
}

export interface UpdateRunInput {
  status?: BenchmarkRunStatus;
  config?: JsonObject;
}

export interface UpsertParticipantInput {
  label?: string;
  provider?: string;
  status?: string;
  totalTasks?: number;
  workerCount?: number;
  config?: JsonObject;
}

export type UpdateParticipantInput = UpsertParticipantInput;

export interface UpdateWorkerInput {
  status?: BenchmarkWorkerStatus;
  progressDone?: number;
  progressInFlight?: number;
  progressErrors?: number;
  progressTotal?: number;
}

export interface ClaimWorkerInput {
  processKind?: string;
  processKey?: string;
}

export interface PlanWorkersInput {
  workerCount?: number;
  targetConcurrency?: number;
  config?: JsonObject;
}

export interface TaskResultRecord {
  taskIndex: number;
  status: string;
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  firstCommandMs?: number | null;
  errorCode?: string | null;
  steps?: TaskStepRecord[];
  data?: JsonObject;
}

export interface TaskStepRecord {
  name: string;
  status: 'success' | 'error';
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  errorCode?: string | null;
  data?: JsonObject;
  /** Number of parallel invocations requested for this step. */
  concurrency?: number;
  /** Per-iteration timeout in milliseconds applied to this step. */
  timeoutMs?: number;
}

export interface SendTaskResultsInput {
  benchmarkSlug: string;
  runId: string;
  workerId: string;
  attemptId: string;
  sequenceNumber: number;
  isFinal: boolean;
  records: TaskResultRecord[];
}

export interface TaskResultsResponse {
  accepted?: number;
  eventBatchId?: string;
  queued?: boolean;
  eventBatch?: unknown;
  duplicate?: boolean;
  queueMessageId?: string;
}

export interface CreateWorkerArtifactInput {
  attemptId: string;
  kind: string;
  contentType?: string;
  name?: string;
  metadata?: JsonObject;
}

export interface UploadWorkerArtifactInput extends CreateWorkerArtifactInput {
  body: BodyInit;
}

export interface BenchmarkArtifact {
  id?: string;
  artifactId?: string;
  benchmarkId?: string;
  runId?: string;
  participantId?: string;
  participantSlug?: string;
  workerId?: string;
  attemptId?: string;
  kind: string;
  name?: string | null;
  contentType?: string | null;
  objectKey?: string;
  uploadUrl?: string;
  uploadUrlExpiresAt?: string;
  /** Presigned GET URL for reading an artifact, returned by single-artifact lookups. */
  downloadUrl?: string;
  downloadUrlExpiresAt?: string;
  metadata?: JsonObject;
  createdAt?: string;
}

export interface BenchmarkArtifactDownload {
  artifact: BenchmarkArtifact;
  downloadUrl: string;
  downloadUrlExpiresAt?: string;
}

export interface CreateWorkerArtifactResponse {
  artifact?: BenchmarkArtifact;
  artifactId?: string;
  uploadUrl?: string;
  uploadUrlExpiresAt?: string;
  objectKey?: string;
}

export type BenchmarkLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BenchmarkLogOptions {
  level?: BenchmarkLogLevel;
  meta?: JsonObject;
}

export interface BenchmarkStepOutcome {
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface BenchmarkResultLatencySummary {
  min: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface BenchmarkResultSummary {
  taskCount: number;
  successCount: number;
  errorCount: number;
  otherCount: number;
  latencyCount: number;
  successRate: number;
  latencyMs: BenchmarkResultLatencySummary;
  firstStartedAt: string | null;
  lastCompletedAt: string | null;
}

export interface BenchmarkParticipantResultSummary extends BenchmarkResultSummary {
  participantSlug: string;
  provider: string | null;
}

export interface BenchmarkStepResultSummary {
  participantSlug: string;
  provider: string | null;
  stepName: string;
  stepCount: number;
  successCount: number;
  errorCount: number;
  otherCount: number;
  latencyCount: number;
  successRate: number;
  latencyMs: BenchmarkResultLatencySummary;
}

export interface BenchmarkResultsOverviewInput {
  limit?: number;
  offset?: number;
}

export type BenchmarkAnalyticsReadiness = 'ready' | 'complete' | 'partial' | 'pending' | 'unavailable' | 'failed';

export interface BenchmarkRunAnalyticsSummary {
  status: BenchmarkAnalyticsReadiness;
  eventBatches: number;
  persisted: number;
  queued: number;
  failed: number;
  imports: {
    pending: number;
    importing: number;
    imported: number;
    failed: number;
    missing: number;
  };
}

export interface BenchmarkResultsOverviewAnalytics {
  status: BenchmarkAnalyticsReadiness;
  query: 'available' | 'unavailable';
  error?: string;
}

export interface BenchmarkResultsOverviewRun {
  run: BenchmarkRun;
  analytics: BenchmarkRunAnalyticsSummary;
  participants: Array<BenchmarkParticipantResultSummary & { runId: string }>;
}

export interface BenchmarkResultsOverview {
  benchmark: Pick<BenchmarkResource, 'id' | 'slug' | 'name'>;
  generatedAt: string;
  analytics: BenchmarkResultsOverviewAnalytics;
  items: BenchmarkResultsOverviewRun[];
}

export interface BenchmarkRunResults {
  benchmark: Pick<BenchmarkResource, 'id' | 'slug' | 'name'>;
  run: Pick<BenchmarkRun, 'id' | 'status' | 'totalTasks' | 'workerCount'>;
  generatedAt: string;
  overall: BenchmarkResultSummary;
  participants: BenchmarkParticipantResultSummary[];
  steps: BenchmarkStepResultSummary[];
}

export interface BenchmarkRunTaskResultsInput {
  bucketSize?: number;
  failureLimit?: number;
}

export interface BenchmarkTaskBucket {
  participantSlug: string;
  provider: string | null;
  bucketStart: number;
  bucketEnd: number;
  taskIndexMidpoint: number;
  taskCount: number;
  successCount: number;
  errorCount: number;
  latencyMs: Pick<BenchmarkResultLatencySummary, 'p50' | 'p95' | 'max'>;
}

export interface BenchmarkFailurePoint {
  participantSlug: string;
  provider: string | null;
  taskIndex: number;
  errorCode: string | null;
}

export interface BenchmarkRunTaskResults {
  run: { id: string };
  generatedAt: string;
  bucketSize: number;
  buckets: BenchmarkTaskBucket[];
  failures: BenchmarkFailurePoint[];
}

export interface BenchmarkRunTimelineInput {
  bucketMs?: number;
}

export interface BenchmarkEventRateBucket {
  participantSlug: string;
  provider: string | null;
  tMs: number;
  completed: number;
  succeeded: number;
  failed: number;
}

export interface BenchmarkConcurrencyPoint {
  participantSlug: string;
  provider: string | null;
  workerId: string;
  recordedAt: string;
  tMs: number;
  step: string;
  active: number;
  target: number;
}

export interface BenchmarkRunTimeline {
  run: { id: string };
  generatedAt: string;
  eventRate: {
    bucketMs: number;
    buckets: BenchmarkEventRateBucket[];
  };
  concurrency: {
    firstRecordedAt: string | null;
    heartbeatCount: number;
    points: BenchmarkConcurrencyPoint[];
  };
}

export interface BenchmarkRunImportsSummary {
  eventBatches: number;
  persisted: number;
  queued: number;
  failed: number;
  imports: {
    pending: number;
    importing: number;
    imported: number;
    failed: number;
    missing: number;
  };
}

export interface BenchmarkRunImportItem {
  eventBatchId: string;
  batchType: string;
  sequenceNumber: number;
  batchStatus: string;
  eventCount: number;
  objectKey: string | null;
  batchErrorMessage: string | null;
  createdAt: string;
  persistedAt: string | null;
  sink: string | null;
  importStatus: string | null;
  importAttempts: number | null;
  importedAt: string | null;
  failedAt: string | null;
  importErrorMessage: string | null;
}

export interface BenchmarkRunImports {
  run: { id: string };
  generatedAt: string;
  summary: BenchmarkRunImportsSummary;
  items: BenchmarkRunImportItem[];
}

export interface WorkerConcurrencySample {
  step: string;
  active: number;
  target: number;
}

export interface WorkerHeartbeatInput {
  attemptId: string;
  progressDone?: number;
  progressInFlight?: number;
  progressErrors?: number;
  progressTotal?: number;
  currentStep?: string | null;
  concurrency?: WorkerConcurrencySample[];
}

export interface RunProgressConcurrency {
  step: string;
  active: number;
  target: number;
  ready: boolean;
  freshWorkerCount: number;
}

export type RunProgressStatus = 'planned' | 'in_progress' | 'completed' | 'failed';

export interface RunProgressWorkerCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  stale: number;
  total: number;
}

export interface RunProgressTaskCounts {
  done: number;
  inFlight: number;
  errors: number;
  total: number;
  completionRatio: number;
}

export interface RunProgressParticipantCounts {
  planned: number;
  inProgress: number;
  completed: number;
  failed: number;
  total: number;
}

export interface RunProgressSummary {
  status: RunProgressStatus;
  started: boolean;
  completed: boolean;
  participants: RunProgressParticipantCounts;
}

export interface RunProgressParticipant {
  id: string;
  slug: string;
  provider?: string | null;
  status: RunProgressStatus;
  totalTasks: number;
  workerCount: number;
  workers: RunProgressWorkerCounts;
  tasks: RunProgressTaskCounts;
  concurrency: RunProgressConcurrency[];
}

export interface RunProgress {
  run: {
    id: string;
    status: string;
    totalTasks: number;
    workerCount: number;
  };
  summary: RunProgressSummary;
  freshnessWindowSeconds: number;
  generatedAt: string;
  participants: RunProgressParticipant[];
}

export interface RunWorkerContext {
  assignment: BenchmarkAssignment;
  taskIndex: number;
  step<T>(name: string, fn: () => Promise<T> | T, options?: DefineStepOptions): Promise<T>;
  /**
   * Attaches a JSON measurement to the platform. Called inside a `step`, it
   * lands on that step's `data`; called at task top-level, on the task record's
   * `data`. Repeated calls merge (shallow). Use this for anything you want on
   * the platform — step return values are control flow and are never recorded.
   */
  measure(data: JsonObject): void;
  /**
   * Appends a structured line to the worker log. `metaOrOptions` can be a
   * metadata JSON object, or `{ level, meta }` to set a log level. Levels are
   * filtered by the worker's configured `logLevel` (defaults to `info`).
   */
  log(message: string, metaOrOptions?: JsonObject | BenchmarkLogOptions): void;
}

export interface WorkerFinishContext {
  assignment: BenchmarkAssignment;
  records: TaskResultRecord[];
  status: 'success' | 'error';
  client: BenchmarkClient;
  uploadArtifact(input: Omit<UploadWorkerArtifactInput, 'attemptId'>): Promise<CreateWorkerArtifactResponse>;
}

export interface DefineStepOptions {
  /** Report this step as active in heartbeat concurrency samples. Defaults to true. */
  reportConcurrency?: boolean;
  /** Per-worker target for this step. Defaults to worker concurrency/assignment target. */
  concurrency?: number;
  /** Number of parallel invocations the step function should run internally. Used by the runner to record step-level concurrency. */
  stepConcurrency?: number;
  /** Per-invocation timeout in milliseconds for this step. Used by the runner to record step-level timeout metadata. */
  timeoutMs?: number;
  /** Readiness coordination mode. Defaults to internal. */
  readiness?: 'poll' | 'internal';
  /** Poll interval while waiting for readiness. Defaults to 1000ms. */
  readyPollIntervalMs?: number;
  /** Maximum time to wait for readiness. Defaults to no timeout. */
  readyTimeoutMs?: number;
  /**
   * When true (default), a step that returns a `BenchmarkStepOutcome` with
   * `stdout`, `stderr`, or `error` strings writes those to the worker log.
   */
  captureOutput?: boolean;
}

/**
 * The unit of work a worker runs, once per task index. Steps are declared
 * imperatively via `context.step(...)`; this is the sole task shape the worker
 * engine accepts. Higher-level authoring (`defineTask`) lives in
 * `@benchsdk/runner`, which compiles down to a function of this shape.
 */
export type TaskFunction = (context: RunWorkerContext) => Promise<JsonObject | void> | JsonObject | void;

export interface RunWorkerResult {
  assignment: BenchmarkAssignment | null;
  records: TaskResultRecord[];
}

export interface RunWorkerOptions {
  benchmarkSlug: string;
  runId: string;
  participantSlug: string;
  processKind?: string;
  processKey?: string;
  concurrency?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
  readyPollIntervalMs?: number;
  onResult?: (record: TaskResultRecord) => void;
  /** Runs once after final result flush and before worker completion/failure is reported. */
  onFinish?: (context: WorkerFinishContext) => Promise<void> | void;
  /** Minimum log level to record. Defaults to `BENCHMARK_LOG_LEVEL` env or `info`. */
  logLevel?: BenchmarkLogLevel;
  /** Maximum worker log lines before truncation. Defaults to 100,000. */
  maxLogLines?: number;
  /** Interval in ms to upload accumulated logs as artifacts mid-run. `0` disables. Defaults to `BENCHMARK_LOG_FLUSH_INTERVAL_MS` env or `0`. */
  logFlushIntervalMs?: number;
  /** Compress worker log artifacts with `gzip`. Defaults to `BENCHMARK_LOG_COMPRESSION` env or `false`. */
  logCompression?: 'gzip' | false;
  /**
   * Optional callback for telemetry failures (heartbeat, result flush, log
   * upload, completion). The worker stays best-effort by default; this makes
   * dropped telemetry observable.
   */
  onTelemetryError?: (error: unknown, operation: string) => void;
  /**
   * Interval in ms to sample system metrics (this process's CPU/memory, event
   * loop lag, host load average and socket counts), uploaded as a
   * `system-metrics` artifact once at finish. `0` disables sampling entirely.
   * Defaults to `BENCHMARK_METRICS_INTERVAL_MS` env or 30000 — unlike log
   * flushing, this is on by default since sampling is the only way these
   * values are ever captured.
   */
  metricsIntervalMs?: number;
  task: TaskFunction;
}

export interface BenchmarkRunSummaryMetric {
  name: string;
  unit: string;
  median: number;
  p95: number;
  p99: number;
}

export interface BenchmarkRunSummaryScalar {
  name: string;
  value: number;
  unit: string;
}

export interface BenchmarkRunSummaryResult {
  provider: string;
  dimensions?: Record<string, unknown>;
  metrics: BenchmarkRunSummaryMetric[];
  scalars?: BenchmarkRunSummaryScalar[];
  compositeScore: number;
  successRate: number;
  scoringVersion?: string | null;
  skipped: boolean;
  skipReason?: string | null;
}

export interface BenchmarkRunSummaryRunMetadata {
  gitSha?: string;
  gitRef?: string;
  triggeredBy?: string;
  nodeVersion?: string;
  platform?: string;
  arch?: string;
}

export interface BenchmarkRunSummaryInput {
  run: BenchmarkRunSummaryRunMetadata;
  results: BenchmarkRunSummaryResult[];
  scoring?: JsonObject;
}

export interface BenchmarkClient {
  upsertBenchmark(slug: string, input: UpsertBenchmarkInput): Promise<BenchmarkResource>;
  updateBenchmark(slug: string, input: UpdateBenchmarkInput): Promise<BenchmarkResource>;
  getBenchmark(slug: string): Promise<BenchmarkResource>;
  listBenchmarks(options?: { limit?: number; offset?: number }): Promise<BenchmarkResource[]>;
  createRun(benchmarkSlug: string, input: CreateRunInput): Promise<{
    run: BenchmarkRun;
    participants: BenchmarkParticipant[];
    /** The slug of the org the run was attributed to, resolved server-side from the caller's API key. */
    organizationSlug: string;
  }>;
  listRuns(benchmarkSlug: string, options?: { limit?: number; offset?: number }): Promise<BenchmarkRun[]>;
  getRun(benchmarkSlug: string, runId: string): Promise<BenchmarkRun>;
  updateRun(benchmarkSlug: string, runId: string, input: UpdateRunInput): Promise<BenchmarkRun>;
  upsertParticipant(
    benchmarkSlug: string,
    runId: string,
    participantSlug: string,
    input?: UpsertParticipantInput,
  ): Promise<BenchmarkParticipant>;
  updateParticipant(
    benchmarkSlug: string,
    runId: string,
    participantSlug: string,
    input: UpdateParticipantInput,
  ): Promise<BenchmarkParticipant>;
  listParticipants(benchmarkSlug: string, runId: string): Promise<BenchmarkParticipant[]>;
  getParticipant(
    benchmarkSlug: string,
    runId: string,
    participantSlug: string,
  ): Promise<BenchmarkParticipant>;
  listWorkers(
    benchmarkSlug: string,
    runId: string,
    participantSlug: string,
  ): Promise<BenchmarkRunWorker[]>;
  planWorkers(
    benchmarkSlug: string,
    runId: string,
    participantSlug: string,
    input?: PlanWorkersInput,
  ): Promise<BenchmarkRunWorker[]>;
  getWorker(benchmarkSlug: string, runId: string, workerId: string): Promise<BenchmarkRunWorker>;
  updateWorker(
    benchmarkSlug: string,
    runId: string,
    workerId: string,
    input: UpdateWorkerInput,
  ): Promise<BenchmarkRunWorker>;
  getRunProgress(benchmarkSlug: string, runId: string): Promise<RunProgress>;
  claimWorker(
    benchmarkSlug: string,
    runId: string,
    participantSlug: string,
    input?: ClaimWorkerInput,
  ): Promise<BenchmarkAssignment | null>;
  releaseWorker(benchmarkSlug: string, runId: string, workerId: string, attemptId: string): Promise<{
    worker: BenchmarkRunWorker;
    attempt: BenchmarkWorkerAttempt;
  }>;
  sendTaskResults(input: SendTaskResultsInput): Promise<TaskResultsResponse>;
  heartbeatWorker(benchmarkSlug: string, runId: string, workerId: string, input: WorkerHeartbeatInput): Promise<{
    worker: BenchmarkRunWorker;
    attempt: BenchmarkWorkerAttempt;
  }>;
  completeWorker(benchmarkSlug: string, runId: string, workerId: string, attemptId: string): Promise<{
    worker: BenchmarkRunWorker;
    attempt: BenchmarkWorkerAttempt;
  }>;
  failWorker(
    benchmarkSlug: string,
    runId: string,
    workerId: string,
    attemptId: string,
    error?: unknown,
  ): Promise<{ worker: BenchmarkRunWorker; attempt: BenchmarkWorkerAttempt }>;
  createWorkerArtifact(
    benchmarkSlug: string,
    runId: string,
    workerId: string,
    input: CreateWorkerArtifactInput,
  ): Promise<CreateWorkerArtifactResponse>;
  uploadWorkerArtifact(
    benchmarkSlug: string,
    runId: string,
    workerId: string,
    input: UploadWorkerArtifactInput,
  ): Promise<CreateWorkerArtifactResponse>;
  listRunArtifacts(benchmarkSlug: string, runId: string, options?: { limit?: number; offset?: number }): Promise<BenchmarkArtifact[]>;
  listWorkerArtifacts(benchmarkSlug: string, runId: string, workerId: string, options?: { limit?: number; offset?: number }): Promise<BenchmarkArtifact[]>;
  getWorkerArtifact(
    benchmarkSlug: string,
    runId: string,
    workerId: string,
    artifactId: string,
  ): Promise<BenchmarkArtifactDownload>;
  downloadArtifact(url: string, options?: { contentType?: string; decompress?: boolean }): Promise<string>;
  downloadWorkerArtifact(
    benchmarkSlug: string,
    runId: string,
    workerId: string,
    artifactId: string,
  ): Promise<string>;
  getBenchmarkResults(benchmarkSlug: string, input?: BenchmarkResultsOverviewInput): Promise<BenchmarkResultsOverview>;
  getRunResults(benchmarkSlug: string, runId: string): Promise<BenchmarkRunResults>;
  getRunTaskResults(
    benchmarkSlug: string,
    runId: string,
    input?: BenchmarkRunTaskResultsInput,
  ): Promise<BenchmarkRunTaskResults>;
  getRunTimeline(
    benchmarkSlug: string,
    runId: string,
    input?: BenchmarkRunTimelineInput,
  ): Promise<BenchmarkRunTimeline>;
  getRunImports(benchmarkSlug: string, runId: string): Promise<BenchmarkRunImports>;
  submitRunSummary(benchmarkSlug: string, runId: string, input: BenchmarkRunSummaryInput): Promise<void>;
}
