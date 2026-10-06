---
"@benchsdk/cli": minor
"@benchsdk/runner": minor
---

Move CLI auth onto the OAuth provider. `bench auth login` now runs the RFC 8628 device flow against `/api/auth/device/code` and redeems at `/api/auth/oauth2/token` (`device_code` + `refresh_token` grants). Both `bench` and `compute` log in as the `benchsdk-cli` client with the full first-party scope set, so one login in `~/.benchsdk/credentials.json` covers every first-party CLI. API keys and new-format logins keep working; entries written by the retired HS256/`bcs_` token system are detected and cleared with a prompt to log in again, and `insufficient_scope` API errors surface a re-login hint.
