---
"@benchsdk/runner": patch
---

Allow `display.byStep.hiddenSteps` and `display.byStep.hiddenMetrics` in a `*.bench.ts` display manifest. `hiddenSteps` lists step keys the run page's By Step section starts with unchecked in its Steps dropdown (e.g. create/destroy noise); `hiddenMetrics` does the same for the new per-step custom-metric breakdown rows. Both are only defaults — viewers can toggle the entries back on.
