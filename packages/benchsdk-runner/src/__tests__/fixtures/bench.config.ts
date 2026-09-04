import type { BenchSdkConfig } from '../../cli.js';

const config: BenchSdkConfig = {
  iterations: 2,
  concurrency: 2,
  providers: ['local'],
  dryRun: true,
};

export default config;
