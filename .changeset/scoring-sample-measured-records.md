---
"@benchsdk/runner": patch
---

Score metric samples from every completed record instead of only records passing the success rule. A record that fails `success.requireData` (e.g. a post-run byte-verify) still produced real measurements; suppressing its samples left summary metric columns empty exactly when the gate bit. Errored records stay excluded — their data may be partial. The success rule still gates `successRate` and `compositeScore`.
