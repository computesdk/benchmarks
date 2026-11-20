# Benchmark suite source index

For measurement rules and limitations, read the [technical methodology](methodology.md). Links below point to current source; use the producing commit when auditing a historical run. Workflow files declare defaults and provider matrices, while dispatch inputs and platform configuration can override execution.

## Public workload entry points

| Suite | Workload | Workflow |
| --- | --- | --- |
| Sandbox burst TTI | [task/config](../benchmarks/sandbox/tti.bench.ts) | [execution](../.github/workflows/sandbox-tti-benchmarks.yml) |
| Sandbox DAX | [task/config](../benchmarks/sandbox/dax.bench.ts) | [execution](../.github/workflows/sandbox-dax-benchmarks.yml) |
| Browser lifecycle | [task/config](../benchmarks/browser/browser.bench.ts) | [execution](../.github/workflows/browser-benchmarks.yml) |
| Browser throughput | [task/config](../benchmarks/browser/browser-throughput.bench.ts) | [execution](../.github/workflows/browser-throughput-benchmarks.yml) |
| Browser concurrency (delegates to Stealth workload) | [task/config](../benchmarks/browser/browser-concurrent.bench.ts) | [execution](../.github/workflows/browser-concurrent-benchmarks.yml) |
| Storage lifecycle | [task/config](../benchmarks/storage/storage.bench.ts) | [execution](../.github/workflows/storage-benchmarks.yml) |
| Storage snapshot / fork | [task/config](../benchmarks/storage/snapshot-fork.bench.ts) | [execution](../.github/workflows/snapshot-fork-benchmarks.yml) |
| AI gateways (model-family entry points and shared request task) | [workloads, providers and prompts](../benchmarks/ai-gateway/) | [execution](../.github/workflows/ai-gateway-benchmarks.yml) |

[Daily execution](../.github/workflows/daily-benchmarks.yml) reuses public workloads with daily slugs. The [sandbox capability script](../benchmarks/scripts/) and [workflow](../.github/workflows/sandbox-capabilities.yml) provide additional capability checks.

## Former private / Stealth suites

All of the following source is public. Platform access controls still apply to underlying runs and logs. Provider registries and scoring helpers live beside the workload or in its imported helpers; they were kept suite-scoped during consolidation to preserve behavior.

| Suite | Workload | Platform workflow |
| --- | --- | --- |
| browser concurrency | [task/config](../benchmarks/stealth/browser/browser-concurrency.bench.ts) | [execution](../.computesdk/workflows/stealth-browser-concurrency.yml) |
| browser playwright readiness | [task/config](../benchmarks/stealth/browser/browser-playwright-readiness.bench.ts) | [execution](../.computesdk/workflows/stealth-browser-playwright-readiness.yml) |
| browser playwright throughput | [task/config](../benchmarks/stealth/browser/browser-playwright-throughput.bench.ts) | [execution](../.computesdk/workflows/stealth-browser-playwright-throughput.yml) |
| browser file transfer | [task/config](../benchmarks/stealth/browser/file-transfer.bench.ts) | [execution](../.computesdk/workflows/stealth-browser-file-transfer.yml) |
| browser idle resume | [task/config](../benchmarks/stealth/browser/idle-resume.bench.ts) | [execution](../.computesdk/workflows/stealth-browser-idle-resume.yml) |
| browser protected sites | [task/config](../benchmarks/stealth/browser/protected-sites.bench.ts) | [execution](../.computesdk/workflows/stealth-browser-protected-sites.yml) |
| browser session persistence | [task/config](../benchmarks/stealth/browser/session-persistence.bench.ts) | [execution](../.computesdk/workflows/stealth-browser-session-persistence.yml) |
| provider weekly composite | [task/config](../benchmarks/stealth/composite/provider-weekly-composite.bench.ts) | [execution](../.computesdk/workflows/stealth-provider-weekly-composite.yml) |
| sandbox cpu | [task/config](../benchmarks/stealth/sandbox/cpu.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-cpu.yml) |
| filesystem snapshot | [task/config](../benchmarks/stealth/sandbox/filesystem-snapshot.bench.ts) | [execution](../.computesdk/workflows/stealth-filesystem-snapshot.yml) |
| oci tti | [task/config](../benchmarks/stealth/sandbox/oci-tti.bench.ts) | [execution](../.computesdk/workflows/stealth-oci-tti.yml) |
| os capabilities | [task/config](../benchmarks/stealth/sandbox/os-capabilities.bench.ts) | [execution](../.computesdk/workflows/stealth-os-capabilities.yml) |
| sandbox rootfs | [task/config](../benchmarks/stealth/sandbox/rootfs.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-rootfs.yml) |
| sandbox burst survival | [task/config](../benchmarks/stealth/sandbox/sandbox-burst-survival.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-burst-survival.yml) |
| sandbox burst tti 1k | [task/config](../benchmarks/stealth/sandbox/sandbox-burst-tti-1k.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-burst-tti-1k.yml) |
| sandbox ci capabilities | [task/config](../benchmarks/stealth/sandbox/sandbox-ci-capabilities.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-ci-capabilities.yml) |
| sandbox cpu burst | [task/config](../benchmarks/stealth/sandbox/sandbox-cpu-burst.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-cpu-burst.yml) |
| sandbox criu | [task/config](../benchmarks/stealth/sandbox/sandbox-criu.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-criu.yml) |
| sandbox fidelity | [task/config](../benchmarks/stealth/sandbox/sandbox-fidelity.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-fidelity.yml) |
| sandbox fs api | [task/config](../benchmarks/stealth/sandbox/sandbox-fs-api.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-fs-api.yml) |
| sandbox fs io | [task/config](../benchmarks/stealth/sandbox/sandbox-fs-io.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-fs-io.yml) |
| sandbox heavy snapshot | [task/config](../benchmarks/stealth/sandbox/sandbox-heavy-snapshot.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-heavy-snapshot.yml) |
| sandbox pause resume | [task/config](../benchmarks/stealth/sandbox/sandbox-pause-resume.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-pause-resume.yml) |
| sandbox reliability | [task/config](../benchmarks/stealth/sandbox/sandbox-reliability.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-reliability.yml) |
| sandbox snapshot fanout | [task/config](../benchmarks/stealth/sandbox/sandbox-snapshot-fanout.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-snapshot-fanout.yml) |
| sandbox snapshot | [task/config](../benchmarks/stealth/sandbox/sandbox-snapshot.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-snapshot.yml) |
| sandbox soak | [task/config](../benchmarks/stealth/sandbox/sandbox-soak.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-soak.yml) |
| sandbox volumes | [task/config](../benchmarks/stealth/sandbox/volumes.bench.ts) | [execution](../.computesdk/workflows/stealth-sandbox-volumes.yml) |
| storage cold start | [task/config](../benchmarks/stealth/storage/storage-cold-start.bench.ts) | [execution](../.computesdk/workflows/stealth-storage-cold-start.yml) |
| storage concurrency | [task/config](../benchmarks/stealth/storage/storage-concurrency.bench.ts) | [execution](../.computesdk/workflows/stealth-storage-concurrency.yml) |
| storage range reads | [task/config](../benchmarks/stealth/storage/storage-range-reads.bench.ts) | [execution](../.computesdk/workflows/stealth-storage-range-reads.yml) |
| web data scrape | [task/config](../benchmarks/stealth/web-data/web-data-scrape.bench.ts) | [execution](../.computesdk/workflows/stealth-web-data-scrape.yml) |


The [soak-state importer](../.computesdk/workflows/stealth-soak-state-import.yml) is an operational handoff tool, not a scored workload. See the [cutover runbook](migration.md) before changing schedules.

## Additional and historical tools

[Sandbox OpenCode reliability](../benchmarks/reliability/sandbox-opencode.bench.ts) is a separate runnable entry point. [Scale tooling](../benchmarks/scale/) remains in the repository; the published Scale Invitational is historical and is not an ongoing scheduled suite.

## Runner and scoring references

- [Runner and local CLI](../packages/benchsdk-runner/README.md), including task/step semantics and flags.
- [Shared scorer](../packages/benchsdk-runner/src/scoring.ts): sample trimming, percentiles, success gates and linear/reciprocal transforms.
- [Sandbox performance scoring](../benchmarks/stealth/sandbox/performance-runtime-scoring.ts) and [state scoring](../benchmarks/stealth/sandbox/state-scoring-candidate.ts). Read each workload to determine which helper is active.
- [Browser scoring](../benchmarks/stealth/browser/browsers-runtime-scoring.ts) and [storage concurrency scoring](../benchmarks/stealth/storage/storage-concurrency-scoring.ts).
- [Weekly category aggregation](../benchmarks/stealth/composite/provider-weekly-composite.ts), including sandbox grouping and missing-data rules.

## Contributing a suite

Add a workload and provider configuration, its workflow, and an entry in this index. Document the timed boundary, verification, resource/region exceptions, sample count, retries/timeouts, scoring policy and limitations alongside the change. Keep credentials and restricted results out of Git.
