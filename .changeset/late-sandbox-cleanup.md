---
'@benchsdk/runner': patch
---

`bench run` now awaits an optional `beforeExit` export from the benchmark file after the run (even a failed one), before the process exits.
