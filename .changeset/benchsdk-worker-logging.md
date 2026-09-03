---
"@benchsdk/worker": minor
"@benchsdk/api": minor
"@benchsdk/runner": patch
"@benchsdk/client": minor
---

Improves worker logging, step capture, and artifact handling.

- Adds leveled log output (`debug`, `info`, `warn`, `error`) to `runWorker`.
- Captures named step output and buffers logs incrementally.
- Compresses log artifacts with gzip before upload.
- Adds worker artifact download support in `@benchsdk/api`.
- Updates `@benchsdk/client` to re-export the new logging types and helpers.
