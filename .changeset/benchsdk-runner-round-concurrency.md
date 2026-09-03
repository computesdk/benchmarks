---
"@benchsdk/runner": minor
---

Respect `concurrency` in `groupBy: 'round'` mode.

- `runGroupedByRound` now runs each round's participants concurrently up to `resolved.concurrency` instead of sequentially.
- Added an internal `runWithConcurrency` helper to bound parallel tasks without adding a new dependency.
- Preserves round-robin fairness: all Nth probes across gateways still start at roughly the same wall-clock time, while rounds stay sequential.
