---
"@benchsdk/cli": minor
"@benchsdk/runner": minor
---

Move CLI auth onto the OAuth provider. `bench auth login` now runs the RFC 8628 device flow against `/api/auth/device/code` and redeems at `/api/auth/oauth2/token` (`device_code` + `refresh_token` grants) for the `benchsdk-runner` client, scoped to `benchmarks:read|write billing:read org:read offline_access`. Saved credentials in `~/.benchsdk/credentials.json` keep working; entries written by the retired HS256/`bcs_` token system are detected and cleared with a prompt to log in again.
