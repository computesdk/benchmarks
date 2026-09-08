# @benchsdk/client

> **Backwards-compatibility shim.** `@benchsdk/client` re-exports the full `@benchsdk/runner` surface and preserves the legacy `createBenchmarkClient().runWorker(options)` spelling. New projects should import from `@benchsdk/runner` for authoring/operator helpers or `@benchsdk/api` for raw REST types.

Client and worker helpers for the ComputeSDK benchmark orchestrator.

This package talks to the platform-owned benchmark/run/participant/worker API. It does not mint canonical run, worker, attempt, event, or task IDs. Workers claim platform-assigned work, execute task indexes in their assigned range, and send `task_results` batches back to the platform.

## Installation

```bash
npm install @benchsdk/client
```

> Higher-level benchmark authoring (`defineBenchmarkConfig` / `defineTask` and
> the local orchestrator) lives in
> [`@benchsdk/runner`](../benchsdk-runner). This package is REST transport plus
> the worker engine only.

## Authentication

`createBenchmarkClient` requires a platform API key or OAuth token. Provide
`apiKey`/`token` directly, or set `BENCHMARKS_PLATFORM_API_KEY` or
`BENCHMARKS_PLATFORM_TOKEN` in the environment.

## Run A Worker

```ts
import { createBenchmarkClient } from '@benchsdk/client';
import { compute } from 'computesdk';

const client = createBenchmarkClient({
  apiKey: process.env.BENCHMARKS_PLATFORM_API_KEY,
});

// `task` is a raw function; declare named steps imperatively via `step(...)`,
// so values flow between steps with closures and cleanup runs in a `finally`.
const { assignment, records } = await client.runWorker({
  benchmarkSlug: 'scale',
  runId: process.env.BENCHMARK_RUN_ID!,
  participantSlug: 'e2b',
  processKind: 'container',
  processKey: process.env.HOSTNAME,
  concurrency: 100,
  task: async ({ assignment, step }) => {
    const sandbox = await step('create', () =>
      compute.sandbox.create({ provider: assignment.provider ?? 'e2b' }),
    );
    try {
      await step('readiness', () => sandbox.runCommand('true'), { readiness: 'internal' });
      await step('exec.first-command', () => sandbox.runCommand('node -v'));
      // A `readiness: 'poll'` step reports active concurrency and waits until
      // the platform reports the participant's step is ready (a barrier).
      await step('pause', () => {}, { readiness: 'poll' });
      return { sandboxId: sandbox.id };
    } finally {
      await step('destroy', () => sandbox.destroy());
    }
  },
});
```

`client.runWorker(...)` claims the next pending platform assignment for the participant. If no work is available, it returns `{ assignment: null, records: [] }`.

Task results are flushed to the platform in batches of 1,000 records by default. Set `batchSize` to tune this per worker; the SDK validates the platform limit of 5,000 records per batch. Workers also flush partial batches every 30 seconds by default via `flushIntervalMs`, and always flush pending records during final completion or shutdown.

## Create A Platform Run

```ts
import { createBenchmarkClient } from '@benchsdk/client';

const client = createBenchmarkClient({
  apiKey: process.env.BENCHMARKS_PLATFORM_API_KEY,
});

await client.upsertBenchmark('scale', {
  name: 'Scale',
  config: { timeoutMs: 120_000 },
});

const { run } = await client.createRun('scale', {
  name: '10k smoke',
  totalTasks: 10_000,
  workerCount: 20,
  participants: ['e2b', 'modal'],
  config: { timeoutMs: 120_000 },
});

await client.planWorkers('scale', run.id, 'e2b');
await client.planWorkers('scale', run.id, 'modal');

console.log(run.id);
```

Workers must be planned before `client.runWorker(...)` can claim assignments.

## API

### Worker Engine

```ts
client.runWorker(options)
```

The `task` function receives:

| Field | Type | Description |
|-------|------|-------------|
| `assignment` | `BenchmarkAssignment` | Platform-owned assignment for this worker |
| `taskIndex` | `number` | Deterministic task index within the benchmark run |
| `step` | `(name, fn, options?) => Promise<R>` | Runs `fn` as a named platform step and records its timing/outcome |

If the task returns a JSON object, it is stored as the task result `data`.

`step(name, fn, options)` supports step-level progress coordination via `options`:

| Option | Type | Description |
|--------|------|-------------|
| `reportConcurrency` | `boolean?` | Include active count for this step in worker heartbeats. Defaults to `true` |
| `concurrency` | `number?` | Per-worker target for this step. Defaults to worker concurrency/assignment target |
| `readiness` | `'poll' \| 'internal'?` | Readiness coordination mode. Defaults to `'internal'`. Use `'poll'` for platform-coordinated barrier steps |
| `readyPollIntervalMs` | `number?` | Poll interval while waiting. Defaults to `1000` |
| `readyTimeoutMs` | `number?` | Maximum readiness wait time |

### Low-Level Client

```ts
client.updateBenchmark(benchmarkSlug, input)
client.updateRun(benchmarkSlug, runId, input)
client.updateParticipant(benchmarkSlug, runId, participantSlug, input)
client.planWorkers(benchmarkSlug, runId, participantSlug)
client.getWorker(benchmarkSlug, runId, workerId)
client.updateWorker(benchmarkSlug, runId, workerId, input)
client.claimWorker(benchmarkSlug, runId, participantSlug, { processKind, processKey })
client.sendTaskResults({ benchmarkSlug, runId, workerId, attemptId, sequenceNumber, isFinal, records })
client.uploadWorkerArtifact(benchmarkSlug, runId, workerId, {
  attemptId,
  kind: 'log',
  name: 'coordinator.log',
  contentType: 'text/plain; charset=utf-8',
  body: logText,
})
client.heartbeatWorker(benchmarkSlug, runId, workerId, {
  attemptId,
  currentStep: 'pause',
  concurrency: [{ step: 'pause', active: 100, target: 100 }],
})
client.getRunProgress(benchmarkSlug, runId)
client.getBenchmarkResults(benchmarkSlug, { limit })
client.getRunResults(benchmarkSlug, runId)
client.getRunTaskResults(benchmarkSlug, runId, { bucketSize, failureLimit })
client.getRunTimeline(benchmarkSlug, runId, { bucketMs })
client.getRunImports(benchmarkSlug, runId)
client.completeWorker(benchmarkSlug, runId, workerId, attemptId)
client.failWorker(benchmarkSlug, runId, workerId, attemptId, error)
client.runWorker(options)
```

For custom coordinators that do not fit `runWorker`, use the best-effort reporter wrapper:

```ts
const reporter = await BenchmarkReporter.claim({
  benchmarkSlug: 'scale',
  runId,
  participantSlug: 'e2b',
  processKind: 'container',
  processKey: instanceId,
});

reporter?.setProgress({ done, inFlight, errors });
reporter?.recordResult(record);
await reporter?.waitForStepReady({ step: 'ready.barrier', timeoutMs: 15 * 60_000 });
await reporter?.uploadArtifact({
  kind: 'log',
  name: 'coordinator.log',
  contentType: 'text/plain; charset=utf-8',
  body: logText,
});
await reporter?.finish(false);
```

`BenchmarkReporter` swallows platform telemetry failures for claim, heartbeat, result flushing, artifact upload, and finish calls. Benchmark work can continue even when reporting is temporarily unavailable.

For `runWorker`, use `onFinish` to upload worker-level logs once, after final task results are flushed and before the worker attempt is completed or failed:

```ts
client.runWorker({
  benchmarkSlug: 'scale',
  runId,
  participantSlug: 'e2b',
  task,
  onFinish: async ({ uploadArtifact }) => {
    await uploadArtifact({
      kind: 'log',
      name: 'coordinator.log',
      contentType: 'text/plain; charset=utf-8',
      body: logText,
    });
  },
});
```

For coordinator health artifacts, sample system metrics:

```ts
const metrics = createSystemMetricsCollector();
const samples = [await metrics.sample()];
metrics.stop();
```

`client.getRunProgress(...)` returns a run summary plus per-participant worker, task, and concurrency progress:

```ts
const progress = await client.getRunProgress('scale', runId);

console.log(progress.summary.status);
console.log(progress.summary.participants);

const participant = progress.participants.find((item) => item.slug === 'e2b');
console.log(participant?.status);
console.log(participant?.workers);
console.log(participant?.tasks.completionRatio);
console.log(participant?.concurrency.find((item) => item.step === 'pause')?.ready);
```

Most workers should use `client.runWorker(...)`.

## Task Result Shape

```json
{
  "taskIndex": 0,
  "status": "success",
  "startedAt": "2026-06-03T00:00:00.000Z",
  "completedAt": "2026-06-03T00:00:01.000Z",
  "latencyMs": 1000,
  "steps": [
    { "name": "create", "status": "success", "startedAt": "...", "completedAt": "...", "latencyMs": 700 },
    { "name": "exec.first-command", "status": "success", "startedAt": "...", "completedAt": "...", "latencyMs": 120 },
    { "name": "destroy", "status": "success", "startedAt": "...", "completedAt": "...", "latencyMs": 180 }
  ],
  "data": {
    "sandboxId": "..."
  }
}
```
