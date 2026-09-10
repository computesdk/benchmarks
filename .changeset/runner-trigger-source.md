---
"@benchsdk/runner": minor
---

Record how a run was triggered.

- New `BENCH_TRIGGER_SOURCE` / `BENCH_TRIGGER_REQUESTED_BY` / `BENCH_TRIGGER_REQUEST_ID` env vars, set by workflows dispatched from the platform (`platform-retrigger`).
- Run config now includes `trigger: { source, event?, requestedBy?, requestId? }`; summary `triggeredBy` uses the same resolved source (falls back to `GITHUB_EVENT_NAME`, then `manual`).
- Exports `resolveTriggerSource(env?)`.
