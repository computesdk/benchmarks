import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as runnerBarrel from '@benchsdk/runner';

import * as barrel from '../index';
import {
  BenchmarkApiError,
  BenchmarkReporter,
  claimBenchmarkReporter,
  createBenchmarkClient,
  createSystemMetricsCollector,
} from '../index';
import type { BenchmarkAssignment, BenchmarkClient } from '../index';

// The public type surface is imported by name here purely to prove every exported
// type resolves against the package barrel (the consumer-compile contract).
import type {
  BenchmarkArtifact,
  BenchmarkArtifactDownload,
  BenchmarkClientConfig,
  BenchmarkLogLevel,
  BenchmarkLogOptions,
  BenchmarkStepOutcome,
  BenchmarkConcurrencyPoint,
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
  BenchmarkRunSummaryInput,
  BenchmarkRunSummaryMetric,
  BenchmarkRunSummaryResult,
  BenchmarkRunSummaryRunMetadata,
  BenchmarkRunSummaryScalar,
  BenchmarkRunStatus,
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
  WorkerConcurrencySample,
  WorkerFinishContext,
  WorkerHeartbeatInput,
  UpsertBenchmarkInput,
  UpsertParticipantInput,
  UploadWorkerArtifactInput,
} from '../index';
import type {
  BenchmarkReporterArtifactInput,
  BenchmarkReporterBarrierInput,
  BenchmarkReporterBarrierResult,
  BenchmarkReporterConfig,
  BenchmarkReporterHeartbeatInput,
  BenchmarkReporterProgress,
} from '../index';
import type {
  BenchmarkSystemMetricsCollector,
  BenchmarkSystemMetricsSample,
} from '../index';

// Referencing every named type forces `tsc --noEmit` to resolve each export.
// If any public type were dropped from the barrel, this alias would fail to compile.
type _PublicTypeSurface = [
  BenchmarkAssignment,
  BenchmarkArtifact,
  BenchmarkArtifactDownload,
  BenchmarkClient,
  BenchmarkClientConfig,
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
  BenchmarkRunSummaryInput,
  BenchmarkRunSummaryMetric,
  BenchmarkRunSummaryResult,
  BenchmarkRunSummaryRunMetadata,
  BenchmarkRunSummaryScalar,
  BenchmarkRunStatus,
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
  WorkerConcurrencySample,
  WorkerFinishContext,
  WorkerHeartbeatInput,
  UpsertBenchmarkInput,
  UpsertParticipantInput,
  UploadWorkerArtifactInput,
  BenchmarkReporterArtifactInput,
  BenchmarkReporterBarrierInput,
  BenchmarkReporterBarrierResult,
  BenchmarkReporterConfig,
  BenchmarkReporterHeartbeatInput,
  BenchmarkReporterProgress,
  BenchmarkSystemMetricsCollector,
  BenchmarkSystemMetricsSample,
];

const BASE = 'https://platform.test/api/v1';
const DEFAULT_BASE_URL = 'https://platform.computesdk.com/api/v1';

let originalApiKey: string | undefined;

beforeAll(() => {
  originalApiKey = process.env.BENCHMARKS_PLATFORM_API_KEY;
  process.env.BENCHMARKS_PLATFORM_API_KEY = 'k';
});

afterAll(() => {
  if (originalApiKey === undefined) {
    delete process.env.BENCHMARKS_PLATFORM_API_KEY;
  } else {
    process.env.BENCHMARKS_PLATFORM_API_KEY = originalApiKey;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h as [string, string][]);
  return { ...(h as Record<string, string>) };
}

function parseBody(init?: RequestInit): unknown {
  if (init?.body === undefined || init?.body === null) return undefined;
  try {
    return JSON.parse(String(init.body));
  } catch {
    return init.body;
  }
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeAssignment(overrides: Partial<BenchmarkAssignment> = {}): BenchmarkAssignment {
  return {
    benchmarkId: 'bench_1',
    benchmarkSlug: 'scale',
    runId: 'run_1',
    participantId: 'participant_1',
    participantSlug: 'e2b',
    provider: 'e2b',
    workerId: 'worker_1',
    workerIndex: 0,
    workerCount: 1,
    attemptId: 'attempt_1',
    attemptNumber: 1,
    taskRange: { start: 0, end: 0, count: 1 },
    targetConcurrency: 1,
    config: {},
    ...overrides,
  };
}

function progressResponse(opts: { step?: string; ready?: boolean } = {}): unknown {
  const step = opts.step ?? 'pause';
  const ready = opts.ready ?? true;
  return {
    run: { id: 'run_1', status: 'running', totalTasks: 1, workerCount: 1 },
    summary: {
      status: 'in_progress',
      started: true,
      completed: false,
      participants: { planned: 0, inProgress: 1, completed: 0, failed: 0, total: 1 },
    },
    freshnessWindowSeconds: 15,
    generatedAt: new Date().toISOString(),
    participants: [{
      id: 'participant_1',
      slug: 'e2b',
      status: 'in_progress',
      totalTasks: 1,
      workerCount: 1,
      workers: { pending: 0, running: 1, completed: 0, failed: 0, stale: 0, total: 1 },
      tasks: { done: 0, inFlight: 1, errors: 0, total: 1, completionRatio: 0 },
      concurrency: [{ step, active: 1, target: 1, ready, freshWorkerCount: 1 }],
    }],
  };
}

const benchmarkResource = () => ({ id: 'bench_1', slug: 'scale', name: 'Scale' });
const runResource = () => ({ id: 'run_1', benchmarkId: 'bench_1', status: 'planned', totalTasks: 1, workerCount: 1 });
const participantResource = () => ({ id: 'participant_1', benchmarkId: 'bench_1', runId: 'run_1', slug: 'e2b', status: 'planned', totalTasks: 1, workerCount: 1 });
const workerResource = () => ({ id: 'worker_1', benchmarkId: 'bench_1', runId: 'run_1', participantId: 'participant_1', workerIndex: 0, workerCount: 1, taskIndexStart: 0, taskIndexEnd: 0, targetConcurrency: 1, status: 'planned' });
const lifecycleResponse = () => ({ worker: { id: 'worker_1' }, attempt: { id: 'attempt_1' } });

const overviewResponse = () => ({
  benchmark: { id: 'bench_1', slug: 'scale', name: 'Scale' },
  generatedAt: new Date().toISOString(),
  analytics: { status: 'complete', query: 'available' },
  items: [{
    run: runResource(),
    analytics: { status: 'complete', eventBatches: 1, persisted: 1, queued: 0, failed: 0, imports: { pending: 0, importing: 0, imported: 1, failed: 0, missing: 0 } },
    participants: [],
  }],
});
const runResultsResponse = () => ({ benchmark: { id: 'bench_1', slug: 'scale', name: 'Scale' }, run: { id: 'run_1', status: 'completed', totalTasks: 1, workerCount: 1 }, generatedAt: new Date().toISOString(), overall: { taskCount: 1 }, participants: [], steps: [] });
const taskResultsResponse = () => ({ run: { id: 'run_1' }, generatedAt: new Date().toISOString(), bucketSize: 10, buckets: [], failures: [] });
const timelineResponse = () => ({ run: { id: 'run_1' }, generatedAt: new Date().toISOString(), eventRate: { bucketMs: 1000, buckets: [] }, concurrency: { firstRecordedAt: null, heartbeatCount: 0, points: [] } });
const importsResponse = () => ({ run: { id: 'run_1' }, generatedAt: new Date().toISOString(), summary: { eventBatches: 0, persisted: 0, queued: 0, failed: 0, imports: { pending: 0, importing: 0, imported: 0, failed: 0, missing: 0 } }, items: [] });

/** Full orchestrator responder covering every documented endpoint path. */
function handler(url: string, method: string): Response {
  if (url === 'https://upload.test' && method === 'PUT') return new Response(null, { status: 200 });
  const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;

  if (path === '/benchmarks' && method === 'GET') return jsonResponse({ items: [benchmarkResource()] });
  if (path === '/benchmarks/scale' && method === 'PUT') return jsonResponse({ benchmark: benchmarkResource() });
  if (path === '/benchmarks/scale' && method === 'GET') return jsonResponse({ benchmark: benchmarkResource() });
  if (path === '/benchmarks/scale' && method === 'PATCH') return jsonResponse({ benchmark: benchmarkResource() });
  if (path === '/benchmarks/scale/runs' && method === 'POST') return jsonResponse({ run: runResource(), participants: [participantResource()] }, 201);
  if (path === '/benchmarks/scale/runs' && method === 'GET') return jsonResponse({ items: [runResource()] });
  if (path === '/benchmarks/scale/runs/run_1' && method === 'GET') return jsonResponse({ run: runResource() });
  if (path === '/benchmarks/scale/runs/run_1' && method === 'PATCH') return jsonResponse({ run: runResource() });
  if (path === '/benchmarks/scale/runs/run_1/participants/e2b' && method === 'PUT') return jsonResponse({ participant: participantResource() });
  if (path === '/benchmarks/scale/runs/run_1/participants' && method === 'GET') return jsonResponse({ items: [participantResource()] });
  if (path === '/benchmarks/scale/runs/run_1/participants/e2b' && method === 'GET') return jsonResponse({ participant: participantResource() });
  if (path === '/benchmarks/scale/runs/run_1/participants/e2b' && method === 'PATCH') return jsonResponse({ participant: participantResource() });
  if (path === '/benchmarks/scale/runs/run_1/participants/e2b/workers' && method === 'GET') return jsonResponse({ items: [workerResource()] });
  if (path === '/benchmarks/scale/runs/run_1/participants/e2b/workers' && method === 'POST') return jsonResponse({ items: [workerResource()] });
  if (path === '/benchmarks/scale/runs/run_1/participants/e2b/workers/claim' && method === 'POST') return jsonResponse({ assignment: makeAssignment() });
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1' && method === 'GET') return jsonResponse({ worker: workerResource() });
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1' && method === 'PATCH') return jsonResponse({ worker: workerResource() });
  if (path === '/benchmarks/scale/runs/run_1/progress' && method === 'GET') return jsonResponse(progressResponse());
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1/release' && method === 'POST') return jsonResponse(lifecycleResponse());
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1/events' && method === 'POST') return jsonResponse({ accepted: 1 }, 202);
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1/heartbeat' && method === 'POST') return jsonResponse(lifecycleResponse());
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1/complete' && method === 'POST') return jsonResponse(lifecycleResponse());
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1/fail' && method === 'POST') return jsonResponse(lifecycleResponse());
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1/artifacts' && method === 'POST') return jsonResponse({ artifactId: 'artifact_1', uploadUrl: 'https://upload.test' });
  if (path === '/benchmarks/scale/runs/run_1/artifacts' && method === 'GET') return jsonResponse({ artifacts: [{ artifactId: 'artifact_run', kind: 'log' }] });
  if (path === '/benchmarks/scale/runs/run_1/workers/worker_1/artifacts' && method === 'GET') return jsonResponse({ items: [{ artifactId: 'artifact_worker', kind: 'log' }] });
  if (path.startsWith('/benchmarks/scale/results') && method === 'GET') return jsonResponse(overviewResponse());
  if (path === '/benchmarks/scale/runs/run_1/results' && method === 'GET') return jsonResponse(runResultsResponse());
  if (path.startsWith('/benchmarks/scale/runs/run_1/results/tasks') && method === 'GET') return jsonResponse(taskResultsResponse());
  if (path.startsWith('/benchmarks/scale/runs/run_1/results/timeline') && method === 'GET') return jsonResponse(timelineResponse());
  if (path === '/benchmarks/scale/runs/run_1/results/imports' && method === 'GET') return jsonResponse(importsResponse());
  if (path === '/benchmarks/scale/runs/run_1/summary' && method === 'POST') return jsonResponse({});
  throw new Error(`unexpected request: ${method} ${url}`);
}

/** Runs `fn` with a recording client wired to the full orchestrator responder. */
async function capture<T>(
  fn: (client: BenchmarkClient) => Promise<T>,
  config: Partial<BenchmarkClientConfig> = {},
): Promise<{ calls: RecordedCall[]; result: T }> {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: headerRecord(init), body: parseBody(init) });
    return handler(url, method);
  });
  const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'key_abc', fetch: fetchMock as typeof fetch, ...config });
  const result = await fn(client);
  return { calls, result };
}

function recordingClient(responder: (url: string, method: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: headerRecord(init), body: parseBody(init) });
    return responder(url, method, init);
  });
  return { calls, fetchMock: fetchMock as typeof fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Transport layer — VAL-SDK-001 .. VAL-SDK-010
// ---------------------------------------------------------------------------
describe('transport layer', () => {
  it('VAL-SDK-001: defaults base URL to the platform orchestrator', async () => {
    const { fetchMock } = recordingClient(() => jsonResponse({ benchmark: benchmarkResource() }));
    const client = createBenchmarkClient({ apiKey: 'k', fetch: fetchMock });
    await client.getBenchmark('scale');
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(`${DEFAULT_BASE_URL}/benchmarks/scale`);
  });

  it('VAL-SDK-002: trims trailing slashes from a custom base URL', async () => {
    const { calls, fetchMock } = recordingClient(() => jsonResponse({ benchmark: benchmarkResource() }));
    const client = createBenchmarkClient({ baseUrl: 'https://platform.test/api/v1///', apiKey: 'k', fetch: fetchMock });
    await client.getBenchmark('scale');
    expect(calls[0].url).toBe('https://platform.test/api/v1/benchmarks/scale');
  });

  it('VAL-SDK-003: encodes dynamic path segments with encodeURIComponent', async () => {
    const { calls, fetchMock } = recordingClient(() => jsonResponse({ benchmark: benchmarkResource() }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.getBenchmark('scale/with space');
    expect(calls[0].url).toBe(`${BASE}/benchmarks/scale%2Fwith%20space`);
  });

  it('VAL-SDK-004: sends Authorization: Bearer <apiKey> on every request', async () => {
    const { calls } = await capture((c) => Promise.all([
      c.getBenchmark('scale'),
      c.listBenchmarks(),
      c.getRun('scale', 'run_1'),
    ]));
    for (const call of calls) {
      expect(call.headers.Authorization).toBe('Bearer key_abc');
    }
  });

  it('VAL-SDK-005: reads the API key from BENCHMARKS_PLATFORM_API_KEY', async () => {
    const prevBenchmarks = process.env.BENCHMARKS_PLATFORM_API_KEY;
    try {
      process.env.BENCHMARKS_PLATFORM_API_KEY = 'benchmarks_key';
      const { calls, fetchMock } = recordingClient(() => jsonResponse({ benchmark: benchmarkResource() }));
      await createBenchmarkClient({ baseUrl: BASE, fetch: fetchMock }).getBenchmark('scale');
      expect(calls[0].headers.Authorization).toBe('Bearer benchmarks_key');
    } finally {
      if (prevBenchmarks === undefined) delete process.env.BENCHMARKS_PLATFORM_API_KEY;
      else process.env.BENCHMARKS_PLATFORM_API_KEY = prevBenchmarks;
    }
  });

  it('VAL-SDK-006: sets Content-Type: application/json on all requests', async () => {
    const { calls } = await capture((c) => Promise.all([
      c.getBenchmark('scale'),
      c.upsertBenchmark('scale', { name: 'Scale' }),
    ]));
    for (const call of calls) {
      expect(call.headers['Content-Type']).toBe('application/json');
    }
  });

  it('VAL-SDK-007: throws synchronously when no fetch implementation is available', () => {
    vi.stubGlobal('fetch', undefined);
    expect(() => createBenchmarkClient({ baseUrl: BASE, apiKey: 'k' })).toThrow('fetch is not available');
  });

  it('VAL-SDK-008: BenchmarkApiError carries name, status, body and a formatted message', async () => {
    const { fetchMock } = recordingClient(() => new Response('bad things', { status: 503, statusText: 'Service Unavailable' }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    const error = await client.getBenchmark('scale').catch((e) => e);
    expect(error).toBeInstanceOf(BenchmarkApiError);
    expect(error.name).toBe('BenchmarkApiError');
    expect(error.status).toBe(503);
    expect(error.body).toBe('bad things');
    expect(error.message).toContain('503');
    expect(error.message).toContain('Service Unavailable');
  });

  it('VAL-SDK-009: non-ok responses throw BenchmarkApiError', async () => {
    const { fetchMock } = recordingClient(() => new Response('nope', { status: 500, statusText: 'Server Error' }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await expect(client.getBenchmark('scale')).rejects.toBeInstanceOf(BenchmarkApiError);
    await expect(client.getBenchmark('scale')).rejects.toMatchObject({ status: 500, body: 'nope' });
  });

  it('VAL-SDK-010: parses an empty response body to an empty object', async () => {
    const { fetchMock } = recordingClient(() => new Response('', { status: 200 }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await expect(client.getRunProgress('scale', 'run_1')).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Client method URL paths & response unwrapping — VAL-SDK-011 .. VAL-SDK-044
// ---------------------------------------------------------------------------
describe('client method URL paths and response unwrapping', () => {
  it('VAL-SDK-011: upsertBenchmark PUT /benchmarks/{slug} → data.benchmark', async () => {
    const { calls, result } = await capture((c) => c.upsertBenchmark('scale', { name: 'Scale' }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`PUT ${BASE}/benchmarks/scale`);
    expect(result).toMatchObject({ slug: 'scale' });
  });

  it('VAL-SDK-012: getBenchmark GET /benchmarks/{slug}', async () => {
    const { calls, result } = await capture((c) => c.getBenchmark('scale'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale`);
    expect(result).toMatchObject({ slug: 'scale' });
  });

  it('VAL-SDK-013: updateBenchmark PATCH /benchmarks/{slug}', async () => {
    const { calls, result } = await capture((c) => c.updateBenchmark('scale', { name: 'Scale v2' }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`PATCH ${BASE}/benchmarks/scale`);
    expect(result).toMatchObject({ slug: 'scale' });
  });

  it('VAL-SDK-014: listBenchmarks GET /benchmarks with items ?? benchmarks ?? [] envelope', async () => {
    const items = recordingClient(() => jsonResponse({ items: [{ id: 'b', slug: 's', name: 'n' }] }));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: items.fetchMock }).listBenchmarks()).resolves.toHaveLength(1);
    expect(`${items.calls[0].method} ${items.calls[0].url}`).toBe(`GET ${BASE}/benchmarks`);

    const legacy = recordingClient(() => jsonResponse({ benchmarks: [{ id: 'b', slug: 's', name: 'n' }] }));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: legacy.fetchMock }).listBenchmarks()).resolves.toHaveLength(1);

    const empty = recordingClient(() => jsonResponse({}));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: empty.fetchMock }).listBenchmarks()).resolves.toEqual([]);
  });

  it('VAL-SDK-015: createRun POST /benchmarks/{slug}/runs → { run, participants }', async () => {
    const { calls, result } = await capture((c) => c.createRun('scale', { totalTasks: 1, workerCount: 1, participants: ['e2b'] }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs`);
    expect(result).toMatchObject({ run: { id: 'run_1' }, participants: [{ slug: 'e2b' }] });
  });

  it('VAL-SDK-016: listRuns GET /benchmarks/{slug}/runs → data.items with NO runs fallback', async () => {
    const { calls, result } = await capture((c) => c.listRuns('scale'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs`);
    expect(result).toHaveLength(1);

    // Asymmetry: unlike listBenchmarks/listParticipants, there is no `runs` fallback.
    const legacy = recordingClient(() => jsonResponse({ runs: [runResource()] }));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: legacy.fetchMock }).listRuns('scale')).resolves.toBeUndefined();
  });

  it('VAL-SDK-017: getRun GET /benchmarks/{slug}/runs/{runId}', async () => {
    const { calls, result } = await capture((c) => c.getRun('scale', 'run_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1`);
    expect(result).toMatchObject({ id: 'run_1' });
  });

  it('VAL-SDK-018: updateRun PATCH /benchmarks/{slug}/runs/{runId}', async () => {
    const { calls, result } = await capture((c) => c.updateRun('scale', 'run_1', { status: 'in_progress' }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`PATCH ${BASE}/benchmarks/scale/runs/run_1`);
    expect(result).toMatchObject({ id: 'run_1' });
  });

  it('VAL-SDK-019: upsertParticipant PUT …/participants/{slug} with default {} input', async () => {
    const { calls, result } = await capture((c) => c.upsertParticipant('scale', 'run_1', 'e2b'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`PUT ${BASE}/benchmarks/scale/runs/run_1/participants/e2b`);
    expect(calls[0].body).toEqual({});
    expect(result).toMatchObject({ slug: 'e2b' });
  });

  it('VAL-SDK-020: listParticipants GET …/participants with items ?? participants ?? []', async () => {
    const { calls, result } = await capture((c) => c.listParticipants('scale', 'run_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/participants`);
    expect(result).toHaveLength(1);

    const legacy = recordingClient(() => jsonResponse({ participants: [participantResource()] }));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: legacy.fetchMock }).listParticipants('scale', 'run_1')).resolves.toHaveLength(1);
    const empty = recordingClient(() => jsonResponse({}));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: empty.fetchMock }).listParticipants('scale', 'run_1')).resolves.toEqual([]);
  });

  it('VAL-SDK-021: getParticipant GET …/participants/{slug}', async () => {
    const { calls, result } = await capture((c) => c.getParticipant('scale', 'run_1', 'e2b'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/participants/e2b`);
    expect(result).toMatchObject({ slug: 'e2b' });
  });

  it('VAL-SDK-022: updateParticipant PATCH …/participants/{slug}', async () => {
    const { calls, result } = await capture((c) => c.updateParticipant('scale', 'run_1', 'e2b', { status: 'in_progress' }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`PATCH ${BASE}/benchmarks/scale/runs/run_1/participants/e2b`);
    expect(result).toMatchObject({ slug: 'e2b' });
  });

  it('VAL-SDK-023: planWorkers POST …/participants/{slug}/workers with items ?? workers ?? []', async () => {
    const { calls, result } = await capture((c) => c.planWorkers('scale', 'run_1', 'e2b'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/participants/e2b/workers`);
    expect(result).toHaveLength(1);

    const legacy = recordingClient(() => jsonResponse({ workers: [workerResource()] }));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: legacy.fetchMock }).planWorkers('scale', 'run_1', 'e2b')).resolves.toHaveLength(1);
    const empty = recordingClient(() => jsonResponse({}));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: empty.fetchMock }).planWorkers('scale', 'run_1', 'e2b')).resolves.toEqual([]);
  });

  it('VAL-SDK-024: listWorkers GET …/participants/{slug}/workers with items ?? workers ?? []', async () => {
    const { calls, result } = await capture((c) => c.listWorkers('scale', 'run_1', 'e2b'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/participants/e2b/workers`);
    expect(result).toHaveLength(1);

    const legacy = recordingClient(() => jsonResponse({ workers: [workerResource()] }));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: legacy.fetchMock }).listWorkers('scale', 'run_1', 'e2b')).resolves.toHaveLength(1);
  });

  it('VAL-SDK-025: getWorker GET …/runs/{runId}/workers/{workerId} (skips /participants/{slug})', async () => {
    const { calls, result } = await capture((c) => c.getWorker('scale', 'run_1', 'worker_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1`);
    expect(calls[0].url).not.toContain('/participants/');
    expect(result).toMatchObject({ id: 'worker_1' });
  });

  it('VAL-SDK-026: updateWorker PATCH …/workers/{workerId}', async () => {
    const { calls, result } = await capture((c) => c.updateWorker('scale', 'run_1', 'worker_1', { progressDone: 1 }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`PATCH ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1`);
    expect(result).toMatchObject({ id: 'worker_1' });
  });

  it('VAL-SDK-027: claimWorker POST …/workers/claim returns nullable data.assignment', async () => {
    const { calls, result } = await capture((c) => c.claimWorker('scale', 'run_1', 'e2b'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/participants/e2b/workers/claim`);
    expect(result).toMatchObject({ workerId: 'worker_1' });

    const nullClaim = recordingClient(() => jsonResponse({ assignment: null }));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: nullClaim.fetchMock }).claimWorker('scale', 'run_1', 'e2b')).resolves.toBeNull();
  });

  it('VAL-SDK-028: releaseWorker POST …/workers/{workerId}/release', async () => {
    const { calls, result } = await capture((c) => c.releaseWorker('scale', 'run_1', 'worker_1', 'attempt_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/release`);
    expect(calls[0].body).toMatchObject({ attemptId: 'attempt_1' });
    expect(result).toMatchObject({ worker: { id: 'worker_1' } });
  });

  it('VAL-SDK-029: heartbeatWorker POST …/heartbeat, omits currentStep when null', async () => {
    const { calls } = await capture((c) => c.heartbeatWorker('scale', 'run_1', 'worker_1', {
      attemptId: 'attempt_1',
      progressDone: 0,
      currentStep: null,
      concurrency: [],
    }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/heartbeat`);
    expect(calls[0].body).not.toHaveProperty('currentStep');
    expect(calls[0].body).toMatchObject({ attemptId: 'attempt_1', concurrency: [] });
  });

  it('VAL-SDK-030: completeWorker POST …/complete', async () => {
    const { calls } = await capture((c) => c.completeWorker('scale', 'run_1', 'worker_1', 'attempt_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/complete`);
    expect(calls[0].body).toMatchObject({ attemptId: 'attempt_1' });
  });

  it('VAL-SDK-031: failWorker POST …/fail with errorCode/errorMessage', async () => {
    const { calls } = await capture((c) => c.failWorker('scale', 'run_1', 'worker_1', 'attempt_1', new TypeError('kaboom')));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/fail`);
    expect(calls[0].body).toMatchObject({ attemptId: 'attempt_1', errorCode: 'TypeError', errorMessage: 'kaboom' });
  });

  it('VAL-SDK-032: sendTaskResults POST …/events with type task_results; empty records short-circuit', async () => {
    const { calls, result } = await capture((c) => c.sendTaskResults({
      benchmarkSlug: 'scale', runId: 'run_1', workerId: 'worker_1', attemptId: 'attempt_1',
      sequenceNumber: 0, isFinal: true, records: [{ taskIndex: 0, status: 'success' }],
    }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/events`);
    expect(calls[0].body).toMatchObject({ type: 'task_results', attemptId: 'attempt_1', sequenceNumber: 0, isFinal: true });

    const empty = recordingClient(() => jsonResponse({}));
    const emptyClient = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: empty.fetchMock });
    await expect(emptyClient.sendTaskResults({
      benchmarkSlug: 'scale', runId: 'run_1', workerId: 'worker_1', attemptId: 'attempt_1',
      sequenceNumber: 0, isFinal: false, records: [],
    })).resolves.toEqual({});
    expect(empty.calls).toHaveLength(0);
    expect(result).toBeDefined();
  });

  it('VAL-SDK-033: createWorkerArtifact POST …/workers/{workerId}/artifacts', async () => {
    const { calls, result } = await capture((c) => c.createWorkerArtifact('scale', 'run_1', 'worker_1', { attemptId: 'attempt_1', kind: 'log' }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/artifacts`);
    expect(result).toMatchObject({ artifactId: 'artifact_1' });
  });

  it('VAL-SDK-034: uploadWorkerArtifact does create + PUT to uploadUrl; missing URL throws', async () => {
    const { calls, result } = await capture((c) => c.uploadWorkerArtifact('scale', 'run_1', 'worker_1', {
      attemptId: 'attempt_1', kind: 'log', name: 'coordinator.log', contentType: 'text/plain', body: 'hello\n',
    }));
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/artifacts`,
      'PUT https://upload.test',
    ]);
    expect(result).toMatchObject({ artifactId: 'artifact_1' });

    const missing = recordingClient(() => jsonResponse({ artifactId: 'artifact_1' }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: missing.fetchMock });
    await expect(client.uploadWorkerArtifact('scale', 'run_1', 'worker_1', { attemptId: 'attempt_1', kind: 'log', body: 'x' }))
      .rejects.toThrow('upload URL is missing');
  });

  it('VAL-SDK-035: uploadWorkerArtifact omits sizeBytes when body size is indeterminable', async () => {
    const stream = new ReadableStream();
    const { calls } = await capture((c) => c.uploadWorkerArtifact('scale', 'run_1', 'worker_1', {
      attemptId: 'attempt_1', kind: 'log', body: stream as unknown as BodyInit, metadata: { note: 'streamed' },
    }));
    const createBody = calls[0].body as { metadata?: Record<string, unknown> };
    expect(createBody.metadata).toEqual({ note: 'streamed' });
    expect(createBody.metadata).not.toHaveProperty('sizeBytes');
  });

  it('VAL-SDK-036: listRunArtifacts GET …/runs/{runId}/artifacts with items ?? artifacts ?? []', async () => {
    const { calls, result } = await capture((c) => c.listRunArtifacts('scale', 'run_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/artifacts`);
    expect(result).toMatchObject([{ artifactId: 'artifact_run' }]);

    const empty = recordingClient(() => jsonResponse({}));
    await expect(createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: empty.fetchMock }).listRunArtifacts('scale', 'run_1')).resolves.toEqual([]);
  });

  it('VAL-SDK-037: listWorkerArtifacts GET …/workers/{workerId}/artifacts with items ?? artifacts ?? []', async () => {
    const { calls, result } = await capture((c) => c.listWorkerArtifacts('scale', 'run_1', 'worker_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/artifacts`);
    expect(result).toMatchObject([{ artifactId: 'artifact_worker' }]);
  });

  it('VAL-SDK-038: getBenchmarkResults GET /benchmarks/{slug}/results?limit=', async () => {
    const { calls, result } = await capture((c) => c.getBenchmarkResults('scale', { limit: 5 }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/results?limit=5`);
    expect(result).toMatchObject({ benchmark: { slug: 'scale' } });
  });

  it('VAL-SDK-039: getRunResults GET …/runs/{runId}/results', async () => {
    const { calls, result } = await capture((c) => c.getRunResults('scale', 'run_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/results`);
    expect(result).toMatchObject({ run: { id: 'run_1' }, participants: [], steps: [] });
  });

  it('VAL-SDK-040: getRunTaskResults GET …/results/tasks with only defined params', async () => {
    const both = await capture((c) => c.getRunTaskResults('scale', 'run_1', { bucketSize: 10, failureLimit: 2 }));
    expect(`${both.calls[0].method} ${both.calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/results/tasks?bucketSize=10&failureLimit=2`);

    const partial = await capture((c) => c.getRunTaskResults('scale', 'run_1', { bucketSize: 10 }));
    expect(partial.calls[0].url).toBe(`${BASE}/benchmarks/scale/runs/run_1/results/tasks?bucketSize=10`);

    const none = await capture((c) => c.getRunTaskResults('scale', 'run_1'));
    expect(none.calls[0].url).toBe(`${BASE}/benchmarks/scale/runs/run_1/results/tasks`);
    expect(both.result).toMatchObject({ bucketSize: 10 });
  });

  it('VAL-SDK-041: getRunTimeline GET …/results/timeline?bucketMs=', async () => {
    const { calls, result } = await capture((c) => c.getRunTimeline('scale', 'run_1', { bucketMs: 1000 }));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/results/timeline?bucketMs=1000`);
    expect(result).toMatchObject({ eventRate: { bucketMs: 1000 } });
  });

  it('VAL-SDK-042: getRunImports GET …/results/imports', async () => {
    const { calls, result } = await capture((c) => c.getRunImports('scale', 'run_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/results/imports`);
    expect(result).toMatchObject({ summary: { eventBatches: 0 }, items: [] });
  });

  it('VAL-SDK-043: getRunProgress GET …/runs/{runId}/progress returns the full RunProgress', async () => {
    const { calls, result } = await capture((c) => c.getRunProgress('scale', 'run_1'));
    expect(`${calls[0].method} ${calls[0].url}`).toBe(`GET ${BASE}/benchmarks/scale/runs/run_1/progress`);
    expect(result).toMatchObject({
      summary: { status: 'in_progress' },
      freshnessWindowSeconds: 15,
      participants: [{ slug: 'e2b' }],
    });
  });

  it('VAL-SDK-044: runWorker with no assignment returns an empty result set', async () => {
    const direct = recordingClient(() => jsonResponse({ assignment: null }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: direct.fetchMock });
    const result = await client.runWorker(
      { benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', task: async () => undefined },
    );
    expect(result).toEqual({ assignment: null, records: [] });
    expect(direct.calls).toHaveLength(1);
    expect(direct.calls[0].url).toContain('/workers/claim');
  });
});

// ---------------------------------------------------------------------------
// Input validation — VAL-SDK-045 .. VAL-SDK-049
// ---------------------------------------------------------------------------
describe('input validation', () => {
  it('VAL-SDK-045: sendTaskResults rejects more than 5000 records', async () => {
    const guard = recordingClient(() => jsonResponse({}));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: guard.fetchMock });
    await expect(client.sendTaskResults({
      benchmarkSlug: 'scale', runId: 'run_1', workerId: 'worker_1', attemptId: 'attempt_1',
      sequenceNumber: 0, isFinal: false,
      records: Array.from({ length: 5001 }, (_, taskIndex) => ({ taskIndex, status: 'success' })),
    })).rejects.toThrow('5000');
    expect(guard.calls).toHaveLength(0);
  });

  it('VAL-SDK-046: sendTaskResults rejects more than 100 steps per record', async () => {
    const guard = recordingClient(() => jsonResponse({}));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: guard.fetchMock });
    await expect(client.sendTaskResults({
      benchmarkSlug: 'scale', runId: 'run_1', workerId: 'worker_1', attemptId: 'attempt_1',
      sequenceNumber: 0, isFinal: false,
      records: [{ taskIndex: 0, status: 'success', steps: Array.from({ length: 101 }, (_, i) => ({ name: `s${i}`, status: 'success' as const })) }],
    })).rejects.toThrow('100');
  });

  it('VAL-SDK-047: heartbeatWorker rejects more than 20 concurrency samples', async () => {
    const guard = recordingClient(() => jsonResponse({}));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: guard.fetchMock });
    await expect(client.heartbeatWorker('scale', 'run_1', 'worker_1', {
      attemptId: 'attempt_1',
      concurrency: Array.from({ length: 21 }, (_, i) => ({ step: `s${i}`, active: 1, target: 1 })),
    })).rejects.toThrow('20');
    expect(guard.calls).toHaveLength(0);
  });

  it('VAL-SDK-048: heartbeatWorker rejects duplicate concurrency step names', async () => {
    const guard = recordingClient(() => jsonResponse({}));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: guard.fetchMock });
    await expect(client.heartbeatWorker('scale', 'run_1', 'worker_1', {
      attemptId: 'attempt_1',
      concurrency: [{ step: 'pause', active: 1, target: 1 }, { step: 'pause', active: 2, target: 2 }],
    })).rejects.toThrow('unique');
  });

  it('VAL-SDK-049: runWorker validates concurrency/batchSize/flushIntervalMs and falls back to assignment.targetConcurrency', async () => {
    const okClaim = () => jsonResponse({ assignment: makeAssignment({ targetConcurrency: 1 }) });
    const c1 = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: recordingClient(okClaim).fetchMock });
    await expect(c1.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', concurrency: 0, task: async () => undefined })).rejects.toThrow('concurrency');
    const c2 = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: recordingClient(okClaim).fetchMock });
    await expect(c2.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', concurrency: 1, batchSize: 5001, task: async () => undefined })).rejects.toThrow('batchSize');
    const c3 = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: recordingClient(okClaim).fetchMock });
    await expect(c3.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', concurrency: 1, flushIntervalMs: 0, task: async () => undefined })).rejects.toThrow('flushIntervalMs');

    // Fallback: an invalid assignment.targetConcurrency surfaces the concurrency error.
    const badTarget = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: recordingClient(() => jsonResponse({ assignment: makeAssignment({ targetConcurrency: 0 }) })).fetchMock });
    await expect(badTarget.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', task: async () => undefined })).rejects.toThrow('concurrency');
  });
});

// ---------------------------------------------------------------------------
// runWorker lifecycle & task execution — VAL-SDK-050 .. VAL-SDK-061
// ---------------------------------------------------------------------------
describe('runWorker lifecycle and task execution', () => {
  function lifecycleResponder(overrides: Partial<BenchmarkAssignment> = {}, opts: { eventStatus?: number } = {}) {
    return (url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment(overrides) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, opts.eventStatus ?? 202);
      if (url.endsWith('/heartbeat')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/fail')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/progress')) return jsonResponse(progressResponse());
      throw new Error(`unexpected request: ${url}`);
    };
  }

  it('VAL-SDK-050: returns { assignment: null, records: [] } on null claim with no further HTTP', async () => {
    const { calls, fetchMock } = recordingClient(() => jsonResponse({ assignment: null }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    const result = await client.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', task: async () => undefined });
    expect(result).toEqual({ assignment: null, records: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/workers/claim');
  });

  it('VAL-SDK-051: default worker batch size is 1000', async () => {
    const { calls, fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 1000, count: 1001 }, targetConcurrency: 25 }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', task: async () => undefined });
    const events = calls.filter((c) => c.url.endsWith('/events'));
    expect(events).toHaveLength(2);
    expect((events[0].body as { records: unknown[] }).records).toHaveLength(1000);
    expect((events[1].body as { records: unknown[] }).records).toHaveLength(1);
  });

  it('VAL-SDK-052: flushes partial batches on the flush interval', async () => {
    // Real 1ms/20ms timers are flaky under load; fake timers make the flush
    // interval deterministic. The 1ms flush interval fires before the 20ms task
    // delay resolves, so the first completed record is flushed as a partial
    // (isFinal: false) batch, then the final flush sends the remaining record.
    vi.useFakeTimers();
    try {
      const { calls, fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 1, count: 2 }, targetConcurrency: 1 }));
      const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
      const promise = client.runWorker({
        benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', batchSize: 1000, flushIntervalMs: 1,
        task: async ({ taskIndex }) => { if (taskIndex === 1) await new Promise((r) => setTimeout(r, 20)); },
      });
      // Advance past the 20ms task delay so the flush interval fires and the
      // worker completes. Microtasks (task completion, flush sends) run between
      // timer advances via advanceTimersByTimeAsync.
      await vi.advanceTimersByTimeAsync(20);
      await promise;
      const events = calls.filter((c) => c.url.endsWith('/events'));
      expect(events).toHaveLength(2);
      expect((events[0].body as { records: unknown[]; isFinal: boolean }).records).toHaveLength(1);
      expect((events[0].body as { isFinal: boolean }).isFinal).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('VAL-SDK-052-default-and-unref: defaults flushIntervalMs to 30000 and unrefs the flush interval', async () => {
    // runWorker registers two intervals — a heartbeat and a result flush — and both default to
    // 30000ms and are unref-ed. Pushing the heartbeat onto a distinct 60000ms cadence leaves the
    // 30000ms setInterval call attributable to the flush alone, so the assertions below can prove
    // the flush interval (not the heartbeat) is the one that defaulted to 30000 and got unref-ed.
    const HEARTBEAT_MS = 60_000;
    const unrefedDelays: Array<number | undefined> = [];
    const realSetInterval = globalThis.setInterval;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
        const handle = realSetInterval(handler, delay, ...args);
        const timer = handle as unknown as { unref?: () => unknown };
        const originalUnref = timer.unref?.bind(timer);
        timer.unref = () => {
          unrefedDelays.push(delay);
          return originalUnref?.();
        };
        return handle;
      }) as unknown as typeof setInterval);

    const { fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 0, count: 1 } }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      heartbeatIntervalMs: HEARTBEAT_MS,
      metricsIntervalMs: 0, // isolates the flush interval; metrics sampling also defaults to 30000ms
      task: async () => ({ ok: true }),
    });

    // flushIntervalMs is omitted, so exactly one 30000ms setInterval call — the flush default —
    // is registered (never the custom `1` value exercised by VAL-SDK-052 above), while the
    // heartbeat lands on its own 60000ms cadence.
    const delays = setIntervalSpy.mock.calls.map((call) => call[1]);
    expect(delays.filter((delay) => delay === 30000)).toHaveLength(1);
    expect(delays).toContain(HEARTBEAT_MS);
    expect(delays).not.toContain(1);

    // The flush interval handle (the 30000ms one) is unref-ed so it never keeps the loop alive.
    expect(unrefedDelays).toContain(30000);
  });

  it('VAL-SDK-052-flush-handle-isolation: unrefs the exact 30000ms flush handle, distinct from the heartbeat handle', async () => {
    // Correlate each setInterval registration with the specific handle returned and whether that
    // exact handle was unref-ed. With the heartbeat pushed to 60000ms, this proves the unref lands
    // on the flush handle itself rather than incidentally on the same-cadence heartbeat handle.
    const HEARTBEAT_MS = 60_000;
    const registrations: Array<{ delay: number | undefined; handle: unknown; unrefed: boolean }> = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
      const handle = realSetInterval(handler, delay, ...args);
      const registration = { delay, handle, unrefed: false };
      registrations.push(registration);
      const timer = handle as unknown as { unref?: () => unknown };
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        registration.unrefed = true;
        return originalUnref?.();
      };
      return handle;
    }) as unknown as typeof setInterval);

    const { fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 0, count: 1 } }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      heartbeatIntervalMs: HEARTBEAT_MS,
      metricsIntervalMs: 0, // isolates the flush interval; metrics sampling also defaults to 30000ms
      task: async () => ({ ok: true }),
    });

    const flushRegistrations = registrations.filter((r) => r.delay === 30000);
    expect(flushRegistrations).toHaveLength(1);
    expect(flushRegistrations[0].unrefed).toBe(true);

    const heartbeatRegistrations = registrations.filter((r) => r.delay === HEARTBEAT_MS);
    expect(heartbeatRegistrations).toHaveLength(1);
    expect(heartbeatRegistrations[0].handle).not.toBe(flushRegistrations[0].handle);
  });

  it('VAL-SDK-053: sends a final flush with isFinal: true', async () => {
    const { calls, fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 0, count: 1 } }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', task: async () => ({ ok: true }) });
    const events = calls.filter((c) => c.url.endsWith('/events'));
    expect(events.at(-1)).toBeDefined();
    expect((events.at(-1)!.body as { isFinal: boolean }).isFinal).toBe(true);
  });

  it('VAL-SDK-054: heartbeats concurrency samples capped at 20, sorted by active desc, errors swallowed', async () => {
    const responder = (url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 }, targetConcurrency: 1 }) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/heartbeat')) return new Response('boom', { status: 500 }); // swallowed
      throw new Error(`unexpected request: ${url}`);
    };
    const { calls, fetchMock } = recordingClient(responder);
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    const result = await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => {
        await Promise.all(Array.from({ length: 25 }, (_, i) => step(`step-${i}`, () => new Promise((r) => setTimeout(r, 5)))));
      },
    });
    expect(result.records).toHaveLength(1);
    const capped = calls.find((c) => c.url.endsWith('/heartbeat') && (c.body as { concurrency?: unknown[] }).concurrency?.length === 20);
    expect(capped).toBeDefined();
    const samples = (capped!.body as { concurrency: WorkerConcurrencySample[] }).concurrency;
    expect(samples).toHaveLength(20);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i - 1].active).toBeGreaterThanOrEqual(samples[i].active);
    }
    expect(calls.some((c) => c.url.includes('/complete'))).toBe(true);
  });

  it('VAL-SDK-055: fails the worker when any task fails', async () => {
    const { calls, fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 0, count: 1 } }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    const result = await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('create', () => { throw new TypeError('boom'); }, { readiness: 'internal' }); },
    });
    expect(result.records[0]).toMatchObject({ status: 'error', errorCode: 'TypeError' });
    const failCall = calls.find((c) => c.url.includes('/fail'));
    expect(failCall).toBeDefined();
    expect(failCall!.url).toContain('/fail');
    expect(failCall!.body).toMatchObject({ errorMessage: 'One or more tasks failed' });
  });

  it('VAL-SDK-056: completes the worker when all tasks succeed', async () => {
    const { calls, fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 0, count: 1 } }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({ benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b', task: async () => ({ ok: true }) });
    // Not asserted as the *last* call: the system-metrics upload (on by
    // default) can land after /complete in the finally block.
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(true);
  });

  it('VAL-SDK-057: runs onFinish before completing/failing the worker', async () => {
    const order: string[] = [];
    const responder = (url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 } }) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/complete')) { order.push('complete'); return jsonResponse(lifecycleResponse()); }
      throw new Error(`unexpected request: ${url}`);
    };
    const { fetchMock } = recordingClient(responder);
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async () => ({ ok: true }),
      onFinish: async ({ status }) => { order.push(`finish:${status}`); },
    });
    expect(order).toEqual(['finish:success', 'complete']);
  });

  it('VAL-SDK-058: error path flushes, runs onFinish, fails the worker (all swallowed), rethrows, and clears intervals', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const onFinish = vi.fn(async () => { throw new Error('finish boom'); });
    const responder = (url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 } }) });
      if (url.endsWith('/events')) return new Response('server error', { status: 500, statusText: 'Server Error' });
      if (url.endsWith('/fail')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    };
    const { fetchMock } = recordingClient(responder);
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await expect(client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      metricsIntervalMs: 0, // isolates this to the heartbeat + resultFlush intervals under test
      task: async () => ({ ok: true }),
      onFinish,
    })).rejects.toBeInstanceOf(BenchmarkApiError);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(2);
  });

  it('VAL-SDK-059: task record carries taskIndex/status/startedAt/completedAt/latencyMs/steps/data', async () => {
    const { calls, fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 7, end: 7, count: 1 } }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => {
        const created = await step('create', () => ({ sandboxId: 'sbx' }), { readiness: 'internal' });
        return created;
      },
    });
    const record = (calls.find((c) => c.url.endsWith('/events'))!.body as { records: TaskResultRecord[] }).records[0];
    expect(record).toMatchObject({ taskIndex: 7, status: 'success' });
    expect(record.startedAt).toEqual(expect.any(String));
    expect(record.completedAt).toEqual(expect.any(String));
    expect(record.latencyMs).toEqual(expect.any(Number));
    expect(record.steps).toMatchObject([{ name: 'create', status: 'success' }]);
    expect(record.data).toMatchObject({ sandboxId: 'sbx' });
  });

  it('VAL-SDK-060: step record shape maps errorCode to error.name', async () => {
    const { calls, fetchMock } = recordingClient(lifecycleResponder({ taskRange: { start: 0, end: 0, count: 1 } }));
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('boom', () => { throw new RangeError('nope'); }, { readiness: 'internal' }); },
    });
    const record = (calls.find((c) => c.url.endsWith('/events'))!.body as { records: TaskResultRecord[] }).records[0];
    expect(record.steps![0]).toMatchObject({ name: 'boom', status: 'error', errorCode: 'RangeError' });
    expect(record.errorCode).toBe('RangeError');
  });

  it('VAL-SDK-061: uploads a system-metrics artifact with at least a baseline sample', async () => {
    const responder = (url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 } }) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/heartbeat')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/workers/worker_1/artifacts')) return jsonResponse({ artifactId: 'artifact_1', uploadUrl: 'https://upload.test/metrics' });
      if (url === 'https://upload.test/metrics') return new Response(null, { status: 200 });
      throw new Error(`unexpected request: ${url}`);
    };
    const { calls, fetchMock } = recordingClient(responder);
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    // metricsIntervalMs left at its default (30000, on by default) — the task
    // finishes well inside that window, so no interval sample fires. The
    // baseline (taken alongside the first heartbeat) and the final sample (in
    // the finish path) are still captured, so the artifact is never empty.
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async () => ({ ok: true }),
    });

    const create = calls.find((c) => c.url.endsWith('/workers/worker_1/artifacts') && c.method === 'POST');
    expect(create).toBeDefined();
    expect(create!.body).toMatchObject({ kind: 'system-metrics', name: 'metrics.jsonl', contentType: 'application/x-ndjson' });

    const upload = calls.find((c) => c.url === 'https://upload.test/metrics' && c.method === 'PUT');
    expect(upload).toBeDefined();
    // Multiple samples make the body multi-line NDJSON (not a lone JSON object),
    // so parseBody leaves it as a string here — parse the first line ourselves.
    const lines = String(upload!.body).trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0])).toMatchObject({ loadavg1m: expect.any(Number), memRssMb: expect.any(Number) });
  });

});

// ---------------------------------------------------------------------------
// worker engine step semantics (readiness / concurrency) — VAL-SDK-066 .. VAL-SDK-070
// ---------------------------------------------------------------------------
describe('worker engine step semantics', () => {
  it('VAL-SDK-066: step reportConcurrency defaults to true (opt out removes the sample)', async () => {
    const responder = (url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 }, targetConcurrency: 1 }) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/heartbeat')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    };
    const reported = recordingClient(responder);
    await createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: reported.fetchMock }).runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('tracked', () => new Promise((r) => setTimeout(r, 3))); },
    });
    expect(reported.calls.some((c) => c.url.endsWith('/heartbeat') && (c.body as { concurrency?: WorkerConcurrencySample[] }).concurrency?.some((s) => s.step === 'tracked'))).toBe(true);

    const silent = recordingClient(responder);
    await createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: silent.fetchMock }).runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('silent', () => new Promise((r) => setTimeout(r, 3)), { reportConcurrency: false }); },
    });
    expect(silent.calls.some((c) => c.url.endsWith('/heartbeat') && (c.body as { concurrency?: WorkerConcurrencySample[] }).concurrency?.some((s) => s.step === 'silent'))).toBe(false);
  });

  it('VAL-SDK-067: readiness "poll" waits for the platform ready signal and throws on timeout', async () => {
    const responder = (url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 }, targetConcurrency: 1 }) });
      if (url.endsWith('/progress')) return jsonResponse(progressResponse({ step: 'pause', ready: false }));
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/fail')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/heartbeat')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    };
    const { calls, fetchMock } = recordingClient(responder);
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    const result = await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('pause', () => undefined, { readiness: 'poll', readyPollIntervalMs: 1, readyTimeoutMs: 0 }); },
    });
    expect(calls.some((c) => c.url.endsWith('/progress'))).toBe(true);
    expect(result.records[0]).toMatchObject({ status: 'error' });
    expect(result.records[0].data).toMatchObject({ errorMessage: expect.stringContaining('Timed out') });
  });

  it('VAL-SDK-068: readiness "internal" (default) never polls progress', async () => {
    const { calls, fetchMock } = recordingClient((url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 } }) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/heartbeat')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    });
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('a', () => undefined); },
    });
    expect(calls.some((c) => c.url.endsWith('/progress'))).toBe(false);
  });

  it('VAL-SDK-069: readiness polling is deduplicated across concurrent tasks (readyWaitByStep)', async () => {
    const { calls, fetchMock } = recordingClient((url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 4, count: 5 }, targetConcurrency: 5 }) });
      if (url.endsWith('/progress')) return jsonResponse(progressResponse({ step: 'pause', ready: true }));
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/heartbeat')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    });
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('pause', () => undefined, { readiness: 'poll', readyPollIntervalMs: 1 }); },
    });
    expect(calls.filter((c) => c.url.endsWith('/progress'))).toHaveLength(1);
  });

  it('VAL-SDK-070: step.options.concurrency overrides the per-step target', async () => {
    const { calls, fetchMock } = recordingClient((url: string) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 }, targetConcurrency: 2 }) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      if (url.endsWith('/heartbeat')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    });
    const client = createBenchmarkClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchMock });
    await client.runWorker({
      benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b',
      task: async ({ step }) => { await step('custom', () => new Promise((r) => setTimeout(r, 3)), { concurrency: 7 }); },
    });
    const sample = calls
      .flatMap((c) => (c.url.endsWith('/heartbeat') ? (c.body as { concurrency?: WorkerConcurrencySample[] }).concurrency ?? [] : []))
      .find((s) => s.step === 'custom');
    expect(sample?.target).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// BenchmarkReporter — VAL-SDK-073 .. VAL-SDK-085
// ---------------------------------------------------------------------------
describe('BenchmarkReporter', () => {
  const reporterConfig = { baseUrl: BASE, benchmarkSlug: 'scale', runId: 'run_1', participantSlug: 'e2b' };

  async function claim(responder: (url: string, method: string, init?: RequestInit) => Response | Promise<Response>, extra: Record<string, unknown> = {}) {
    const { calls, fetchMock } = recordingClient(responder);
    const reporter = await BenchmarkReporter.claim({ ...reporterConfig, fetch: fetchMock, ...extra });
    return { reporter, calls };
  }

  it('VAL-SDK-073: claim returns null on null assignment and swallows claim errors', async () => {
    const nullClaim = await claim(() => jsonResponse({ assignment: null }));
    expect(nullClaim.reporter).toBeNull();
    const errorClaim = await claim(() => new Response('boom', { status: 500 }));
    expect(errorClaim.reporter).toBeNull();
  });

  it('VAL-SDK-074: claim passes processKind and processKey', async () => {
    const { calls } = await claim(() => jsonResponse({ assignment: makeAssignment() }), { processKind: 'vitest', processKey: 'key_1' });
    expect(calls[0].body).toMatchObject({ processKind: 'vitest', processKey: 'key_1' });
  });

  it('VAL-SDK-075: getters expose workerAssignment, taskCount, and taskIndexStart', async () => {
    const { reporter } = await claim(() => jsonResponse({ assignment: makeAssignment({ taskRange: { start: 10, end: 12, count: 3 } }) }));
    expect(reporter).not.toBeNull();
    expect(reporter!.workerAssignment.workerId).toBe('worker_1');
    expect(reporter!.taskCount).toBe(3);
    expect(reporter!.taskIndexStart).toBe(10);
  });

  it('VAL-SDK-076: setProgress defaults total from assignment.taskRange.count', async () => {
    const seen: unknown[] = [];
    const { reporter } = await claim((url, _method, init) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 3, count: 4 } }) });
      if (url.endsWith('/heartbeat')) { seen.push(parseBody(init)); return jsonResponse(lifecycleResponse()); }
      throw new Error(`unexpected request: ${url}`);
    });
    reporter!.setProgress({ done: 1, inFlight: 2, errors: 0 });
    await reporter!.heartbeat();
    expect(seen[0]).toMatchObject({ progressTotal: 4, progressDone: 1 });
  });

  it('VAL-SDK-077: recordResult auto-flushes at the batch size', async () => {
    const { reporter, calls } = await claim((url) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 3, count: 4 } }) });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      throw new Error(`unexpected request: ${url}`);
    });
    for (let i = 0; i < 500; i++) reporter!.recordResult({ taskIndex: i, status: 'success', latencyMs: 1 });
    await reporter!.flush(false);
    const events = calls.filter((c) => c.url.endsWith('/events'));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0].body as { records: unknown[] }).records).toHaveLength(500);
  });

  it('VAL-SDK-078: heartbeat swallows errors and includes barrier state during waitForStepReady', async () => {
    const { reporter, calls } = await claim((url) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment() });
      if (url.endsWith('/heartbeat')) return new Response('boom', { status: 500 }); // swallowed
      if (url.endsWith('/progress')) return jsonResponse(progressResponse({ step: 'pause', ready: true }));
      throw new Error(`unexpected request: ${url}`);
    });
    await expect(reporter!.waitForStepReady({ step: 'pause', timeoutMs: 100, pollIntervalMs: 1 })).resolves.toMatchObject({ ready: true });
    const heartbeat = calls.find((c) => c.url.endsWith('/heartbeat'));
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.body).toMatchObject({ currentStep: 'pause' });
    expect((heartbeat!.body as { concurrency?: WorkerConcurrencySample[] }).concurrency?.[0]?.step).toBe('pause');
  });

  it('VAL-SDK-079: waitForStepReady throws on timeout and clears the barrier in finally', async () => {
    const seen: unknown[] = [];
    const { reporter } = await claim((url, _method, init) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment() });
      if (url.endsWith('/heartbeat')) { seen.push(parseBody(init)); return jsonResponse(lifecycleResponse()); }
      if (url.endsWith('/progress')) return jsonResponse(progressResponse({ step: 'pause', ready: false }));
      throw new Error(`unexpected request: ${url}`);
    });
    await expect(reporter!.waitForStepReady({ step: 'pause', timeoutMs: 0, pollIntervalMs: 1 })).rejects.toThrow('Timed out');
    await reporter!.heartbeat();
    expect((seen.at(-1) as { currentStep?: string }).currentStep).toBeUndefined();
  });

  it('VAL-SDK-080: uploadArtifact swallows errors and returns null on failure', async () => {
    const { reporter } = await claim((url) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment() });
      if (url.endsWith('/artifacts')) return new Response('boom', { status: 500 });
      throw new Error(`unexpected request: ${url}`);
    });
    await expect(reporter!.uploadArtifact({ kind: 'log', body: 'x' })).resolves.toBeNull();
  });

  it('VAL-SDK-081: flush sends batches, increments sequenceNumber, and breaks on send error', async () => {
    const okSequences: number[] = [];
    const ok = await claim((url, _method, init) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 1, count: 2 } }) });
      if (url.endsWith('/events')) { okSequences.push((parseBody(init) as { sequenceNumber: number }).sequenceNumber); return jsonResponse({ accepted: 1 }, 202); }
      throw new Error(`unexpected request: ${url}`);
    }, { batchSize: 1 });
    ok.reporter!.recordResult({ taskIndex: 0, status: 'success', latencyMs: 1 });
    ok.reporter!.recordResult({ taskIndex: 1, status: 'success', latencyMs: 1 });
    await ok.reporter!.flush(true);
    expect(okSequences).toEqual([0, 1]);

    const retrySequences: number[] = [];
    let attempts = 0;
    const retry = await claim((url, _method, init) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 0, count: 1 } }) });
      if (url.endsWith('/events')) {
        attempts += 1;
        retrySequences.push((parseBody(init) as { sequenceNumber: number }).sequenceNumber);
        if (attempts === 1) return new Response('temporary', { status: 503 });
        return jsonResponse({ accepted: 1 }, 202);
      }
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    }, { batchSize: 1 });
    retry.reporter!.recordResult({ taskIndex: 0, status: 'success', latencyMs: 1 });
    await retry.reporter!.finish(false);
    expect(retrySequences).toEqual([0, 0]);
  });

  it('VAL-SDK-082: finish(false) flushes then completes (errors swallowed)', async () => {
    const { reporter, calls } = await claim((url) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment() });
      if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
      if (url.endsWith('/complete')) return jsonResponse(lifecycleResponse());
      throw new Error(`unexpected request: ${url}`);
    }, { batchSize: 1 });
    reporter!.recordResult({ taskIndex: 0, status: 'success', latencyMs: 1 });
    await expect(reporter!.finish(false)).resolves.toBeUndefined();
    expect(calls.at(-1)!.url).toContain('/complete');
  });

  it('VAL-SDK-083: finish(true) flushes then fails (errors swallowed)', async () => {
    const { reporter, calls } = await claim((url) => {
      if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment() });
      if (url.endsWith('/fail')) return new Response('boom', { status: 500 }); // swallowed
      throw new Error(`unexpected request: ${url}`);
    });
    await expect(reporter!.finish(true, new Error('worker failed'))).resolves.toBeUndefined();
    expect(calls.some((c) => c.url.endsWith('/fail'))).toBe(true);
  });

  it('VAL-SDK-084: claimBenchmarkReporter is a functional alias for BenchmarkReporter.claim', async () => {
    const { fetchMock } = recordingClient(() => jsonResponse({ assignment: makeAssignment() }));
    const reporter = await claimBenchmarkReporter({ ...reporterConfig, fetch: fetchMock });
    expect(reporter).toBeInstanceOf(BenchmarkReporter);
  });

  it('VAL-SDK-085: reporter default batch size is 500 (no flush below the threshold)', async () => {
    // Use fake timers so the safety wait is deterministic and never flaky.
    vi.useFakeTimers();
    try {
      const { reporter, calls } = await claim((url) => {
        if (url.endsWith('/workers/claim')) return jsonResponse({ assignment: makeAssignment({ taskRange: { start: 0, end: 3, count: 4 } }) });
        if (url.endsWith('/events')) return jsonResponse({ accepted: 1 }, 202);
        throw new Error(`unexpected request: ${url}`);
      });
      for (let i = 0; i < 499; i++) reporter!.recordResult({ taskIndex: i, status: 'success', latencyMs: 1 });
      await vi.advanceTimersByTimeAsync(5);
      expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null instead of rejecting when credentials are missing', async () => {
    const prevApiKey = process.env.BENCHMARKS_PLATFORM_API_KEY;
    const prevToken = process.env.BENCHMARKS_PLATFORM_TOKEN;
    try {
      delete process.env.BENCHMARKS_PLATFORM_API_KEY;
      delete process.env.BENCHMARKS_PLATFORM_TOKEN;
      const { fetchMock } = recordingClient(() => jsonResponse({ assignment: makeAssignment() }));
      const reporter = await BenchmarkReporter.claim({ ...reporterConfig, fetch: fetchMock });
      expect(reporter).toBeNull();
    } finally {
      if (prevApiKey === undefined) delete process.env.BENCHMARKS_PLATFORM_API_KEY;
      else process.env.BENCHMARKS_PLATFORM_API_KEY = prevApiKey;
      if (prevToken === undefined) delete process.env.BENCHMARKS_PLATFORM_TOKEN;
      else process.env.BENCHMARKS_PLATFORM_TOKEN = prevToken;
    }
  });
});

// ---------------------------------------------------------------------------
// createSystemMetricsCollector — VAL-SDK-086 .. VAL-SDK-089
// ---------------------------------------------------------------------------
describe('createSystemMetricsCollector', () => {
  const SAMPLE_KEYS = [
    'ts', 'uptimeMs', 'cpuUserUs', 'cpuSystemUs', 'memRssMb', 'memHeapUsedMb', 'memHeapTotalMb',
    'memExternalMb', 'eventLoopP50Ms', 'eventLoopP99Ms', 'eventLoopMaxMs', 'loadavg1m', 'loadavg5m',
    'loadavg15m', 'openFds', 'sockstat',
    'hostMemTotalMb', 'hostMemAvailableMb', 'hostCpuUsedUs', 'hostCpuTotalUs',
    'cgroupMemLimitMb', 'cgroupCpuLimitCores',
  ];

  it('VAL-SDK-086: sample() returns a complete 22-field BenchmarkSystemMetricsSample', async () => {
    const collector = createSystemMetricsCollector();
    const sample = await collector.sample();
    collector.stop();
    expect(Object.keys(sample).sort()).toEqual([...SAMPLE_KEYS].sort());
    expect(Object.keys(sample)).toHaveLength(22);
    expect(sample.ts).toEqual(expect.any(String));
    expect(sample.memRssMb).toBeGreaterThan(0);
    expect(sample.eventLoopP99Ms).toEqual(expect.any(Number));
  });

  it('VAL-SDK-087: sample() can be called repeatedly (event loop counters reset per call)', async () => {
    const collector = createSystemMetricsCollector();
    const first = await collector.sample();
    const second = await collector.sample();
    collector.stop();
    expect(first.eventLoopMaxMs).toEqual(expect.any(Number));
    expect(second.eventLoopMaxMs).toEqual(expect.any(Number));
    expect(second.uptimeMs).toBeGreaterThanOrEqual(first.uptimeMs);
  });

  it('VAL-SDK-088: stop() disables the monitor without throwing', async () => {
    const collector = createSystemMetricsCollector();
    await collector.sample();
    expect(() => collector.stop()).not.toThrow();
    expect(typeof collector.stop).toBe('function');
  });

  it('VAL-SDK-089: sockstat, openFds, and the /proc- and cgroup-derived fields gracefully degrade to null off Linux', async () => {
    const collector = createSystemMetricsCollector();
    const sample = await collector.sample();
    collector.stop();
    expect(sample.openFds === null || typeof sample.openFds === 'number').toBe(true);
    expect(sample.sockstat === null || typeof sample.sockstat === 'object').toBe(true);
    for (const key of [
      'hostMemTotalMb', 'hostMemAvailableMb', 'hostCpuUsedUs', 'hostCpuTotalUs',
      'cgroupMemLimitMb', 'cgroupCpuLimitCores',
    ] as const) {
      expect(sample[key] === null || typeof sample[key] === 'number').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Public API surface & type exports — VAL-SDK-090 .. VAL-SDK-094
// ---------------------------------------------------------------------------
describe('public API surface and type exports', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const INTERNAL_TYPES = ['BenchmarkParticipantResultSummary'];

  const RUNNER_DTS_PATH = join(here, '..', '..', '..', 'benchsdk-runner', 'dist', 'index.d.ts');

  function extractExportedNames(dtsSource: string): string[] {
    const names: string[] = [];
    for (const match of dtsSource.matchAll(/export\s+(?:type\s*)?\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?\s*;?/g)) {
      for (let entry of match[1].split(',')) {
        entry = entry.trim();
        if (!entry) continue;
        const name = entry
          .replace(/^type\s+/, '')
          .replace(/\s+as\s+.*/, '')
          .trim();
        names.push(name);
      }
    }
    for (const match of dtsSource.matchAll(/export\s+(?:type\s+(\w+)|interface\s+(\w+))/g)) {
      names.push(match[1] ?? match[2]);
    }
    return names;
  }

  function typeNamesFor(dtsSource: string, valueNames: Set<string>): string[] {
    const all = extractExportedNames(dtsSource);
    const types = all.filter((name) => !valueNames.has(name));
    return [...new Set(types)];
  }

  it('VAL-SDK-090: built barrel re-exports exactly the public type set and excludes internal types', () => {
    const distDecl = readFileSync(join(here, '..', '..', 'dist', 'index.d.ts'), 'utf8');
    const runnerDecl = readFileSync(RUNNER_DTS_PATH, 'utf8');

    const runnerValues = new Set(Object.keys(runnerBarrel));
    const expectedTypes = typeNamesFor(runnerDecl, runnerValues).sort();

    const exportedTypeNames: string[] = [];

    // If the barrel is a compatibility shim, it may use `export *` from
    // @benchsdk/runner. Expand that to the runner's full type surface.
    if (/export\s+\*\s+from\s+['"]@benchsdk\/runner['"]/.test(distDecl)) {
      exportedTypeNames.push(...expectedTypes);
    }

    for (const match of distDecl.matchAll(/export\s+(?:type\s*)?\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?\s*;?/g)) {
      const blockIsTypeOnly = match[0].startsWith('export type {');
      for (let entry of match[1].split(',')) {
        entry = entry.trim();
        if (!entry) continue;
        const name = entry
          .replace(/^type\s+/, '')
          .replace(/\s+as\s+.*/, '')
        .trim();
        const isType = entry.startsWith('type ') || blockIsTypeOnly;
        if (isType) {
          exportedTypeNames.push(name);
        }
      }
    }

    for (const match of distDecl.matchAll(/export\s+(?:type\s+(\w+)|interface\s+(\w+))/g)) {
      exportedTypeNames.push(match[1] ?? match[2]);
    }

    const uniqueExportedTypeNames = [...new Set(exportedTypeNames)].sort();

    expect(uniqueExportedTypeNames).toEqual(expectedTypes);

    for (const name of expectedTypes) {
      const inLocalDecl = new RegExp(`\\b${name}\\b`).test(distDecl);
      const inRunnerDecl = new RegExp(`\\b${name}\\b`).test(runnerDecl);
      expect(inLocalDecl || inRunnerDecl).toBe(true);
    }

    for (const internal of INTERNAL_TYPES) {
      expect(uniqueExportedTypeNames).not.toContain(internal);
    }
  });

  it('VAL-SDK-091: every value export is present on the package barrel', () => {
    const valueNames = Object.keys(barrel);
    expect(valueNames.length).toBeGreaterThan(0);
    for (const name of valueNames) {
      expect((barrel as Record<string, unknown>)[name]).toBeTypeOf('function');
    }
    // Type-only surface compiles (see the _PublicTypeSurface alias above).
    const surfaceProof: _PublicTypeSurface | undefined = undefined;
    expect(surfaceProof).toBeUndefined();
  });

  it('VAL-SDK-091b: createBenchmarkClient preserves the legacy runWorker method', () => {
    const client = (barrel as { createBenchmarkClient: typeof createBenchmarkClient }).createBenchmarkClient();
    expect(client.runWorker).toBeTypeOf('function');
    expect(client.getBenchmark).toBeTypeOf('function');
  });

  it('VAL-SDK-092: package.json exports map, main/module/types, and engines.node are preserved', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@benchsdk/client');
    expect(pkg.main).toBe('./dist/index.cjs');
    expect(pkg.module).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/index.cjs',
    });
    expect(pkg.engines.node).toBe('>=18.0.0');
  });

  it('VAL-SDK-093: exports map points at the CJS + ESM + dts dist shape', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.exports['.'].require).toMatch(/\.cjs$/);
    expect(pkg.exports['.'].import).toMatch(/\.js$/);
    expect(pkg.exports['.'].types).toMatch(/\.d\.ts$/);
  });

});

// ---------------------------------------------------------------------------
// Cross-area HTTP invariants — VAL-CROSS-001 .. VAL-CROSS-004
// ---------------------------------------------------------------------------
describe('cross-area HTTP invariants', () => {
  it('VAL-CROSS-001: HTTP URL paths are byte-identical for every client method', async () => {
    const { calls } = await capture(async (c) => {
      await c.upsertBenchmark('scale', { name: 'Scale' });
      await c.getBenchmark('scale');
      await c.updateBenchmark('scale', { name: 'x' });
      await c.listBenchmarks();
      await c.createRun('scale', { totalTasks: 1, workerCount: 1 });
      await c.listRuns('scale');
      await c.getRun('scale', 'run_1');
      await c.updateRun('scale', 'run_1', {});
      await c.upsertParticipant('scale', 'run_1', 'e2b');
      await c.listParticipants('scale', 'run_1');
      await c.getParticipant('scale', 'run_1', 'e2b');
      await c.updateParticipant('scale', 'run_1', 'e2b', {});
      await c.planWorkers('scale', 'run_1', 'e2b');
      await c.listWorkers('scale', 'run_1', 'e2b');
      await c.getWorker('scale', 'run_1', 'worker_1');
      await c.updateWorker('scale', 'run_1', 'worker_1', {});
      await c.getRunProgress('scale', 'run_1');
      await c.claimWorker('scale', 'run_1', 'e2b');
      await c.releaseWorker('scale', 'run_1', 'worker_1', 'attempt_1');
      await c.heartbeatWorker('scale', 'run_1', 'worker_1', { attemptId: 'attempt_1' });
      await c.completeWorker('scale', 'run_1', 'worker_1', 'attempt_1');
      await c.failWorker('scale', 'run_1', 'worker_1', 'attempt_1', new Error('e'));
      await c.createWorkerArtifact('scale', 'run_1', 'worker_1', { attemptId: 'attempt_1', kind: 'log' });
      await c.listRunArtifacts('scale', 'run_1');
      await c.listWorkerArtifacts('scale', 'run_1', 'worker_1');
      await c.getBenchmarkResults('scale', { limit: 5 });
      await c.getRunResults('scale', 'run_1');
      await c.getRunTaskResults('scale', 'run_1', { bucketSize: 10, failureLimit: 2 });
      await c.getRunTimeline('scale', 'run_1', { bucketMs: 1000 });
      await c.getRunImports('scale', 'run_1');
      await c.submitRunSummary('scale', 'run_1', { run: {}, results: [] });
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PUT ${BASE}/benchmarks/scale`,
      `GET ${BASE}/benchmarks/scale`,
      `PATCH ${BASE}/benchmarks/scale`,
      `GET ${BASE}/benchmarks`,
      `POST ${BASE}/benchmarks/scale/runs`,
      `GET ${BASE}/benchmarks/scale/runs`,
      `GET ${BASE}/benchmarks/scale/runs/run_1`,
      `PATCH ${BASE}/benchmarks/scale/runs/run_1`,
      `PUT ${BASE}/benchmarks/scale/runs/run_1/participants/e2b`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/participants`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/participants/e2b`,
      `PATCH ${BASE}/benchmarks/scale/runs/run_1/participants/e2b`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/participants/e2b/workers`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/participants/e2b/workers`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1`,
      `PATCH ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/progress`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/participants/e2b/workers/claim`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/release`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/heartbeat`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/complete`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/fail`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/artifacts`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/artifacts`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/workers/worker_1/artifacts`,
      `GET ${BASE}/benchmarks/scale/results?limit=5`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/results`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/results/tasks?bucketSize=10&failureLimit=2`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/results/timeline?bucketMs=1000`,
      `GET ${BASE}/benchmarks/scale/runs/run_1/results/imports`,
      `POST ${BASE}/benchmarks/scale/runs/run_1/summary`,
    ]);
  });

  it('VAL-CROSS-002: Authorization: Bearer is preserved and X-Api-Key is never sent', async () => {
    const { calls } = await capture(async (c) => {
      await c.getBenchmark('scale');
      await c.upsertBenchmark('scale', { name: 'x' });
      await c.uploadWorkerArtifact('scale', 'run_1', 'worker_1', { attemptId: 'attempt_1', kind: 'log', body: 'x' });
    });
    for (const call of calls) {
      const keys = Object.keys(call.headers).map((k) => k.toLowerCase());
      expect(keys).not.toContain('x-api-key');
    }
    const apiCalls = calls.filter((call) => call.url.startsWith(BASE));
    for (const call of apiCalls) {
      expect(call.headers.Authorization).toBe('Bearer key_abc');
    }
  });

  it('VAL-CROSS-003: default base URL is https://platform.computesdk.com/api/v1', async () => {
    const { calls, fetchMock } = recordingClient(() => jsonResponse({ benchmark: benchmarkResource() }));
    await createBenchmarkClient({ apiKey: 'k', fetch: fetchMock }).getBenchmark('scale');
    expect(calls[0].url).toBe(`${DEFAULT_BASE_URL}/benchmarks/scale`);
  });

  it('VAL-CROSS-004: integration smoke reads COMPUTESDK_BENCH_BASE_URL and is gated (proven by integration.test.ts)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const integrationSource = readFileSync(join(here, 'integration.test.ts'), 'utf8');
    expect(integrationSource).toContain('process.env.COMPUTESDK_BENCH_BASE_URL');
    expect(integrationSource).toMatch(/const shouldRun = /);
  });
});
