---
"@benchsdk/runner": minor
---

Add the `reliability` benchmark config block and `--scheduled-for` run flag.

- `defineBenchmarkConfig` accepts `type: 'reliability'` with a strict `reliability` block (`interval` >= '30s', optional `graceMs`, `degradedWhen`, `target.uptime`, `layout: 'series'`, `sections`, `feedCard`). The pairing is enforced both ways — a `reliability` block requires `type: 'reliability'` and vice versa. Section validation is strict: unknown section types and option values throw at definition time, and a `metric` section must name a key declared in `display.metrics` or the built-in `'latency'` metric. Mirrors the platform's `config.reliability` schema.
- The materialize upsert now sends `config.reliability` alongside `config.index`/`display`/`scoring`, so a `type: 'reliability'` bench file passes the platform's type-vs-config check on first run.
- New `--scheduled-for <ISO-8601>` flag stamps `config.trigger.scheduledFor` on the run, so a scheduled (e.g. cron) reliability run that reports late fills its real slot instead of the nearest one by creation time. `ResolvedRunConfig.scheduledFor` exposes it.
