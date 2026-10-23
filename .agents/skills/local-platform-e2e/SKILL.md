---
name: local-platform-e2e
description: Stand up benchmarks-platform locally (Postgres + MinIO + ClickHouse in docker) and run a real @benchsdk/runner benchmark against it, with no cloud or provider credentials. Use when testing @benchsdk/client / @benchsdk/runner against the platform end to end, or when debugging benchmark reporting, worker planning, artifacts, or dashboard results locally.
---

# Local end-to-end: @benchsdk/runner ↔ benchmarks-platform

Goal: exercise upsert benchmark → create run → planWorkers → claim → heartbeat →
task_results → artifact upload → complete → dashboard, with zero external
credentials.

## 1. Infra (docker)

```bash
docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bench postgres:16
docker run -d --name minio -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data
docker run -d --name ch -p 8123:8123 -e CLICKHOUSE_PASSWORD=chpass clickhouse/clickhouse-server:25.6
docker run --rm --network host --entrypoint sh quay.io/minio/mc -c \
  "mc alias set local http://127.0.0.1:9000 minioadmin minioadmin && mc mb -p local/bench"
```

Substitutes when images or ports aren't available:

- **Postgres port taken** (a host postgres already on 5432): use it —
  `DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/ci` (the CI creds; the `ci`
  database works when `CREATE DATABASE` is denied).
- **MinIO image won't pull** (`pull access denied` / quay 401): `s3rver` is a
  drop-in — `npx -y s3rver -p 9000 -a 0.0.0.0 --directory ~/s3data`, then
  `AWS_ACCESS_KEY_ID=S3RVER AWS_SECRET_ACCESS_KEY=S3RVER aws --endpoint-url
  http://127.0.0.1:9000 s3 mb s3://bench` and set `TIGRIS_ACCESS_KEY_ID`/
  `TIGRIS_SECRET_ACCESS_KEY=S3RVER` in `.env.local`.
- **`npm run db:migrate` says `DATABASE_URL ... is not set`**: it doesn't read
  `.env.local` — run with `set -a; . ./.env.local; set +a; npm run db:migrate`.
- **Minting `/mcp` access tokens** for MCP E2E: insert a `jwks` row (EdDSA
  keypair, both JWKs stored), an `oauth_client` row, and an `oauth_consent`
  row (clientId + userId + referenceId=orgId, non-null `scopes`), then sign an
  `at+jwt` (kid = the jwks row id) with claims `sub`=user, `client_id`, `org`,
  `scope`, iss=`$BETTER_AUTH_URL/api/auth`, aud=`$BETTER_AUTH_URL/mcp` — see
  `lib/oauth/tokens.ts` `verifyAccessToken` for the exact shape.

- Use ClickHouse **>= 25.x**: 24.8 fails `ch:migrate` with
  `TTL expression result column should have DateTime or Date type, but has DateTime64(3,'UTC')`.
- The importer passes `clickhouse_settings: { date_time_input_format: 'best_effort' }`
  per insert, so a default-configured server works. If you hit
  `Cannot parse input: expected '"' before: 'Z"...'` (older code), work around it
  server-side, and remember to REMOVE the override before verifying an importer
  fix — otherwise the server setting masks it:
  ```bash
  docker exec ch bash -c 'mkdir -p /etc/clickhouse-server/users.d && printf "<clickhouse><profiles><default><date_time_input_format>best_effort</date_time_input_format></default></profiles></clickhouse>" > /etc/clickhouse-server/users.d/besteffort.xml'
  docker restart ch
  # verify which mode is actually active:
  curl -s "http://127.0.0.1:8123/?user=default&password=chpass" \
    --data-binary "SELECT value FROM system.settings WHERE name='date_time_input_format'"
  ```

## 2. benchmarks-platform `.env.local`

Point `TIGRIS_*` at MinIO — the events and artifacts routes require S3 or they
return 502 on every batch. `region: "auto"` + presigned PUT works with MinIO.

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/bench
DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@127.0.0.1:5432/bench
CLICKHOUSE_URL=http://127.0.0.1:8123
CLICKHOUSE_DATABASE=default
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=chpass
ADMIN_API_KEY=local-admin-key
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=http://localhost:3000
TIGRIS_ACCESS_KEY_ID=minioadmin
TIGRIS_SECRET_ACCESS_KEY=minioadmin
TIGRIS_STORAGE_ENDPOINT=http://127.0.0.1:9000
TIGRIS_BUCKET=bench
```

Then:
```bash
npm run db:migrate
CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=chpass npm run ch:migrate
npm run dev
```
`ch:migrate` does **not** read `.env.local`; without exported vars it silently
prints "CLICKHOUSE_URL not set; skipping".

## 3. Mandatory seed (otherwise every run creation 500s on an FK)

`app/api/v1/benchmarks/[slug]/runs/route.ts` hardcodes a default org and user id
for every created run. Insert those exact rows:

```sql
INSERT INTO "user" (id,name,email,email_verified)
VALUES ('mxYI5c90QNkRPhvuc2HvNHy5mM7MG7jG','David Tice','david@example.com',true);
INSERT INTO organization (id,name,slug,created_at,owner_id)
VALUES ('zMrSfAyEyVJ2eKIxgoBZtrMvEd6a78ad','ComputeSDK','computesdk',now(),'mxYI5c90QNkRPhvuc2HvNHy5mM7MG7jG');
INSERT INTO member (id,organization_id,user_id,role,created_at)
VALUES ('mem1','zMrSfAyEyVJ2eKIxgoBZtrMvEd6a78ad','mxYI5c90QNkRPhvuc2HvNHy5mM7MG7jG','owner',now());
```
Re-read those constants before seeding — they may change.

As of the org-scoped-auth change (`lib/api/api-auth.ts` `requireApiAuth`), this seed is
only needed for the **admin-key** path: an org-scoped key supplies the run's
`organizationId` itself and `userId` from the key's `created_by`. Admin-key runs with no
`organizationId` in the body still fall back to those two hardcoded ids.

## 3b. Minting org-scoped `bp_` API keys locally

The org API-key HTTP route is **session**-scoped and answers `{"error":"Unauthenticated"}`
to the admin key, so keys can only be created from the dashboard UI or directly. For
scripted multi-tenant tests, mint them with the platform's own generator so the sha256
hash/prefix/lastFour match what `verifyApiKey()` expects:

```ts
// scripts/e2e-seed-orgs.ts (throwaway), run with:
//   npx tsx --env-file=.env.local scripts/e2e-seed-orgs.ts
import { generateApiKey } from "@/lib/api-keys";
import { apiKey, member, organization, user } from "@/db/auth-schema";
const g = generateApiKey();  // g.plaintext is the bp_<prefix>_<secret> to send
await db.insert(apiKey).values({
  id, organizationId, name, prefix: g.prefix, hashedKey: g.hashedKey,
  lastFour: g.lastFour, createdBy: someUserId, createdAt: new Date(),
  revokedAt: null, expiresAt: null,   // set these to test revoked/expired → 401
});
```
Each org needs `user` + `organization` (`owner_id`) + `member` rows first. To view an
org's runs in the dashboard, add a `member` row for your dashboard user in that org —
dashboard auth is session-based and completely separate from API keys.

## 4. Dashboard access

Sign up via `POST /api/auth/sign-up/email` (email+password is enabled), then add
a `member` row for that user in the seeded org, and sign in at
`http://localhost:3000/signin`. Run pages live at
`/{orgSlug}/benchmarks/{benchmarkSlug}/runs/{runId}` (+ `/workers`).

## 5. Getting results into ClickHouse locally

`@vercel/queue.send()` fails locally (swallowed as a warning), so nothing
imports automatically. Trigger it by hand — the cron route accepts the admin key
when `CRON_SECRET` is unset:
```bash
curl -s "http://localhost:3000/api/cron/import-clickhouse?limit=50" -H "Authorization: Bearer local-admin-key"
```
Check `imported`/`failed`/`failureSamples` in the response.

## 6. Running a benchmark with no provider credentials

Build first (`packages/*/dist` is not committed): `pnpm install && pnpm -r --filter "./packages/**" build`.

Write a throwaway bench inside the repo (untracked, e.g. `e2e-local/local.bench.ts`)
so pnpm workspace resolution finds `@benchsdk/runner`, with a fake participant:

```ts
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'e2e-local', benchmarkName: 'E2E', iterations: 4, concurrency: 1,
  participants: [{ name: 'local', requiredEnvVars: [] }],
});
export const task = defineTask(async (ctx) => {
  await ctx.step('create', () => new Promise((r) => setTimeout(r, 50)));
  ctx.measure({ ok: true });
});
```

Run it via the `bench run` CLI (under tsx so the `.bench.ts` module loads without a build):
```bash
BENCHMARKS_PLATFORM_URL=http://localhost:3000 BENCHMARKS_PLATFORM_API_KEY=<org bp_ key> \
  npx tsx packages/benchsdk-runner/dist/bin.js run e2e-local/local.bench.ts --iterations 4 --concurrency 2
```
`BENCHMARKS_PLATFORM_URL` is the **root** URL (the runner appends `/api/v1`).

The runner authenticates with `BENCHMARKS_PLATFORM_API_KEY` (an org-scoped `bp_` key — mint one
locally per the section below) and pulls the owning org slug from the server, so the "View at:"
URL it prints always points at the run's real org (no `BENCHMARKS_PLATFORM_ORG_SLUG` needed).

## 6b. Probing tenant isolation

With benchmarks-platform#47, all `app/api/v1/benchmarks/**` routes take either the global
`ADMIN_API_KEY` or an org `bp_` key. Expected shapes when a key from org B addresses org A's run:
`403 {"error":"API key is not authorized for this organization"}` (`getScopedRun` /
`requireRunAccess`), `404` for an unknown run/benchmark, `401 Invalid API key` for
revoked/expired/malformed tokens, `401 API key required` with no header. Listings
(`GET /benchmarks/:slug/runs` and `/results`) narrow by `organizationScope(auth)`.

When probing the **heartbeat** in-process cache, the body must carry `currentStep`, all four
`progressDone/InFlight/Errors/Total` fields **and** `concurrency` (top-level, not nested)
or the cache is never populated and your "cache poisoning" probe proves nothing. A
cache-served beat is recognisable because the response's `worker` object is minimal (no
`status`/`benchmarkId` columns). Route timing metadata (`cacheCoalesced`) is only logged
for requests slower than 1000 ms, so don't rely on the dev-server log for this.

## 7. Useful probes when testing lifecycle behaviour

- `psql` is not installed on the host — use `docker exec pg psql -U postgres -d bench ...`.
- To catch transient run statuses (`planned` → `in_progress` → `completed`), poll
  in a background subshell **while** the bench runs, then `sort -u` the samples:
  ```bash
  (for i in $(seq 1 60); do docker exec pg psql -U postgres -d bench -tA -c \
    "select r.status||'|'||p.status||'|'||w.status from ..."; sleep 0.4; done > /tmp/poll.txt) &
  ```
  Note `exec`'s `&` backgrounds the whole `cd X && ...` chain — pass `workdir`
  instead of a leading `cd`, or the foreground command runs in the wrong dir.
- To force a failed run, make the harness task throw for one taskIndex; the CLI
  calls `failWorker` when any task fails (runner.ts), which is what drives the
  run to `failed`.
- Worker release / re-claim and oversized event batches are easiest to drive with
  raw curl/python against the v1 API using the admin key; the events body needs
  `{type:'task_results', sequenceNumber, isFinal, attemptId, records:[...]}`.

## 8. Known sharp edges (verify before blaming your setup)

- `--group-by round`: `targetConcurrency` is read by the platform as
  tasks-per-worker, so the runner must send the full `schedule.length`. If it
  sends 1, only one task is planned (worker range 0-0) while every record is
  still accepted — results look right but progress/ranges do not.
- `benchmark_run_executions.status` should roll up from worker status
  (`in_progress` on first claim, `completed`/`failed` on the last worker). If a
  finished run still reads `planned`, the rollup is broken — the dashboard badge
  derives status separately and will hide it, so check Postgres and
  `/progress.run.status` vs `/progress.summary.status`, which must agree.
- Barriers: custom step names work off the `concurrency` samples the heartbeat
  sends, but `worker.ready` and `sandbox.live` are derived from the worker's
  `progress_in_flight` column — for those you must call
  `reporter.setProgress({ inFlight: N, ... })` first or the barrier sees
  `active=0` and hangs until timeout.
- `client.releaseWorker()` → 200 puts the worker back to `pending` and the
  attempt to `released`; a re-claim then gets `attemptNumber: 2`. A duplicate-key
  error on `unique(worker_id, attempt_number)` means the claim route hardcoded
  attempt number 1.
- Body limits: the events route allows 32 MiB (`MAX_EVENT_BODY_BYTES`), all other
  v1 routes 1 MiB. 5,000 records × 3 steps ≈ 3.15 MiB, so full-size SDK batches
  should be 202. If you see 413 on events, the raised cap is not wired up. Always
  check `benchmark_event_batches.status = 'persisted'` too — a 202 only means the
  body was accepted.
- Org-scoped `bp_…` keys on benchmark v1 routes arrived with
  benchmarks-platform#47 (see §3b/§6b). On a platform checkout without it those
  routes are admin-only and every `bp_…` key 401s there, even though the same key
  works on `/api/v1/organizations/...` — check which behaviour your checkout has
  before debugging a 401.

## Devin Secrets Needed

None. This entire flow runs offline with local docker containers and a
self-chosen `ADMIN_API_KEY`.
