import { browserbase } from '@computesdk/browserbase';
import { browseruse } from '@computesdk/browseruse';
import { hyperbrowser } from '@computesdk/hyperbrowser';
import { kernel } from '@computesdk/kernel';
import { notte } from '@computesdk/notte';
import { steel } from '@computesdk/steel';
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
    sessionCreateOptions: {
      region: 'us-east-1',
      stealth: false,
      recordSession: false,
      enableNativeSelectPolyfill: false,
    },
  },
  {
    name: 'browseruse',
    requiredEnvVars: ['BROWSER_USE_API_KEY'],
    createBrowserProvider: () => browseruse({
      apiKey: process.env.BROWSER_USE_API_KEY!
    }),
    sessionCreateOptions: {
      proxies: false,
      stealth: false,
    },
  },
  {
    name: 'hyperbrowser',
    requiredEnvVars: ['HYPERBROWSER_API_KEY'],
    createBrowserProvider: () => hyperbrowser({
      apiKey: process.env.HYPERBROWSER_API_KEY!
    }),
    sessionCreateOptions: {
      region: 'us-east',
      stealth: false,
    },
  },
  {
    name: 'kernel',
    requiredEnvVars: ['KERNEL_API_KEY'],
    createBrowserProvider: () => kernel({
      apiKey: process.env.KERNEL_API_KEY!
    }),
    sessionCreateOptions: { stealth: false },
  },
  {
    name: 'notte',
    requiredEnvVars: ['NOTTE_API_KEY'],
    createBrowserProvider: () => notte({
      apiKey: process.env.NOTTE_API_KEY!
    }),
    sessionCreateOptions: { stealth: false },
  },
  {
    name: 'steel',
    requiredEnvVars: ['STEEL_API_KEY'],
    createBrowserProvider: () => steel({
      apiKey: process.env.STEEL_API_KEY!
    }),
    sessionCreateOptions: { stealth: false },
  },
  // add browser providers above
];
