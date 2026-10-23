---
"@benchsdk/api": minor
"@benchsdk/cli": minor
---

- `client.listRuns` returns an array again (pre-0.8.0 shape); the response envelope is available as non-enumerable `items`, `appliedFilter` and `upgrade` properties.
- `client.getRunResults` accepts `{ participants }` and sends `?participant=`; `bench results --run <id> --participant <slug>` narrows a single run to one provider.
- `--tz` and `--source-org` alone no longer count as result filters, so they stop triggering the "platform does not support result filters" error against older platforms.
- The `bench results` table labels each row with the run's day instead of its UUID.
