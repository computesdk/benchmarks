---
name: add-sandbox-provider
description: Prep a new sandbox provider for the ComputeSDK benchmarks (wire up the dependency, env var, providers list, and CI workflow). Use when asked to add, onboard, or stage a new sandbox/compute provider — e.g. "add provider X", "onboard the foo sandbox", "set up bar for benchmarks".
---

# Add a sandbox provider to the benchmarks

This repo benchmarks ComputeSDK sandbox providers. A provider is wired across four
files. New providers are **staged** (every change commented out) until the provider's
API secret exists as a GitHub repo secret — then they're activated by uncommenting.
The `beam` provider is the reference example of a staged provider.

Inputs you need from the user (ask if missing): the **provider name** (lowercase, as it
appears on npm `@computesdk/<name>`) and the **env var(s)** it authenticates with
(e.g. `FOO_API_KEY`).

## 1. Verify the package and its factory shape

Never guess the factory name or config keys — confirm against the published package:

```bash
npm view @computesdk/<name> version          # confirm it exists, get the version
cd /tmp && npm pack @computesdk/<name>        # then inspect the type defs:
tar -xzf computesdk-<name>-*.tgz -O package/dist/index.d.ts | grep -nE 'declare const|Config|export'
```

Note the exported factory (usually `<name>`) and its config interface — which key holds
the API key, and whether the key falls back to an env var. Most factories take
`{ apiKey }`; some take `{ token }`, `{ token, workspace }`, etc.

## 2. Add the dependency

In [package.json](../../../package.json) add `"@computesdk/<name>": "^<version>"` to
`dependencies`, **in alphabetical order**. Then sync the lockfile:

```bash
pnpm install
```

Confirm the diff only added the new package — `git diff --stat package-lock.json`
(npm may report removing/changing packages while reconciling `node_modules` on disk;
that's fine as long as the committed lockfile only gained the new entry).

## 3. Document the env var(s)

In [benchmarks/.env.example](../../../benchmarks/.env.example) append a section (staged providers live near the
bottom, by `BEAM`):

```
######### <NAME> ########
<NAME>_API_KEY=your_<name>_api_key
```

## 4. Stage the provider entry (commented)

In [benchmarks/sandbox/providers.ts](../../../benchmarks/sandbox/providers.ts):

- Add a commented import near the other imports: `// import { <name> } from '@computesdk/<name>';`
- Add a commented entry in the `providers[]` array (direct-mode section, alphabetical):

```ts
// {
//   name: '<name>',
//   requiredEnvVars: ['<NAME>_API_KEY'],
//   createCompute: () => <name>({ apiKey: process.env.<NAME>_API_KEY! }),
// },
```

Keep the entry **minimal** — only `name`, `requiredEnvVars`, `createCompute`. Do NOT
copy `sandboxOptions`, `destroyTimeoutMs`, etc. from a neighboring provider; those are
provider-specific (e.g. `autoStopInterval` is Daytona-only). Add an option only if the
factory's own config documents it.

## 5. Stage the CI workflow (commented)

In [.github/workflows/sandbox-benchmarks.yml](../../../.github/workflows/sandbox-benchmarks.yml),
two spots, both commented like the `beam` lines:

- The `matrix.provider` list: `# - <name>`
- The `Run benchmark` step's `env:` block: `# <NAME>_API_KEY: ${{ secrets.<NAME>_API_KEY }}`

## What you do NOT need to touch

- `GATEWAY_PROVIDERS` in `benchmarks/sandbox/generate-svg.ts` — only for automatic-mode
  providers routed through the ComputeSDK gateway (railway/render), not direct-mode SDKs.
- A `bench:<name>` script in package.json is optional; CI invokes
  `--provider ${{ matrix.provider }}` directly. Skip it unless asked.
- No tests enumerate providers.

## Why staged (and why it's safe to activate later)

The runner gracefully **skips** any provider whose `requiredEnvVars` are missing — it
returns a `skipped: true` result rather than failing (see
[benchmarks/sandbox/benchmark.ts](../../../benchmarks/sandbox/benchmark.ts), the `missingVars` check).
So activating without the secret wouldn't break CI; staging is a convention to keep the
provider list reflecting what's actually being benchmarked until the secret is added.

## Activation (later, once the repo secret exists)

Uncomment all four staged blocks: the import and `providers[]` entry in providers.ts,
the matrix line, and the workflow `env:` line. Add the `<NAME>_API_KEY` secret in the
repo settings first.

## Final check

Run `git diff` and confirm the change set is exactly: package.json, package-lock.json,
benchmarks/.env.example, benchmarks/sandbox/providers.ts, .github/workflows/sandbox-benchmarks.yml — and
that every provider-specific line is commented out (staged).
