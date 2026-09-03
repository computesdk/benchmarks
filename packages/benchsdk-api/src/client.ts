import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(gunzipCallback);
import type {
  BenchmarkArtifact,
  BenchmarkArtifactDownload,
  BenchmarkAssignment,
  BenchmarkClient,
  BenchmarkClientConfig,
  BenchmarkParticipant,
  BenchmarkResource,
  BenchmarkRun,
  BenchmarkResultsOverview,
  BenchmarkResultsOverviewInput,
  BenchmarkRunImports,
  BenchmarkRunResults,
  BenchmarkRunSummaryInput,
  BenchmarkRunTaskResults,
  BenchmarkRunTaskResultsInput,
  BenchmarkRunTimeline,
  BenchmarkRunTimelineInput,
  BenchmarkRunWorker,
  BenchmarkWorkerAttempt,
  CreateWorkerArtifactInput,
  CreateWorkerArtifactResponse,
  ClaimWorkerInput,
  CreateRunInput,
  JsonObject,
  SendTaskResultsInput,
  PlanWorkersInput,
  TaskResultRecord,
  TaskResultsResponse,
  RunProgress,
  UpdateBenchmarkInput,
  UpdateParticipantInput,
  UpdateRunInput,
  UpdateWorkerInput,
  UpsertBenchmarkInput,
  UpsertParticipantInput,
  UploadWorkerArtifactInput,
  WorkerConcurrencySample,
  WorkerHeartbeatInput,
} from './types';

const DEFAULT_BASE_URL = 'https://platform.computesdk.com/api/v1';
const MAX_TASK_RESULT_RECORDS = 5000;
const MAX_TASK_RECORD_STEPS = 100;
const MAX_HEARTBEAT_CONCURRENCY_SAMPLES = 20;

export class BenchmarkApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'BenchmarkApiError';
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function queryString(input: Record<string, number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

function getApiKey(input?: string): string | undefined {
  if (input) return input;
  if (typeof process === 'undefined') return undefined;
  return process.env.BENCHMARKS_PLATFORM_API_KEY;
}

function getAuthToken(config: BenchmarkClientConfig): string | undefined {
  if (config.token) return config.token;
  if (config.apiKey) return config.apiKey;
  if (typeof process !== 'undefined' && process.env.BENCHMARKS_PLATFORM_TOKEN) {
    return process.env.BENCHMARKS_PLATFORM_TOKEN;
  }
  return getApiKey(config.apiKey);
}

function getErrorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string' && (error as { code: string }).code) {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && error.name) return error.name;
  return 'ERROR';
}

function validateTaskResults(input: SendTaskResultsInput): void {
  if (input.records.length > MAX_TASK_RESULT_RECORDS) {
    throw new Error(`Benchmark task result batches are limited to ${MAX_TASK_RESULT_RECORDS} records.`);
  }

  for (const record of input.records) {
    if ((record.steps?.length ?? 0) > MAX_TASK_RECORD_STEPS) {
      throw new Error(`Benchmark task result records are limited to ${MAX_TASK_RECORD_STEPS} steps.`);
    }
  }
}

function validateHeartbeat(input: WorkerHeartbeatInput): void {
  const concurrency = input.concurrency ?? [];
  if (concurrency.length > MAX_HEARTBEAT_CONCURRENCY_SAMPLES) {
    throw new Error(`Benchmark heartbeat concurrency is limited to ${MAX_HEARTBEAT_CONCURRENCY_SAMPLES} samples.`);
  }

  const steps = new Set<string>();
  for (const sample of concurrency) {
    if (steps.has(sample.step)) {
      throw new Error(`Benchmark heartbeat concurrency step values must be unique per heartbeat.`);
    }
    steps.add(sample.step);
  }
}

function normalizeArtifacts(data: { items?: BenchmarkArtifact[]; artifacts?: BenchmarkArtifact[] }): BenchmarkArtifact[] {
  return data.items ?? data.artifacts ?? [];
}

function bodySizeBytes(body: UploadWorkerArtifactInput['body']): number | undefined {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  return undefined;
}

function isGzipContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const lowered = contentType.toLowerCase();
  return lowered.includes('gzip') || lowered.includes('x-gzip') || lowered === 'application/gzip';
}

async function downloadArtifactBody(
  doFetch: typeof fetch,
  url: string,
  options?: { contentType?: string; decompress?: boolean },
): Promise<string> {
  const response = await doFetch(url);
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new BenchmarkApiError(
      `Artifact download failed with ${response.status}`,
      response.status,
      errorBody,
    );
  }
  const buffer = await response.arrayBuffer();
  const responseContentType = response.headers.get('content-type');
  const contentType = options?.contentType ?? responseContentType ?? '';
  if (isGzipContentType(contentType) || options?.decompress) {
    try {
      const decompressed = await gunzip(new Uint8Array(buffer));
      return new TextDecoder().decode(decompressed);
    } catch {
      // Fall through and return the raw body if decompression fails.
    }
  }
  return new TextDecoder().decode(buffer);
}

export function createBenchmarkClient(config: BenchmarkClientConfig = {}): BenchmarkClient {
  const baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
  const authToken = getAuthToken(config);
  if (!authToken) {
    throw new Error(
      'A platform API key or OAuth token is required. Set BENCHMARKS_PLATFORM_API_KEY or BENCHMARKS_PLATFORM_TOKEN in your environment, or pass apiKey/token to createBenchmarkClient. Create an API key at https://platform.computesdk.com in your organization settings (Settings → API keys).'
    );
  }

  const fetchImpl = config.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);

  if (!fetchImpl) {
    throw new Error('fetch is not available');
  }
  const doFetch = fetchImpl;

  async function request<T>(method: string, path: string, body?: JsonObject): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (config.orgSlug) headers['X-Org-Slug'] = config.orgSlug;
    else if (config.orgId) headers['X-Organization-Id'] = config.orgId;

    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();

    if (!response.ok) {
      throw new BenchmarkApiError(
        `Benchmark API request failed: ${response.status} ${response.statusText}`,
        response.status,
        text,
      );
    }

    return (text ? JSON.parse(text) : {}) as T;
  }

  async function sendTaskResults(input: SendTaskResultsInput): Promise<TaskResultsResponse> {
    if (input.records.length === 0) {
      return {};
    }
    validateTaskResults(input);

    return request<TaskResultsResponse>(
      'POST',
      `/benchmarks/${encodePath(input.benchmarkSlug)}/runs/${encodePath(input.runId)}/workers/${encodePath(input.workerId)}/events`,
      {
        type: 'task_results',
        attemptId: input.attemptId,
        sequenceNumber: input.sequenceNumber,
        isFinal: input.isFinal,
        records: input.records as unknown as JsonObject[],
      },
    );
  }

  async function updateWorkerLifecycle(
    action: 'heartbeat' | 'complete' | 'fail' | 'release',
    benchmarkSlug: string,
    runId: string,
    workerId: string,
    attemptId: string,
    extra?: JsonObject,
  ): Promise<{ worker: BenchmarkRunWorker; attempt: BenchmarkWorkerAttempt }> {
    return request<{ worker: BenchmarkRunWorker; attempt: BenchmarkWorkerAttempt }>(
      'POST',
      `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/workers/${encodePath(workerId)}/${action}`,
      { attemptId, ...(extra ?? {}) },
    );
  }

  const client: BenchmarkClient = {
    async upsertBenchmark(slug, input) {
      const data = await request<{ benchmark: BenchmarkResource }>('PUT', `/benchmarks/${encodePath(slug)}`, input as unknown as JsonObject);
      return data.benchmark;
    },

    async getBenchmark(slug) {
      const data = await request<{ benchmark: BenchmarkResource }>('GET', `/benchmarks/${encodePath(slug)}`);
      return data.benchmark;
    },

    async updateBenchmark(slug, input: UpdateBenchmarkInput) {
      const data = await request<{ benchmark: BenchmarkResource }>('PATCH', `/benchmarks/${encodePath(slug)}`, input as unknown as JsonObject);
      return data.benchmark;
    },

    async listBenchmarks(options: { limit?: number; offset?: number } = {}) {
      const data = await request<{ items?: BenchmarkResource[]; benchmarks?: BenchmarkResource[] }>(
        'GET',
        `/benchmarks${queryString(options)}`,
      );
      return data.items ?? data.benchmarks ?? [];
    },

    async createRun(benchmarkSlug, input) {
      return request<{ run: BenchmarkRun; participants: BenchmarkParticipant[]; organizationSlug: string }>(
        'POST',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs`,
        input as unknown as JsonObject,
      );
    },

    async listRuns(benchmarkSlug, options: { limit?: number; offset?: number } = {}) {
      const data = await request<{ items: BenchmarkRun[] }>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs${queryString(options)}`,
      );
      return data.items;
    },

    async getRun(benchmarkSlug, runId) {
      const data = await request<{ run: BenchmarkRun }>('GET', `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}`);
      return data.run;
    },

    async updateRun(benchmarkSlug, runId, input: UpdateRunInput) {
      const data = await request<{ run: BenchmarkRun }>(
        'PATCH',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}`,
        input as unknown as JsonObject,
      );
      return data.run;
    },

    async upsertParticipant(benchmarkSlug, runId, participantSlug, input = {}) {
      const data = await request<{ participant: BenchmarkParticipant }>(
        'PUT',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/participants/${encodePath(participantSlug)}`,
        input as JsonObject,
      );
      return data.participant;
    },

    async listParticipants(benchmarkSlug, runId) {
      const data = await request<{ items?: BenchmarkParticipant[]; participants?: BenchmarkParticipant[] }>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/participants`,
      );
      return data.items ?? data.participants ?? [];
    },

    async getParticipant(benchmarkSlug, runId, participantSlug) {
      const data = await request<{ participant: BenchmarkParticipant }>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/participants/${encodePath(participantSlug)}`,
      );
      return data.participant;
    },

    async updateParticipant(benchmarkSlug, runId, participantSlug, input: UpdateParticipantInput) {
      const data = await request<{ participant: BenchmarkParticipant }>(
        'PATCH',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/participants/${encodePath(participantSlug)}`,
        input as unknown as JsonObject,
      );
      return data.participant;
    },

    async getRunProgress(benchmarkSlug, runId) {
      return request<RunProgress>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/progress`,
      );
    },

    async listWorkers(benchmarkSlug, runId, participantSlug) {
      const data = await request<{ items?: BenchmarkRunWorker[]; workers?: BenchmarkRunWorker[] }>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/participants/${encodePath(participantSlug)}/workers`,
      );
      return data.items ?? data.workers ?? [];
    },

    async planWorkers(benchmarkSlug, runId, participantSlug, input: PlanWorkersInput = {}) {
      const data = await request<{ items?: BenchmarkRunWorker[]; workers?: BenchmarkRunWorker[] }>(
        'POST',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/participants/${encodePath(participantSlug)}/workers`,
        input as JsonObject,
      );
      return data.items ?? data.workers ?? [];
    },

    async getWorker(benchmarkSlug, runId, workerId) {
      const data = await request<{ worker: BenchmarkRunWorker }>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/workers/${encodePath(workerId)}`,
      );
      return data.worker;
    },

    async updateWorker(benchmarkSlug, runId, workerId, input: UpdateWorkerInput) {
      const data = await request<{ worker: BenchmarkRunWorker }>(
        'PATCH',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/workers/${encodePath(workerId)}`,
        input as unknown as JsonObject,
      );
      return data.worker;
    },

    async claimWorker(benchmarkSlug, runId, participantSlug, input: ClaimWorkerInput = {}) {
      const data = await request<{ assignment: BenchmarkAssignment | null }>(
        'POST',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/participants/${encodePath(participantSlug)}/workers/claim`,
        input as JsonObject,
      );
      return data.assignment;
    },

    sendTaskResults,

    async heartbeatWorker(benchmarkSlug, runId, workerId, input: WorkerHeartbeatInput) {
      validateHeartbeat(input);
      const { attemptId, ...extra } = input;
      if (extra.currentStep == null) {
        delete extra.currentStep;
      }
      return updateWorkerLifecycle('heartbeat', benchmarkSlug, runId, workerId, attemptId, extra as JsonObject);
    },

    releaseWorker(benchmarkSlug, runId, workerId, attemptId) {
      return updateWorkerLifecycle('release', benchmarkSlug, runId, workerId, attemptId);
    },

    completeWorker(benchmarkSlug, runId, workerId, attemptId) {
      return updateWorkerLifecycle('complete', benchmarkSlug, runId, workerId, attemptId);
    },

    failWorker(benchmarkSlug, runId, workerId, attemptId, error) {
      return updateWorkerLifecycle('fail', benchmarkSlug, runId, workerId, attemptId, {
        errorCode: getErrorCode(error),
        errorMessage: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
      });
    },

    async createWorkerArtifact(benchmarkSlug, runId, workerId, input: CreateWorkerArtifactInput) {
      return request<CreateWorkerArtifactResponse>(
        'POST',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/workers/${encodePath(workerId)}/artifacts`,
        input as unknown as JsonObject,
      );
    },

    async uploadWorkerArtifact(benchmarkSlug, runId, workerId, input: UploadWorkerArtifactInput) {
      const sizeBytes = bodySizeBytes(input.body);
      const artifactInput: CreateWorkerArtifactInput = {
        attemptId: input.attemptId,
        kind: input.kind,
        contentType: input.contentType,
        name: input.name,
        metadata: sizeBytes === undefined ? input.metadata : { ...input.metadata, sizeBytes },
      };
      const response = await client.createWorkerArtifact(benchmarkSlug, runId, workerId, artifactInput);
      const uploadUrl = response.uploadUrl ?? response.artifact?.uploadUrl;
      if (!uploadUrl) {
        throw new Error('Benchmark artifact upload URL is missing.');
      }
      const uploadResponse = await doFetch(uploadUrl, {
        method: 'PUT',
        headers: input.contentType ? { 'Content-Type': input.contentType } : undefined,
        body: input.body,
      });
      if (!uploadResponse.ok) {
        const errorBody = await uploadResponse.text().catch(() => '');
        throw new BenchmarkApiError(
          `Benchmark artifact upload failed with ${uploadResponse.status}`,
          uploadResponse.status,
          errorBody,
        );
      }
      return response;
    },

    async listRunArtifacts(benchmarkSlug, runId, options: { limit?: number; offset?: number } = {}) {
      const data = await request<{ items?: BenchmarkArtifact[]; artifacts?: BenchmarkArtifact[] }>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/artifacts${queryString(options)}`,
      );
      return normalizeArtifacts(data);
    },

    async listWorkerArtifacts(benchmarkSlug, runId, workerId, options: { limit?: number; offset?: number } = {}) {
      const data = await request<{ items?: BenchmarkArtifact[]; artifacts?: BenchmarkArtifact[] }>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/workers/${encodePath(workerId)}/artifacts${queryString(options)}`,
      );
      return normalizeArtifacts(data);
    },

    async getWorkerArtifact(benchmarkSlug, runId, workerId, artifactId) {
      return request<BenchmarkArtifactDownload>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/workers/${encodePath(workerId)}/artifacts/${encodePath(artifactId)}`,
      );
    },

    downloadArtifact(url, options) {
      return downloadArtifactBody(doFetch, url, options);
    },

    async downloadWorkerArtifact(benchmarkSlug, runId, workerId, artifactId) {
      const { artifact, downloadUrl } = await client.getWorkerArtifact(
        benchmarkSlug,
        runId,
        workerId,
        artifactId,
      );
      return downloadArtifactBody(doFetch, downloadUrl, { contentType: artifact.contentType ?? undefined });
    },

    async getBenchmarkResults(benchmarkSlug, input: BenchmarkResultsOverviewInput = {}) {
      return request<BenchmarkResultsOverview>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/results${queryString({ limit: input.limit, offset: input.offset })}`,
      );
    },

    async getRunResults(benchmarkSlug, runId) {
      return request<BenchmarkRunResults>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/results`,
      );
    },

    async getRunTaskResults(benchmarkSlug, runId, input: BenchmarkRunTaskResultsInput = {}) {
      return request<BenchmarkRunTaskResults>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/results/tasks${queryString({ bucketSize: input.bucketSize, failureLimit: input.failureLimit })}`,
      );
    },

    async getRunTimeline(benchmarkSlug, runId, input: BenchmarkRunTimelineInput = {}) {
      return request<BenchmarkRunTimeline>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/results/timeline${queryString({ bucketMs: input.bucketMs })}`,
      );
    },

    async getRunImports(benchmarkSlug, runId) {
      return request<BenchmarkRunImports>(
        'GET',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/results/imports`,
      );
    },

    async submitRunSummary(benchmarkSlug, runId, input) {
      await request(
        'POST',
        `/benchmarks/${encodePath(benchmarkSlug)}/runs/${encodePath(runId)}/summary`,
        input as unknown as JsonObject,
      );
    },
  };

  return client;
}

