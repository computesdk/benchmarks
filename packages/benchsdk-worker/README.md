# @benchsdk/worker

Execute benchmark tasks assigned by the ComputeSDK benchmark platform. Workers report task results, progress, and heartbeats as a workload runs.

[Public benchmarks](https://www.computesdk.com/benchmarks) · [BenchSDK packages](https://github.com/computesdk/benchmarks#benchsdk-packages)

## Install

```bash
npm install @benchsdk/worker @benchsdk/api
```

Use `runWorker(client, options)` with an authenticated client from [`@benchsdk/api`](https://www.npmjs.com/package/@benchsdk/api) to execute an assignment. `BenchmarkReporter` provides reporting helpers for custom worker integrations.

To write a workload or run it through the `bench` CLI, use [`@benchsdk/runner`](https://www.npmjs.com/package/@benchsdk/runner), which manages the worker lifecycle for you.
