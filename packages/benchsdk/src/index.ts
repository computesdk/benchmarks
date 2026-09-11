/**
 * @deprecated `@benchsdk/client` is a backwards-compatibility shim over
 * `@benchsdk/runner`. New code should import from `@benchsdk/runner`.
 */
export * from '@benchsdk/runner';
export { createBenchmarkClient } from './client.js';
export type { BenchmarkClient, BenchmarkClientConfig } from './client.js';
