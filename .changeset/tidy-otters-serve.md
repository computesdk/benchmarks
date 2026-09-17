---
"@benchsdk/api": minor
"@benchsdk/cli": minor
---

Add `getParticipantLogs` to `@benchsdk/api` and a `bench logs` command for viewing parsed participant worker logs (the dashboard log view) via the platform's new `GET .../participants/:slug/logs` endpoint:

```
bench logs <slug> <runId> [--participant <slug>] [--worker <id>] [--max-lines N]
```
