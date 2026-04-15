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
    name: 'kernel',
    requiredEnvVars: ['KERNEL_API_KEY'],
    createBrowserProvider: () => kernel({
      apiKey: process.env.KERNEL_API_KEY!
    }),
  },
  //
  // add more browser providers above
];
