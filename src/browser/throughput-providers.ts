import { browserbase } from '@computesdk/browserbase';
import { browseruse } from '@computesdk/browseruse';
import { hyperbrowser } from '@computesdk/hyperbrowser';
import { kernel } from '@computesdk/kernel';
import { notte } from '@computesdk/notte';
import { steel } from '@computesdk/steel';
import type { ThroughputProviderConfig } from './throughput-types.js';

/**
 * Throughput benchmark provider configurations.
 *
 * Mirrors src/browser/providers.ts but overrides sessionCreateOptions to
 * include stealth + a 1920x1080 viewport for every provider — these are the
 * settings agent workloads typically use.
 */
const VIEWPORT = { width: 1920, height: 1080 };

export const throughputProviders: ThroughputProviderConfig[] = [
  {
    name: 'browserbase',
    requiredEnvVars: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    createBrowserProvider: () => browserbase({
      apiKey: process.env.BROWSERBASE_API_KEY!,
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
    }),
    sessionCreateOptions: {
      region: 'us-east-1',
      stealth: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
  {
    name: 'browseruse',
    requiredEnvVars: ['BROWSER_USE_API_KEY'],
    createBrowserProvider: () => browseruse({
      apiKey: process.env.BROWSER_USE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: true,
      headless: true,
      viewport: VIEWPORT,
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
      stealth: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
  {
    name: 'kernel',
    requiredEnvVars: ['KERNEL_API_KEY'],
    createBrowserProvider: () => kernel({
      apiKey: process.env.KERNEL_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
  {
    name: 'notte',
    requiredEnvVars: ['NOTTE_API_KEY'],
    createBrowserProvider: () => notte({
      apiKey: process.env.NOTTE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
  {
    name: 'steel',
    requiredEnvVars: ['STEEL_API_KEY'],
    createBrowserProvider: () => steel({
      apiKey: process.env.STEEL_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
];
