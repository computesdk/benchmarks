# Proposal: Playwright-native browser benchmarks

This proposal requests ComputeSDK maintainer feedback, following Noah's request
for a proposal PR. It includes runnable implementations of two separate
benchmarks over `chromium.connect()`: **browser readiness** and **action
throughput**. It contains no provider benchmark results or performance claims.

## Motivation and scope

Providers exposing Playwright-native endpoints should be measurable alongside
the providers served by the existing CDP benchmarks. Keep the CDP suites,
identities, methodology, and historical results intact; give the new suites
separate identities and result series. This is a provider comparison under a
specified workload, not evidence that either protocol is inherently faster.

[CONTRIBUTING.md](./CONTRIBUTING.md) asks contributors to discuss methodology
and wait for maintainer feedback before implementing changes, because historical
comparability matters. This PR supplies that discussion for approval or revision,
alongside isolated native suites, local fixture validation, and run instructions.
The existing CDP suites and their dependency version remain unchanged. Approval
of the methodology and environment prerequisites is still required before a
published provider comparison.

## Initial participants and disclosure

Propose **Momentic** and **Azure Playwright Workspaces** initially. Other providers
may participate if they expose a Playwright-native endpoint compatible with
`chromium.connect()` and can meet the same workload, settings, and lifecycle
requirements. A CDP endpoint alone does not qualify for these suites.

The proposer is affiliated with Momentic. Momentic offers to fund Azure usage for
the comparison; the billing arrangement remains to be agreed before execution.
Funding does not determine inclusion, methodology, or interpretation of results.
Provider participation and sponsorship remain separate, as required by the
contribution guidance.

## Execution and environment

- Run **100 fresh sessions per provider per suite**, with `iterations: 100`,
  `concurrency: 1`, and `groupBy: 'round'`. One runner executes one session at a
  time: Momentic round 1, Azure round 1, Momentic round 2, Azure round 2, and so on.
  Record provider order. Do not substitute parallel provider matrix jobs for
  this initial interleaved comparison.
- Use separate benchmark slugs, run IDs/keys, and result series for readiness
  and throughput. Do not reuse sessions between suites or rounds. Fresh means a
  new logical provider session, context, and page, not a guarantee of a cold
  physical host or empty provider cache.
- Require both providers' browsers to execute in the **same Azure region** and
  keep the runner location fixed for the entire initial comparison. Agree the
  exact region and runner location before a provider comparison. Record the actual
  browser regions, runner region/location, routing configuration, and evidence
  of effective placement; a workspace or requested region alone is insufficient
  if routing can select another region.
- Use Linux Chromium in headless mode and an explicitly configured
  **1920 × 1080 viewport** in every fresh context. Fix other context settings
  equally across participants and record them. Disable optional stealth, proxy,
  video, trace, HAR, and provider recording features. Screenshots remain part of
  the measured workload.
- Pin a common compatible Playwright client version and compatible provider
  server versions. [Playwright's connection contract](https://playwright.dev/docs/api/class-browsertype#browser-type-connect)
  requires matching client/server major and minor versions. Record the exact
  client, server Playwright, and Chromium versions, plus runner OS and Node.js
  version. Confirm provider support and version reporting before a provider comparison;
  do not silently change versions during a run.

## Suite 1: browser readiness

Prepare reusable credentials and provider clients before measurement. Workspace
creation, account setup, reusable token acquisition, and other one-time setup
are prerequisites, not readiness samples. Any authentication performed for each
individual session belongs inside that session's timed boundary.

Start a monotonic timer **immediately before the first per-session provisioning
or connection request**, whichever comes first for that provider. Include all
per-session authentication, session provisioning and polling where required,
endpoint acquisition, `chromium.connect()`, `browser.newContext()` with the fixed
viewport, and `context.newPage()`. Stop immediately after
`page.goto('https://www.example.com', { waitUntil: 'load' })` completes
successfully. For a provider that provisions on connection, start immediately
before that connection request; do not omit provisioning hidden in the handshake.

Report this elapsed interval as `readinessMs`, with component timings where
available. The end condition is the completed page load, not merely an open
socket. Each attempt uses a fresh context/page rather than a provider's default
page. Measure cleanup separately as `cleanupMs`, including context/browser close
and any provider release or termination; exclude it from `readinessMs`.

## Suite 2: action throughput

Provision and connect a fresh session, then create a fresh context/page using the
same settings. Record setup and cleanup separately; exclude both from the action
throughput denominator. Reuse the ten-action Wikipedia workload from
[browser-throughput.bench.ts](./benchmarks/browser/browser-throughput.bench.ts),
with **five repetitions per session: 50 sequential actions**.

Before measured sessions begin, resolve and validate one concrete article URL
per round, using the same heading and article-body link requirements as the
workload. Freeze and publish the ordered URL list; both providers use the same
round's URL for all five repetitions. Require 100 validated inputs rather than
silently wrapping a short list or falling back to `Special:Random` during
measurement. URL preparation is outside session timing. Shared inputs reduce
page-selection variance; live Wikipedia content and network conditions can still
vary and should not be treated as isolated protocol overhead.

| Action in each loop | Operation |
| --- | --- |
| 1 | `page.goto(sharedArticleUrl, { waitUntil: 'load' })` |
| 2 | `page.waitForSelector('#firstHeading')` |
| 3 | `page.screenshot()` with the fixed viewport |
| 4 | `page.textContent('#firstHeading')` |
| 5 | Wait for `#mw-content-text a[href*="/wiki/"]`, inspect links in document order, and click the first article link whose path after `/wiki/` has no namespace colon. Accept relative, protocol-relative, and absolute URL forms. |
| 6 | `page.waitForSelector('#firstHeading')` on the linked article |
| 7 | `page.screenshot()` |
| 8 | `page.textContent('#firstHeading')` |
| 9 | `page.goBack({ waitUntil: 'commit' })` |
| 10 | `page.waitForSelector('#firstHeading')` on the original article |

The click's link discovery and selection remain inside that action's timing.
Keep the existing 30-second bound per action and the click's 10-second internal
selector wait. Preserve dependency skipping: if action 5 fails, record actions
6–10 as unsuccessful, skipped actions with zero duration, then continue with
the next repetition. Other action failures are recorded without aborting the
loop. Back navigation resolves at `commit`; the following selector wait confirms
the heading is present.

Use the existing metric definitions: `taskMs` is the **sum of the individual
action durations**, and `actionsPerSecond = actionsCompleted / (taskMs / 1000)`.
A complete successful session has `actionsCompleted: 50`. Record the enclosing
`actions` step's elapsed time too, but do not substitute it for `taskMs` without
maintainer agreement. Each complete session contains ten screenshots; report
their latency separately from actions per second.

## Integration and failure handling

Follow the existing declarative
[config + task conventions](./WRITING_BENCHMARKS.md): each suite exports `config`
and `task`; the `bench run` runner owns scheduling and reporting. Participants
supply endpoint/authentication information, per-session provisioning where
required, and lifecycle cleanup. Provider-specific setup surrounds a shared
measured workload; it must not change the action sequence or timing definitions.
Do not assume the current CDP session interface already satisfies these needs.

Use `step()` for setup/provisioning, connection and fresh context/page creation,
navigation or actions, and cleanup. Use `measure()` for readiness elapsed time,
action counts, rates, and screenshot metrics, and retain ordered action records
in task data. Capture readiness's start and stop explicitly across steps; the
runner's overall task duration includes cleanup and is not `readinessMs`.
Use the existing task error/data conventions to retain diagnostics and partial
records when a session-level operation fails.

Bound provisioning/polling, per-session authentication, connection, context/page
creation, navigation, and every cleanup operation. Agree and record limits
before a provider comparison. `chromium.connect()` needs an explicit timeout because
its default is unbounded. Attempt cleanup in `finally` after success or failure,
including partial setup. Closing a connection must not be assumed to release
provider resources: verify each provider's lifecycle semantics, retain session
identifiers as soon as available, and define how timed-out provisioning or
late-created sessions are reconciled. Record cleanup failures without masking
the original failure; prevent uncertain leaked resources from accumulating.

Every started attempt remains in the reliability denominator, including
provisioning, authentication, connection, navigation, action, and cleanup
failures. Do not replace failed samples with successful retries. Report workload
success and cleanup success separately, as well as overall session success
(both succeeded). Readiness workload success requires the completed target load;
throughput workload success requires all 50 actions and no setup/session error.
Incomplete sessions never enter successful-session throughput summaries.
Raw failed/partial action records, elapsed failure times, timeout reasons, and
skipped dependencies remain available. A participant skipped for missing
credentials is unavailable, not a measured success; the planned comparison
requires both initial participants to be ready before launch.

Separate SDK integration and package publication are follow-up work. The
contribution guidance describes provider integration in
[`computesdk/computesdk`](https://github.com/computesdk/computesdk), package
publication, and credentials for ongoing tests. Maintainers should confirm how
Playwright-native endpoint/authentication and cleanup requirements fit that
process before a provider comparison; this PR proposes no new SDK API or package.

## Results and methodology review

Publish raw session and action records for all attempts, the shared URL list,
settings/version/region metadata, sample counts, and success rates. Remove
credentials and credential-bearing endpoints from public artifacts. Publish
**untrimmed median/P95/P99** timings for successful workload sessions, with
failures and cleanup outcomes visible alongside them. Do not turn a timeout into
a successful latency observation or report missing samples as zero latency.

Report `readinessMs`, `taskMs`, per-action-type latency, and `cleanupMs` separately.
For throughput, summarize per-session actions per second and publish a separate
screenshot latency distribution over successful screenshots in complete
sessions. Retain the existing `screenshotMs` metric as each session's median
successful screenshot latency, clearly distinguishing its across-session
summary from the pooled screenshot distribution. Define median as the middle
value (mean of the middle two for an even count); use nearest-rank P95/P99 on
sorted samples and disclose sample sizes. With 100 attempted sessions, tail
estimates may rest on very few observations, especially after failures.

Defer composite scores, ceilings, and weights to maintainer review. Initially
report distributions without a composite ranking. The runner supports omitting
`scoring`; use metric-based display and retain explicit workload-success flags.
Do not copy the existing 5% tail trimming or legacy result summaries into these
suites. If scoring is approved later, use `trim: 0` for the agreed untrimmed
metrics and preserve the explicit complete-session success criterion.

## Correspondence with current executable behavior

The proposal uses current code and workflows to resolve documentation drift:

- [THROUGHPUT.md](./THROUGHPUT.md) describes five repetitions, but
  [throughput-types.ts](./benchmarks/browser/throughput-types.ts) currently sets
  `LOOPS_PER_SESSION = 1`: the executable workload is ten actions. This proposal
  adopts the documented 50-action design explicitly; it does not claim the
  current executable suite already runs 50 or change the existing CDP constant.
- The executable action loop uses shared URLs when supplied, supports three
  article-link URL forms, and skips dependent actions after click failure.
  Those behaviors take precedence over the older random-page selector and
  failure descriptions in `THROUGHPUT.md`.
- [browser.bench.ts](./benchmarks/browser/browser.bench.ts) measures a CDP
  lifecycle whose `totalMs` includes browser close and session release. The new
  readiness boundary excludes cleanup and includes fresh context/page creation.
- Both browser configs default to two iterations; the
  [throughput workflow](./.github/workflows/browser-throughput-benchmarks.yml)
  supplies 100 for scheduled/manual runs and three for browser-code pushes. It
  currently runs weekly, with providers in separate matrix jobs. Those settings
  do not establish the proposed single-runner interleaving or runner location.
- [throughput-benchmark.ts](./benchmarks/browser/throughput-benchmark.ts) trims
  tails and its legacy summaries can include incomplete sessions. The declarative
  throughput scoring config requires complete action counts. The new suites
  must explicitly filter workload success and publish untrimmed distributions,
  rather than assuming both reporting paths have the same semantics.

## Prerequisites and follow-up work

Before launching a provider comparison, obtain maintainer agreement on these timing
boundaries, the 50-action workload, reliability and summary definitions, and
provider integration requirements. Select and verify the shared Azure region
and fixed runner location, compatible pinned versions, credential setup, Azure
funding arrangement, lifecycle timeouts, and cleanup behavior for both providers.
These are outstanding prerequisites, not provider capabilities validated by the
local fixture tests.

Validate the eventual implementation with repeatable checks of timing boundaries,
identical round inputs, exact action counts, timeout/dependency behavior, partial
result retention, actual placement/settings, and resource cleanup after failures.
The included test exercises the real native protocol and existing declarative
runner against local HTTP/TLS fixtures. It validates the 50-action workload,
round interleaving, load boundary, authentication headers, partial results,
lost-response reconciliation, cleanup failures, credential redaction, and
untrimmed summaries. This does not validate the deployed providers, their
placement, or their resource-release semantics.

Concurrency testing, multiple regions, composite scoring, provider/workspace
provisioning, SDK/package publication, and benchmark publication are follow-up
work after methodology review.

## Running the implementations

The runnable entrypoints are
[playwright-readiness.bench.ts](./benchmarks/browser/playwright-readiness.bench.ts)
and [playwright-throughput.bench.ts](./benchmarks/browser/playwright-throughput.bench.ts).
They use a separate, exact `playwright-core@1.60.0` dependency alias; the existing
CDP dependency remains unchanged. Compatibility with deployed providers must be
verified before running a comparison.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm -r --filter './packages/**' run build

# Install the local browser used only to prepare inputs and run fixture tests.
node node_modules/playwright-native-core/cli.js install chromium
pnpm test:playwright-native

# Resolve and DOM-validate the shared inputs before provider measurement.
pnpm bench:playwright-prepare-urls 100 playwright-native-urls.json

# Run separately; --no-ingest writes local records without platform publication.
pnpm bench:playwright-readiness --no-ingest
pnpm bench:playwright-throughput --no-ingest
```

Store credentials in your shell or the ignored `benchmarks/.env`, never in Git:

- `MOMENTIC_BROWSER_FLEET_URL`: the Browser Fleet API base URL.
- `MOMENTIC_BROWSER_FLEET_API_KEY`: a credential authorized to create, read, and
  delete benchmark sessions. A normal Momentic app API key is not interchangeable.
- `AZURE_PLAYWRIGHT_SERVICE_URL`: the workspace browser endpoint ending in
  `/playwrightworkspaces/<workspace-id>/browsers`. The adapter resolves the
  [documented browser redirect](https://learn.microsoft.com/en-us/rest/api/playwright/dataplane/workspaces/get-browsers?view=rest-playwright-dataplane-2025-09-01)
  inside measurement, then connects with bearer authentication and `os=Linux`.
- `AZURE_PLAYWRIGHT_ACCESS_TOKEN`: a reusable Entra or workspace access token
  prepared before measurement; its authentication mode must already be enabled.
- `PLAYWRIGHT_NATIVE_URLS_FILE`: the prepared `playwright-native-urls.json` path.
- `PLAYWRIGHT_NATIVE_ENVIRONMENT_FILE`: an operator-verified environment manifest
  path. The manifest validates the shared region, compatible versions, and fixed
  settings and records evidence; it does not discover actual placement itself.
- `PLAYWRIGHT_NATIVE_RESULTS_DIR`: optional local output directory (default
  `results/playwright-native`). Each suite writes a fresh JSON file with all task
  and action records, reliability denominators, and untrimmed summaries.

Create an ignored `playwright-native-environment.json` only after verifying the
environment. Use this shape for **both** entries in `providers` (`momentic` and
`azure`), replacing the evidence placeholders with non-secret verification
references:

```json
{
  "region": "<verified shared Azure region>",
  "runnerLocation": "<fixed runner location>",
  "providers": {
    "momentic": {
      "region": "<same shared Azure region>",
      "playwrightVersion": "1.60.0",
      "os": "linux",
      "headless": true,
      "stealth": false,
      "proxy": false,
      "recording": false,
      "placementEvidence": "<verified effective placement>",
      "versionEvidence": "<verified server version>",
      "cleanupEvidence": "<verified termination semantics>"
    },
    "azure": {
      "region": "<same shared Azure region>",
      "playwrightVersion": "1.60.0",
      "os": "linux",
      "headless": true,
      "stealth": false,
      "proxy": false,
      "recording": false,
      "placementEvidence": "<verified effective placement>",
      "versionEvidence": "<verified server version>",
      "cleanupEvidence": "<verified termination on connection close>"
    }
  }
}
```

Momentic provisioning creates a session with an idempotency key and polls READY;
cleanup requests deletion and polls a terminal state. A lost creation response
is reconciled with the same key during cleanup, without replacing the failed
sample. Azure teardown closes the context and connection and relies on the
service's verified release semantics.
If Azure provisioning/connection fails without an owned connection to close,
cleanup is recorded as uncertain and further allocations stop for that
participant; the implementation does not claim it released an unknown resource.
Provisioning has a 120-second bound;
connection, context/page creation, and navigation have 30-second bounds; each
cleanup operation has a 15-second bound. After uncertain cleanup, the process
refuses further allocations for that participant and records unstarted tasks
separately from attempted-session reliability denominators.

No real credentials are used by fixture tests. Local fixture credentials and
certificates are disposable, and the CI fixture job runs without provider
credentials. Shared input/setup files and generated result files are ignored by
Git. Actual Chromium versions are collected from each connected browser;
server versions and placement evidence are labeled by their source in raw data.
