---
"@benchsdk/api": minor
"@benchsdk/cli": patch
---

Run-list responses are now slimmer: `listRuns`/`listAllRuns` return `BenchmarkRunListItem` (id, benchmarkId, organizationId, name, status, sizing, timestamps, organizationSlug, benchmarkSlug) instead of the full run row — `config`, `summary`, `runKey`, `participantSized`, and creator attribution are no longer included. `BenchmarkResource` gains optional `organizationId`/`organizationSlug` for the catalog response.
