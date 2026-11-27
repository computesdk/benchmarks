---
'@benchsdk/api': patch
'@benchsdk/cli': patch
---

Add participant exclusions: `bench exclusions list|add|remove` and the `listParticipantExclusions`, `createParticipantExclusion` and `deleteParticipantExclusion` API client methods, for windows where a participant's results don't count (for example an expired benchmark token).
