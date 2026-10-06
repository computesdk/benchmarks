---
"@benchsdk/cli": patch
---

Export `getMe`, `listOrganizations`, `setActiveOrganization`, `loadCredentials`, and `saveCredentials` so other first-party CLIs (e.g. `@computesdk/cli` for `compute org`) can drive the same organization endpoints and credential store.
