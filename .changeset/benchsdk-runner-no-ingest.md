---
"@benchsdk/runner": minor
---

Adds `--no-ingest` / `BENCHSDK_NO_INGEST=1` dry-run mode to `bench run`.

The benchmark executes locally but skips uploading results to the platform, making it possible to run without creating a platform run. Note: platform auth is still required for every `bench run` invocation (see the auth changeset).
