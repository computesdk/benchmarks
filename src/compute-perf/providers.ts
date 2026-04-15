import { e2b } from '@computesdk/e2b';
import { daytona } from '@computesdk/daytona';
import { blaxel } from '@computesdk/blaxel';
import { hopx } from '@computesdk/hopx';
import { namespace } from '@computesdk/namespace';
import { runloop } from '@computesdk/runloop';
import type { ComputePerfProviderConfig } from './types.js';

/**
 * Providers that participate in sustained compute benchmark runs.
 *
 * Keep this list intentionally narrow to providers that position around
 * runner-style or general-purpose compute performance.
 */
export const computePerfProviders: ComputePerfProviderConfig[] = [
  {
    name: 'blaxel',
    requiredEnvVars: ['BL_API_KEY', 'BL_WORKSPACE'],
    createCompute: () => blaxel({ apiKey: process.env.BL_API_KEY!, workspace: process.env.BL_WORKSPACE!, region: 'us-was-1' }),
  },
  {
    name: 'daytona',
    requiredEnvVars: ['DAYTONA_API_KEY'],
    createCompute: () => daytona({ apiKey: process.env.DAYTONA_API_KEY! }),
    sandboxOptions: { autoStopInterval: 15, autoDeleteInterval: 0 },
  },
  {
    name: 'e2b',
    requiredEnvVars: ['E2B_API_KEY'],
    createCompute: () => e2b({ apiKey: process.env.E2B_API_KEY! }),
  },
  {
    name: 'hopx',
    requiredEnvVars: ['HOPX_API_KEY'],
    createCompute: () => hopx({ apiKey: process.env.HOPX_API_KEY! }),
  },
  {
    name: 'namespace',
    requiredEnvVars: ['NSC_TOKEN'],
    createCompute: () => namespace({ token: process.env.NSC_TOKEN! }),
    sandboxOptions: { image: 'node:22' },
  },
  {
    name: 'runloop',
    requiredEnvVars: ['RUNLOOP_API_KEY'],
    createCompute: () => runloop({ apiKey: process.env.RUNLOOP_API_KEY! }),
  },
];
