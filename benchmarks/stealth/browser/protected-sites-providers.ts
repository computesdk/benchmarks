import { browserbase } from '@computesdk/browserbase';
import { browseruse } from '@computesdk/browseruse';
import { hyperbrowser } from '@computesdk/hyperbrowser';
import { kernel } from '@computesdk/kernel';
import { notte } from '@computesdk/notte';
import { outcrawl } from '@computesdk/outcrawl';
import { steel } from '@computesdk/steel';
import { styneBrowser } from '@computesdk/styne-browser';
import { tilion } from '@computesdk/tilion';
import type { ConcurrentProviderConfig } from './concurrent-types.js';

/**
 * Protected-sites provider configurations — the same nine providers as
 * concurrent-providers.ts, but with `stealth: true` (and `proxies: true`
 * where the adapter maps it). Stealth support notes, per the current adapter
 * implementations:
 *
 * - browserbase: stealth → browserSettings.advancedStealth; proxies →
 *   browserbase managed proxies. Its `solveCaptchas` defaults to true, so
 *   CAPTCHA solving is exercised.
 * - browseruse: stealth is always on (the adapter only warns on the flag);
 *   `proxies` only accepts an array or false — a US datacenter geolocation is
 *   the closest expressible option. No CAPTCHA-solve flag.
 * - hyperbrowser: stealth → useStealth; proxies → useProxy. The underlying
 *   SDK's `solveCaptchas` option is not exposed through sessionCreateOptions.
 * - kernel: stealth → stealth mode (CAPTCHA solving included); proxies →
 *   a kernel managed US residential proxy, which replaces the shared ISP
 *   proxy stealth sessions egress through by default.
 * - notte: stealth is not a per-session option (adapter warns; applied
 *   server-side); proxies → notte's default proxy pool. `solve_captchas`
 *   is not exposed through sessionCreateOptions.
 * - steel: stealth → stealthConfig.humanizeInteractions; proxies →
 *   useProxy/proxyUrl. `solveCaptcha` is not exposed through
 *   sessionCreateOptions.
 * - outcrawl: every session is already a stealth browser on a residential
 *   exit; the adapter adds no params for `stealth`/`proxies: true`.
 * - styne: stealth → `captcha: 'solve'` (metered per solve, on top of the
 *   default unblock + CAPTCHA click); proxies → residential exit.
 * - tilion: the adapter ignores sessionCreateOptions entirely — sessions
 *   are always non-stealth on direct egress. Kept for coverage; expected to
 *   fail protected sites.
 */
const VIEWPORT = { width: 1920, height: 1080 };

export const protectedSitesProviders: ConcurrentProviderConfig[] = [
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
      proxies: true,
      headless: true,
      viewport: VIEWPORT,
      recordSession: false,
      enableNativeSelectPolyfill: false,
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
      // browseruse's adapter only accepts a proxy config array (or false).
      proxies: [{ type: 'datacenter', geolocation: { country: 'US' } }],
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
      proxies: true,
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
      proxies: true,
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
      stealth: true, // warned/dropped: notte has no per-session stealth flag
      proxies: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
  {
    name: 'outcrawl',
    requiredEnvVars: ['OUTCRAWL_API_KEY'],
    createBrowserProvider: () => outcrawl({
      apiKey: process.env.OUTCRAWL_API_KEY!,
    }),
    sessionCreateOptions: {
      // Every Outcrawl session is stealth on a residential exit already.
      stealth: true,
      proxies: true,
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
      stealth: true, // maps to stealthConfig.humanizeInteractions
      proxies: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
  {
    name: 'styne',
    requiredEnvVars: ['STYNE_API_KEY'],
    createBrowserProvider: () => styneBrowser({
      apiKey: process.env.STYNE_API_KEY!,
    }),
    sessionCreateOptions: {
      stealth: true,
      proxies: true,
      headless: true,
      viewport: VIEWPORT,
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
      // Ignored by the adapter entirely — included for documentation.
      stealth: true,
      proxies: true,
      headless: true,
      viewport: VIEWPORT,
    },
  },
];
