# @benchsdk/api

Query the ComputeSDK benchmark platform from TypeScript. Use the typed REST client to list benchmarks, read runs and results, or report measurements from your own tooling.

[Public benchmarks](https://www.computesdk.com/benchmarks) · [BenchSDK packages](https://github.com/computesdk/benchmarks#benchsdk-packages)

## Install

```bash
npm install @benchsdk/api
```

## Query public benchmarks

Create a platform API key in the [ComputeSDK dashboard](https://platform.computesdk.com) and set `COMPUTESDK_API_KEY` in your environment.

```typescript
import { createBenchmarkClient } from '@benchsdk/api';

const client = createBenchmarkClient({
  apiKey: process.env.COMPUTESDK_API_KEY,
});

const benchmarks = await client.listBenchmarks({ group: 'public' });
console.log(benchmarks);
```
