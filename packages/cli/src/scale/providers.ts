// import { daytona } from '@computesdk/daytona';
import { declaw } from '@computesdk/declaw';
import { e2b } from '@computesdk/e2b';
import { isorun } from '@computesdk/isorun';
import { modal } from '@computesdk/modal';
import { northflank } from '@computesdk/northflank';
import { runloop } from '@computesdk/runloop';
import { tensorlake } from '@computesdk/tensorlake';
//import { vercel } from '@computesdk/vercel';
import type { BurstProviderConfig } from './types.js';

/**
 * Providers opted into the 100k burst benchmark.
 *
 * A provider participates iff it has an entry here. This mirrors the
 * convention in src/sandbox/providers.ts; presence is the opt-in signal.
 *
 * `sandboxOptions.timeout` (in ms) is the per-sandbox keep-alive. This is
 * the canonical field name across the @computesdk/* adapters — each adapter
 * destructures `options.timeout` and maps it to the provider's native field
 * (e2b → timeoutMs, runloop/declaw/tensorlake → seconds, etc.). The
 * two-phase runner holds every sandbox alive between create and the
 * coordinated end-of-test destroy, so this value must comfortably exceed
 * the worst-case burst duration. 30min is conservative.
 *
 * Modal is the exception: its adapter ignores `timeout` and uses whatever
 * default it applies. If that's shorter than the burst, modal sandboxes
 * will auto-destroy mid-test and be counted as partial.
 *
 * Daytona is also an exception: its adapter maps `timeout` to the create-call
 * wait timeout (how long to wait for create to resolve), not a keep-alive.
 * Daytona's actual keep-alive control is `autoStopInterval` (minutes, 0 =
 * disabled), passed through as a provider option. We set it to 0 so the
 * coordinated end-of-test destroy is the only thing that stops the sandbox.
 */
const KEEP_ALIVE_MS = 30 * 60_000;

export const providers: BurstProviderConfig[] = [
  {
    name: 'e2b',
    requiredEnvVars: ['E2B_API_KEY'],
    createCompute: () => e2b({ apiKey: process.env.E2B_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
    sandboxOptions: { timeout: KEEP_ALIVE_MS },
  },
  {
    name: 'modal',
    requiredEnvVars: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
    createCompute: () => modal({
      tokenId: process.env.MODAL_TOKEN_ID!,
      tokenSecret: process.env.MODAL_TOKEN_SECRET!,
      scalableSandboxes: true,
    }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
  },
  {
    name: 'runloop',
    requiredEnvVars: ['RUNLOOP_API_KEY'],
    createCompute: () => runloop({ apiKey: process.env.RUNLOOP_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
    sandboxOptions: { timeout: KEEP_ALIVE_MS },
  },
  {
    name: 'tensorlake',
    requiredEnvVars: ['TENSORLAKE_API_KEY'],
    createCompute: () => tensorlake({ apiKey: process.env.TENSORLAKE_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
    sandboxOptions: { timeout: KEEP_ALIVE_MS, cpus: 0.1, memoryMb: 100, ephemeralDiskMb: 100 },
  },
  {
    name: 'declaw',
    requiredEnvVars: ['DECLAW_API_KEY'],
    createCompute: () => declaw({ apiKey: process.env.DECLAW_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
    sandboxOptions: { timeout: KEEP_ALIVE_MS },
  },
  {
    name: 'isorun',
    requiredEnvVars: ['ISORUN_API_KEY'],
    createCompute: () => isorun({ apiKey: process.env.ISORUN_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
    sandboxOptions: { timeout: KEEP_ALIVE_MS },
  },
  {
    name: 'northflank',
    requiredEnvVars: ['NORTHFLANK_TOKEN', 'NORTHFLANK_PROJECT_ID'],
    createCompute: () => northflank({
      token: process.env.NORTHFLANK_TOKEN!,
      projectId: process.env.NORTHFLANK_PROJECT_ID!,
      runtime: 'node',
    }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
  },
  // {
  //   name: 'vercel',
  //   requiredEnvVars: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'],
  //   createCompute: () => vercel({
  //     token: process.env.VERCEL_TOKEN!,
  //     teamId: process.env.VERCEL_TEAM_ID!,
  //     projectId: process.env.VERCEL_PROJECT_ID!,
  //   }),
  //   concurrencyTarget: 100_000,
  //   perRequestTimeoutMs: 120_000,
  //   sandboxOptions: { timeout: KEEP_ALIVE_MS },
  // },
  // {
  //   name: 'daytona',
  //   requiredEnvVars: ['DAYTONA_API_KEY'],
  //   createCompute: () => daytona({ apiKey: process.env.DAYTONA_API_KEY! }),
  //   concurrencyTarget: 100_000,
  //   perRequestTimeoutMs: 120_000,
  //   sandboxOptions: { autoStopInterval: 0 },
  // },
];

export function getProvider(name: string): BurstProviderConfig {
  const found = providers.find(p => p.name === name);
  if (!found) {
    const available = providers.map(p => p.name).join(', ');
    throw new Error(`Provider not opted in: ${name}. Available: ${available}`);
  }
  return found;
}
