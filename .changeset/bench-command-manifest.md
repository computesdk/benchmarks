---
'@benchsdk/cli': patch
'@benchsdk/runner': patch
---

Add a machine-readable `bench` command manifest.

- `@benchsdk/cli` exports `COMMANDS`, one table of every platform command with its arguments, allowed flags, and the version that first shipped it (`since`, plus `flagsSince` for flags added later). `bench` reads its per-command flag allowlists from this table. `bench auth login|logout|status` now reject unknown flags like every other command instead of ignoring them.
- `@benchsdk/runner` adds the hidden `bench __manifest [--released]` command, which prints the command tree as JSON (runner verbs `run` and `check` plus `COMMANDS`), and ships the generated `cli-manifest.json`. Regenerate it with `pnpm --filter @benchsdk/runner run manifest`.
- The manifest lists `bench reliability` with `since: 0.9.2` (merged after `@benchsdk/cli` 0.9.1 was published; 0.9.2 is the first release that shipped it) and `bench runs run-again` / `runs run-again-status` with `since: 0.9.3`.
