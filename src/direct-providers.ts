import { e2b } from '@computesdk/e2b';
import { daytona } from '@computesdk/daytona';
import { blaxel } from '@computesdk/blaxel';
import { modal } from '@computesdk/modal';
import { vercel } from '@computesdk/vercel';
import type { DirectBenchmarkConfig } from './types.js';

/**
 * Direct mode provider configurations.
 *
 * These use individual provider packages (@computesdk/e2b, etc.) that wrap
 * provider SDKs directly — no ComputeSDK API key or orchestrator required.
 */
export const directProviders: DirectBenchmarkConfig[] = [
  {
    name: 'e2b',
    requiredEnvVars: ['E2B_API_KEY'],
    createCompute: () => e2b({ apiKey: process.env.E2B_API_KEY! }),
  },
  {
    name: 'daytona',
    requiredEnvVars: ['DAYTONA_API_KEY'],
    createCompute: () => daytona({ apiKey: process.env.DAYTONA_API_KEY! }),
  },
  {
    name: 'blaxel',
    requiredEnvVars: ['BL_API_KEY', 'BL_WORKSPACE'],
    createCompute: () => blaxel({ apiKey: process.env.BL_API_KEY!, workspace: process.env.BL_WORKSPACE! }),
  },
  {
    name: 'modal',
    requiredEnvVars: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
    createCompute: () => modal({ tokenId: process.env.MODAL_TOKEN_ID!, tokenSecret: process.env.MODAL_TOKEN_SECRET! }),
  },
  {
    name: 'vercel',
    requiredEnvVars: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'],
    createCompute: () => vercel({ token: process.env.VERCEL_TOKEN!, teamId: process.env.VERCEL_TEAM_ID!, projectId: process.env.VERCEL_PROJECT_ID! }),
  },
];
