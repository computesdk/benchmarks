---
'@benchsdk/cli': patch
---

`compute login` / `bench auth login` now also request the `providers:read` and `providers:write` scopes, so the stored login can reach `/api/v1/providers` (the org's BYOK provider keys and custom rates, `compute byok`). Logins made before this keep working everywhere else; run `compute login` again to use `compute byok` with a user login.
