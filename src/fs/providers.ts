import { providers } from '../sandbox/providers.js';
import type { FsProviderConfig } from './types.js';

export const fsProviders: FsProviderConfig[] = providers.map((p) => ({
  name: p.name,
  requiredEnvVars: p.requiredEnvVars,
  createCompute: p.createCompute,
  sandboxOptions: p.sandboxOptions,
  destroyTimeoutMs: p.destroyTimeoutMs,
}));
