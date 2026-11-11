---
"@benchsdk/runner": patch
---

Support optional post-percentile reciprocal scoring transforms and full-precision composite scores while preserving existing arithmetic when absent. Retain zero contribution for omitted metric rows and fail closed on missing or invalid positive-weight statistics in present rows. Reject invalid new declarative scoring fields during configuration and before run side effects, including dry runs.
