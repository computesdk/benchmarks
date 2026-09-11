import { createBenchmarkClient as createApiClient, BenchmarkApiError, runWorker } from '@benchsdk/runner';
import type {
  BenchmarkClient as BenchmarkApiClient,
  BenchmarkClientConfig,
  RunWorkerOptions,
  RunWorkerResult,
} from '@benchsdk/runner';

export { BenchmarkApiError };

/**
 * @deprecated `@benchsdk/client` is a backwards-compatibility shim. The
 * `runWorker` method is available here for existing callers; new code should
 * import `runWorker` from `@benchsdk/runner` directly.
 */
export type BenchmarkClient = BenchmarkApiClient & {
  runWorker(options: RunWorkerOptions): Promise<RunWorkerResult>;
};

export type { BenchmarkClientConfig };

/**
 * @deprecated Use `createBenchmarkClient` from `@benchsdk/runner` and call
 * `runWorker(client, options)` instead. This wrapper only exists to preserve the
 * `client.runWorker(...)` spelling used by older `@benchsdk/client` consumers.
 */
export function createBenchmarkClient(config: BenchmarkClientConfig = {}): BenchmarkClient {
  const apiClient = createApiClient(config);
  return {
    ...apiClient,
    runWorker: (options: RunWorkerOptions) => runWorker(apiClient, options),
  };
}
