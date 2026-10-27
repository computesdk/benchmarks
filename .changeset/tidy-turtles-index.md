---
"@benchsdk/api": minor
"@benchsdk/runner": minor
---

Add benchmark `type` + `index` config support and run-level artifact uploads.

- `defineBenchmarkConfig` accepts `type: 'standard' | 'index' | 'reliability'` and an `index: { layout, spec? }` block, validated strictly: `index` requires `type: 'index'` (and vice versa), `layout` must be one of `model-matrix`, `matrix`, and `spec` must be a plain object.
- The runner now sends `type` (top-level) and `index` (inside `config`) on the `PUT /benchmarks/{slug}` upsert, so index-typed benchmarks pass the platform's type-vs-config consistency check.
- New `client.createRunArtifact(slug, runId, input)` posts to `POST /benchmarks/{slug}/runs/{runId}/artifacts` and returns the artifact plus presigned `uploadUrl`; `client.uploadRunArtifact` additionally PUTs the payload to that URL, reusing the worker-artifact upload transport. Exported alongside `CreateRunArtifactInput`, `CreateRunArtifactResponse`, and `UploadRunArtifactInput`.
