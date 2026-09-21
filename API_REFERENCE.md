# benchsdk → Benchmarks Platform API Reference

The REST calls `@benchsdk/api` makes on behalf of `bench run`, and how each payload carries its data. Traced from `packages/benchsdk-api/src/client.ts` + `types.ts` and the `@benchsdk/worker` / `@benchsdk/runner` call sites.

## Key terms

The data model the API moves between a `*.bench.ts` file and the benchmarks platform. A benchmark run is a tree: **benchmark → run → participant → worker → task → step**.

| Term | What it is | How it is used |
|------|------------|----------------|
| `benchmark` | A registered suite identified by a lowercase `slug` (e.g. `sandbox-tti`). | Upserted once per run with its name plus the `scoring` and `display` manifests from `defineBenchmarkConfig`. Everything else hangs off its slug. |
| `run` | One execution of a benchmark. Carries status, `totalTasks`, and a snapshot of the resolved run config. | Created before any task executes. With a shared `runKey`, sibling processes get-or-create the same run (one CI job per provider). |
| `participant` | One provider under test inside a run (e.g. `e2b`, `modal`). In the bench file: `{ name, requiredEnvVars, ... }`. | Env-gated locally by `requiredEnvVars`; registered on the run with its own `totalTasks` so participant-sized runs know their extent. |
| `worker` | An execution slot planned under a participant, then claimed by a running process. Owns a `taskRange` and a `targetConcurrency`. | `planWorkers` creates pending workers; `claim` binds one to this process and returns an `assignment`. |
| `attemptId` | The id of the worker attempt this process is running. | Sent on every worker-scoped mutation (heartbeat, events, artifacts, complete/fail/release) so stale processes cannot corrupt a reclaimed worker. |
| `task` | One iteration of the workload — one invocation of the function passed to `defineTask`. Persisted as a `TaskResultRecord`. | Runs once per `taskIndex` in the worker's claimed range. Success/failure, timing, steps, and measured data all land on its record. |
| `step` | A named, individually timed sub-operation inside a task (`ctx.step('create', fn)`), persisted as a `TaskStepRecord`. | Each step carries status, latency, optional `data`, and its own `concurrency`/`timeoutMs` metadata. Return values are control flow only — never auto-recorded; an outcome-shaped return (`stdout`/`stderr`/`error`/…) is written to the worker log unless `captureOutput: false`. |
| `measure(data)` | The explicit metric channel. A JSON object of measurements. | Called inside a step it merges into that step's `data`; at task top-level it lands on the task record's `data`. Scoring reads metrics from `record.data`. |
| `log` | Human-readable narration (`ctx.log(msg, { level, meta })`), filtered by `BENCHMARK_LOG_LEVEL` (default `info`). | Buffered per worker and uploaded as a `coordinator.log` / `worker.log` artifact — not inline in task records. |
| `heartbeat` | Periodic liveness + progress report for a claimed worker. | Every ~30s and on step transitions: done/in-flight/error counts, the current step, and per-step concurrency samples used for the run's concurrency timeline. |
| `artifact` | A file attached to a worker (worker log, system metrics, custom output). | Two-step upload: `POST …/artifacts` returns a presigned `uploadUrl`, then the body is `PUT` directly to it. |
| `event batch` | An ordered chunk of task records (`type: 'task_results'`) streamed to the run. | Sent incrementally with a monotonically increasing `sequenceNumber`; the last batch is `isFinal: true`. Batches queue for import into the analytics store. |
| `summary` | The computed scorecard for a run: per-provider metrics, composite score, success rate. | Computed by the runner from `config.scoring`/`onScore` and submitted once after all tasks finish; the platform can recompute it from the same stored spec. |
| `shape` / `phase` / `groupBy` | Runner-side orchestration knobs — not API resources. | `shapes` = named platform identities (slug+name) selected with `--shape`. `phases` = named iteration arms tagged into `record.data.phase`. `groupBy` = task ordering (`'participant'` drives real platform workers; `'round'` interleaves participants via per-participant reporters). |

## Transport & conventions

| Concern | Wire format |
|---------|-------------|
| Base URL | `https://platform.computesdk.com/api/v1` — override with `BENCHMARKS_PLATFORM_URL` (root URL; `/api/v1` is appended). |
| Auth | `Authorization: Bearer <token>` where the token is `BENCHMARKS_PLATFORM_API_KEY` (org-scoped `bp_...`), `BENCHMARKS_PLATFORM_TOKEN` (OAuth), or a stored `bench auth login` token. OAuth requests also send `X-Org-Slug` or `X-Organization-Id`. |
| Body | `Content-Type: application/json`; path params are `encodeURIComponent`-encoded. Non-2xx → `BenchmarkApiError(status, body)`. |
| Limits | Task-result batches ≤ 5000 records; ≤ 100 steps per record; ≤ 20 unique-step concurrency samples per heartbeat. |
| Idempotency | `runKey` on run creation (per org + benchmark); `attemptId` + `sequenceNumber` on every worker mutation and event batch. |

## Write path — what `bench run` calls, in order

`runBenchmark()` issues these calls. In the default `groupBy: 'participant'` path, `runWorker()` owns everything worker-scoped; in `groupBy: 'round'` the runner drives one `BenchmarkReporter` per participant through the same endpoints by hand.

### 1. Upsert the benchmark

`PUT /benchmarks/{slug}`

Materializes the benchmark from the file's identity. Skipped when `--benchmark` retargets a run at a foreign slug (that would rename someone else's benchmark).

```json
{
  "name": "Sandbox TTI (Burst)",
  "config": {
    "scoring":  { /* serializable BenchmarkScoringConfig */ },
    "display":  { /* metric/step labels, units, overview defaults */ }
  }
}
```

### 2. Create (or share) the run

`POST /benchmarks/{slug}/runs`

Two shapes. Self-contained run: declared `totalTasks` + `participants` list. Shared run (`--run-key`): get-or-create by key, *participant-sized* — no `totalTasks`/`participants`; each sibling registers only its own.

```json
{
  "runKey": "1234567890",
  "totalTasks": 6,
  "workerCount": 1,
  "participants": ["e2b", "modal"],
  "config": {
    "benchmarkSlug": "sandbox-tti",
    "iterations": 3,
    "concurrency": 1,
    "staggerDelayMs": 0,
    "groupBy": "participant",
    "participants": ["e2b", "modal"],
    "trigger": { "source": "schedule", "event": "schedule" }
  }
}
```

- `runKey` — optional idempotency key (org + benchmark scoped)
- `totalTasks` — omit → participant-sized run
- `config` — resolved run snapshot: slug, name, iterations, phases, concurrency, staggerDelayMs, groupBy, dimensions, scoring, participants, trigger

Returns `{ run, participants, organizationSlug }`; the runner builds the dashboard URL as `{base}/{org}/benchmarks/{slug}/runs/{runId}`.

### 3. Register participants (shared-run mode)

`PUT /benchmarks/{slug}/runs/{runId}/participants/{participantSlug}`

```json
{ "totalTasks": 6 }
```

Only used with `--run-key`: each sibling process declares just its own provider's task count.

### 4. Plan workers

`POST /benchmarks/{slug}/runs/{runId}/participants/{participantSlug}/workers`

```json
{
  "workerCount": 1,
  "targetConcurrency": 6
}
```

`targetConcurrency` in round mode is the full schedule length — the platform reads it as tasks-per-worker. Creates pending worker rows the participant's processes can claim.

### 5. Claim a worker

`POST /benchmarks/{slug}/runs/{runId}/participants/{participantSlug}/workers/claim`

```json
{ "processKind": "process", "processKey": "ci-runner-01" }
```

Returns the `assignment` (or `null` if nothing is pending):

```json
{
  "workerId": "...",
  "attemptId": "...",
  "attemptNumber": 1,
  "participantSlug": "e2b",
  "taskRange": { "start": 0, "end": 5, "count": 6 },
  "targetConcurrency": 6
}
```

### 6. Heartbeat

`POST /benchmarks/{slug}/runs/{runId}/workers/{workerId}/heartbeat`

```json
{
  "attemptId": "...",
  "progressDone": 3,
  "progressInFlight": 1,
  "progressErrors": 0,
  "progressTotal": 6,
  "currentStep": "exec.task",
  "concurrency": [ { "step": "create", "active": 4, "target": 10 } ]
}
```

~30s cadence plus immediate sends on step transitions; feeds the run's live progress and concurrency timeline. Round mode also calls `reporter.setProgress()` after every task.

### 7. Stream task results

`POST /benchmarks/{slug}/runs/{runId}/workers/{workerId}/events`

Incrementally flushed batches (default every 30s / at 1000 pending records / once at the end with `isFinal: true`):

```json
{
  "type": "task_results",
  "attemptId": "...",
  "sequenceNumber": 0,
  "isFinal": false,
  "records": [
    {
      "taskIndex": 0,
      "status": "success",
      "startedAt": "2026-09-21T10:00:00.000Z",
      "completedAt": "2026-09-21T10:00:02.400Z",
      "latencyMs": 2400,
      "data": { "ttiMs": 2310, "phase": "cold" },
      "steps": [
        {
          "name": "create",
          "status": "success",
          "startedAt": "...",
          "completedAt": "...",
          "latencyMs": 1800,
          "data": { "createMs": 1800 },
          "concurrency": 1,
          "timeoutMs": 120000
        }
      ]
    }
  ]
}
```

- `sequenceNumber` — monotonic per attempt
- `status` — `"success"` or `"error"` + `errorCode`
- `record.data` — top-level `measure()` payloads land here; `step.data` — `measure()` called inside a step

Mapping from authoring code: `ctx.step(name, fn)` → a `steps[]` entry; `ctx.measure(d)` → `step.data` (inside a step) or `record.data` (top level); a thrown `TaskError` → `status: 'error'` + `errorCode`, preserving `data` and pre-measured `steps`; a task with no declared steps becomes one implicit `'task'` step. The phase tag is written to `record.data.phase` before the task runs so failed records still group correctly.

### 8. Upload artifacts (two-step)

`POST /benchmarks/{slug}/runs/{runId}/workers/{workerId}/artifacts`

```json
{
  "attemptId": "...",
  "kind": "coordinator.log",
  "contentType": "text/plain",
  "name": "worker.log",
  "metadata": { "sizeBytes": 42110 }
}
```

`kind` — `"coordinator.log"`, `"system-metrics"`, or a custom kind; `contentType` — `"text/plain"` / `"application/gzip"` / `"application/x-ndjson"`; `metadata.sizeBytes` is auto-filled from the body when measurable.

Response carries `uploadUrl` + `artifactId`; the body is then `PUT` straight to the presigned URL with the declared `Content-Type`. The worker log and the `metrics.jsonl` system-metrics NDJSON both ship this way at finish (and mid-run when log flushing is enabled). Round mode uploads one shared process-scoped metrics artifact with `metadata.scope = "shared-process"` and the full participant list.

### 9. Close the worker

`POST /benchmarks/{slug}/runs/{runId}/workers/{workerId}/{complete|fail|release}`

```json
{ "attemptId": "...", "errorCode": "STORAGE_ERROR", "errorMessage": "…" }
```

`complete` when every task succeeded, `fail` otherwise (`errorCode`/`errorMessage` only on fail), `release` to abandon a claim. A worker whose final flush failed is failed, not completed.

### 10. Submit the run summary

`POST /benchmarks/{slug}/runs/{runId}/summary`

```json
{
  "run": {
    "gitSha": "…",
    "gitRef": "main",
    "triggeredBy": "schedule",
    "nodeVersion": "v24.0.0",
    "platform": "linux",
    "arch": "x64"
  },
  "results": [
    {
      "provider": "e2b",
      "dimensions": { "file_size": "10MB" },
      "metrics": [
        { "name": "ttiMs", "unit": "ms", "median": 2100, "p95": 2600, "p99": 2900 }
      ],
      "compositeScore": 78.4,
      "successRate": 1.0,
      "skipped": false
    }
  ],
  "scoring": { /* the serializable config.scoring spec, echoed for recompute */ }
}
```

- `dimensions` — `config.dimensions` + the `scoring.groupBy` value
- `compositeScore` — Σ per-metric score × weight × successRate, 0–100

Only sent when the config declares `scoring` or `onScore`. A malformed spec (`ScoringSpecError`) fails the run; transport failures degrade to a warning.

## Read path — querying runs and results

These back the `bench` data commands (`bench runs`, `bench results`, `bench artifacts`, `bench export`) and the dashboard.

| Method & path | Returns / params |
|---------------|------------------|
| `GET /benchmarks?limit&offset` | Benchmark list (`items`). |
| `GET /benchmarks/{slug}` · `PATCH` | Benchmark resource / update name, status, config. |
| `GET /benchmarks/{slug}/runs?limit&offset` | Runs for one benchmark. |
| `GET /benchmarks/runs?benchmarkSlug` | All visible runs across benchmarks, including subscribed feeds (Daily). |
| `GET …/runs/{runId}` · `PATCH` | Run detail / update status or config. |
| `GET …/runs/{runId}/progress` | Live status: per-participant task counts, worker freshness, per-step `ready` flags (used by step `readiness: 'poll'` barriers). |
| `GET …/participants/{p}/logs?maxLines` | Participant worker logs. |
| `GET …/participants/{p}/workers` · `GET …/workers/{workerId}` | Worker rows with progress and concurrency samples. |
| `GET …/runs/{runId}/artifacts` · `GET …/workers/{workerId}/artifacts` | Artifact listings. |
| `GET …/workers/{workerId}/artifacts/{artifactId}` | Artifact metadata + presigned `downloadUrl`; the body is then fetched from that URL (auto-gunzipped when the content type is gzip). |
| `GET /benchmarks/{slug}/results?limit&offset` | Cross-run overview with analytics readiness per run. |
| `GET …/runs/{runId}/results` | Aggregate result: overall + per-participant + per-step latency summaries and success rates. |
| `GET …/runs/{runId}/results/tasks?bucketSize&failureLimit` | Task-index buckets (p50/p95/max per bucket) plus the failure points — the scatter/bucket view. |
| `GET …/runs/{runId}/results/timeline?bucketMs` | Event-rate buckets + heartbeat-derived concurrency points over time. |
| `GET …/runs/{runId}/results/imports` | Event-batch ingestion status (queued/persisted/failed per batch). |
| `GET …/runs/{runId}/iterations?type=tasks\|steps&participant&steps` | Raw per-iteration rows — task records or step records, filterable by participant and step names. |

## Sequence — one `bench run` end to end

```text
bench run file.bench.ts --provider e2b --iterations 6
│
├─ PUT  /benchmarks/sandbox-tti                          (identity + scoring/display)
├─ POST /benchmarks/sandbox-tti/runs                     (runKey?, totalTasks, config)
├─ PUT  …/runs/{run}/participants/e2b                    (shared-run mode only)
├─ POST …/participants/e2b/workers                       (planWorkers)
│
│   per participant (groupBy 'participant'), or interleaved per round:
│   ├─ POST …/participants/e2b/workers/claim             → assignment{workerId, attemptId, taskRange}
│   │   loop over taskRange:
│   │     POST …/workers/{w}/heartbeat   (every 30s + on step transitions)
│   │     POST …/workers/{w}/events      (task_results batches; last has isFinal)
│   │   finish:
│   │     POST …/workers/{w}/artifacts   → PUT body to uploadUrl  (worker.log, metrics.jsonl)
│   │     POST …/workers/{w}/complete|fail
│
└─ POST …/runs/{run}/summary                             (scored results)
```

With `--dry-run` / `--no-ingest` / `BENCHSDK_NO_INGEST=1` none of these calls are made — the schedule executes locally and records are kept in memory for `onComplete`. Platform auth is still resolved up front.
