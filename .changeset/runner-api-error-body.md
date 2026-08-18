---
"@benchsdk/runner": patch
---

Print the API response body when a run fails with a `BenchmarkApiError`. The error message carries only the status line, so a failed run previously logged a bare `400 Bad Request` with no indication of which field the platform rejected.
