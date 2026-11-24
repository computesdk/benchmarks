import { browserbase } from '@computesdk/browserbase';
import { browseruse } from '@computesdk/browseruse';
import { hyperbrowser } from '@computesdk/hyperbrowser';
import { kernel } from '@computesdk/kernel';
import { notte } from '@computesdk/notte';
import { steel } from '@computesdk/steel';
import { styneBrowser } from '@computesdk/styne-browser';
import { tilion } from '@computesdk/tilion';

export interface SessionPersistenceProviderConfig {
  name: string;
  iterations?: number;
  timeout?: number;
  requiredEnvVars: string[];
  createBrowserProvider: () => any;
  sessionCreateOptions?: Record<string, unknown>;
}

/**
 * Session persistence benchmark provider configurations.
 *
 * Same eight browser-agent providers as browser-concurrency, but sessions are
 * created with `keepAlive: true`: the benchmark measures whether a session
 * survives a client disconnect, which is the flag providers expose for it.
 * Providers that reject the option are retried without it at create time and
 * recorded via `keepAliveAccepted`.
 */
const VIEWPORT = { width: 1920, height: 1080 };

export const sessionPersistenceProviders: SessionPersistenceProviderConfig[] = [
  {
    name: 'browserbase',
    requiredEnvVars: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    createBrowserProvider: () => browserbase({
      apiKey: process.env.BROWSERBASE_API_KEY!,
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
    }),
    sessionCreateOptions: {
      region: 'us-west-2',
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      recordSession: false,
      enableNativeSelectPolyfill: false,
      keepAlive: true,
    },
  },
  {
    name: 'browseruse',
    requiredEnvVars: ['BROWSER_USE_API_KEY'],
    createBrowserProvider: () => browseruse({
      apiKey: process.env.BROWSER_USE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      keepAlive: true,
    },
  },
  {
    name: 'hyperbrowser',
    requiredEnvVars: ['HYPERBROWSER_API_KEY'],
    createBrowserProvider: () => hyperbrowser({
      apiKey: process.env.HYPERBROWSER_API_KEY!,
    }),
    sessionCreateOptions: {
      region: 'us-east',
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      keepAlive: true,
    },
  },
  {
    name: 'kernel',
    requiredEnvVars: ['KERNEL_API_KEY'],
    createBrowserProvider: () => kernel({
      apiKey: process.env.KERNEL_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      keepAlive: true,
    },
  },
  {
    name: 'notte',
    requiredEnvVars: ['NOTTE_API_KEY'],
    createBrowserProvider: () => notte({
      apiKey: process.env.NOTTE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      keepAlive: true,
    },
  },
  {
    name: 'steel',
    requiredEnvVars: ['STEEL_API_KEY'],
    createBrowserProvider: () => steel({
      apiKey: process.env.STEEL_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      keepAlive: true,
    },
  },
  {
    name: 'styne',
    requiredEnvVars: ['STYNE_API_KEY'],
    createBrowserProvider: () => styneBrowser({
      apiKey: process.env.STYNE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      keepAlive: true,
    },
  },
  {
    name: 'tilion',
    requiredEnvVars: ['TILION_API_KEY', 'TILION_BASE_URL'],
    createBrowserProvider: () => tilion({
      apiKey: process.env.TILION_API_KEY!,
      baseUrl: process.env.TILION_BASE_URL!,
    }),
    sessionCreateOptions: {
      stealth: false,
      proxies: false,
      headless: true,
      viewport: VIEWPORT,
      keepAlive: true,
    },
  },
];
