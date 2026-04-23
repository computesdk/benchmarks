import { browserbase } from '@computesdk/browserbase';
import { kernel } from '@computesdk/kernel';
import type { BrowserProviderConfig } from './types.js';

/**
 * Browser provider benchmark configurations.
 *
 * All providers use ComputeSDK's browser packages directly (no ComputeSDK API key).
 */
export const browserProviders: BrowserProviderConfig[] = [
  {
    name: 'browserbase',
    requiredEnvVars: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    createBrowserProvider: () => browserbase({
      apiKey: process.env.BROWSERBASE_API_KEY!,
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
    }),
  },
  {
    name: 'kernel',
    requiredEnvVars: ['KERNEL_API_KEY'],
    createBrowserProvider: () => kernel({
      apiKey: process.env.KERNEL_API_KEY!
    }),
  },
  //
  // add browser providers above
];
