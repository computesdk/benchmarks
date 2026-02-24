import { e2b } from '@computesdk/e2b';
import { daytona } from '@computesdk/daytona';
import { blaxel } from '@computesdk/blaxel';
import { modal } from '@computesdk/modal';
import { vercel } from '@computesdk/vercel';
import { hopx } from '@computesdk/hopx';
import { codesandbox } from '@computesdk/codesandbox';
import { runloop } from '@computesdk/runloop';
import { compute } from 'computesdk';
import type { ProviderConfig } from './types.js';

/**
 * All provider benchmark configurations.
 *
 * Direct mode providers use ComputeSDK's open source package directly (no ComputeSDK API key).
 * Automatic mode providers route through the ComputeSDK gateway (requires COMPUTESDK_API_KEY).
 */
export const providers: ProviderConfig[] = [
  // --- Direct mode (provider SDK packages) ---
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
    createCompute: () => blaxel({ apiKey: process.env.BL_API_KEY!, workspace: process.env.BL_WORKSPACE!, image: 'blaxel/benchmark:latest', region: 'us-was-1' }),
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
  {
    name: 'hopx',
    requiredEnvVars: ['HOPX_API_KEY'],
    createCompute: () => hopx({ apiKey: process.env.HOPX_API_KEY! }),
  },
  {
    name: 'codesandbox',
    requiredEnvVars: ['CSB_API_KEY'],
    createCompute: () => codesandbox({ apiKey: process.env.CSB_API_KEY! }),
  },
  {
    name: 'runloop',
    requiredEnvVars: ['RUNLOOP_API_KEY'],
    createCompute: () => runloop({ apiKey: process.env.RUNLOOP_API_KEY! }),
  },
  // --- Automatic mode (via ComputeSDK gateway) ---
  {
    name: 'namespace',
    requiredEnvVars: ['COMPUTESDK_API_KEY', 'NSC_TOKEN'],
    createCompute: () => {
      compute.setConfig({
        provider: 'namespace',
        computesdkApiKey: process.env.COMPUTESDK_API_KEY!,
        namespace: { token: process.env.NSC_TOKEN! },
      } as any);
      return compute;
    },
  },
  {
    name: 'railway',
    requiredEnvVars: ['COMPUTESDK_API_KEY', 'RAILWAY_API_KEY', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID'],
    createCompute: () => {
      compute.setConfig({
        provider: 'railway',
        computesdkApiKey: process.env.COMPUTESDK_API_KEY!,
        railway: { apiToken: process.env.RAILWAY_API_KEY!, projectId: process.env.RAILWAY_PROJECT_ID!, environmentId: process.env.RAILWAY_ENVIRONMENT_ID! },
      } as any);
      return compute;
    },
  },
  {
    name: 'render',
    requiredEnvVars: ['COMPUTESDK_API_KEY', 'RENDER_API_KEY', 'RENDER_OWNER_ID'],
    createCompute: () => {
      compute.setConfig({
        provider: 'render',
        computesdkApiKey: process.env.COMPUTESDK_API_KEY!,
        render: { apiKey: process.env.RENDER_API_KEY!, ownerId: process.env.RENDER_OWNER_ID! },
      } as any);
      return compute;
    },
  },
];
