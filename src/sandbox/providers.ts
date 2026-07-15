import { archil } from '@computesdk/archil';
import { beam } from '@computesdk/beam';
import { blaxel } from '@computesdk/blaxel';
import { codesandbox } from '@computesdk/codesandbox';
import { cloudRun } from '@computesdk/cloud-run';
// import { collimate } from '@computesdk/collimate';
import { cloudflare } from '@computesdk/cloudflare';
import { createosSandbox } from '@computesdk/createos-sandbox';
import { daytona } from '@computesdk/daytona';
import { declaw } from '@computesdk/declaw';
import { e2b } from '@computesdk/e2b';
import { hopx } from '@computesdk/hopx';
import { isorun } from '@computesdk/isorun';
import { lelantos } from '@computesdk/lelantos';
import { lightning } from '@computesdk/lightning';
import { modal } from '@computesdk/modal';
// import { namespace } from '@computesdk/namespace';
import { northflank } from '@computesdk/northflank';
// import { quilt } from '@computesdk/quilt';
// import { railway } from '@computesdk/railway';
import { runloop } from '@computesdk/runloop';
import { sprites } from '@computesdk/sprites';
import { superserve } from '@computesdk/superserve';
// import { tenki } from '@computesdk/tenki';
import { tensorlake } from '@computesdk/tensorlake'
import { upstash } from '@computesdk/upstash';
import { vercel } from '@computesdk/vercel';
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
    name: 'archil',
    requiredEnvVars: ['ARCHIL_API_KEY', 'ARCHIL_REGION', 'ARCHIL_DISK_ID'],
    createCompute: () => archil({ apiKey: process.env.ARCHIL_API_KEY!, region: process.env.ARCHIL_REGION! }),
    sandboxOptions: { diskId: process.env.ARCHIL_DISK_ID! }
  },
  {
    // Activated in daily + PR benchmarks once BEAM_TOKEN / BEAM_WORKSPACE_ID secrets landed.
    name: 'beam',
    requiredEnvVars: ['BEAM_TOKEN', 'BEAM_WORKSPACE_ID'],
    createCompute: () => beam({ token: process.env.BEAM_TOKEN!, workspaceId: process.env.BEAM_WORKSPACE_ID! }),
    sandboxOptions: { name: 'computesdk-benchmarks', runtime: 'node' },
  },
  {
    name: 'blaxel',
    requiredEnvVars: ['BL_API_KEY', 'BL_WORKSPACE'],
    createCompute: () => blaxel({ apiKey: process.env.BL_API_KEY!, workspace: process.env.BL_WORKSPACE!, region: 'us-was-1' }),
  },
  {
    name: 'cloud-run',
    requiredEnvVars: ['CLOUD_RUN_SANDBOX_URL', 'CLOUD_RUN_SANDBOX_SECRET'],
    createCompute: () => cloudRun({ sandboxUrl: process.env.CLOUD_RUN_SANDBOX_URL!, sandboxSecret: process.env.CLOUD_RUN_SANDBOX_SECRET! }),
  },
  {
    name: 'cloudflare',
    requiredEnvVars: ['CLOUDFLARE_SANDBOX_URL', 'CLOUDFLARE_SANDBOX_SECRET'],
    createCompute: () => cloudflare({ sandboxUrl: process.env.CLOUDFLARE_SANDBOX_URL!, sandboxSecret: process.env.CLOUDFLARE_SANDBOX_SECRET! }),
  },
  {
    name: 'codesandbox',
    requiredEnvVars: ['CSB_API_KEY'],
    createCompute: () => codesandbox({ apiKey: process.env.CSB_API_KEY! }),
    destroyTimeoutMs: 1_000,
  },
  // {
  //   name: 'collimate',
  //   requiredEnvVars: ['COLLIMATE_API_KEY'],
  //   createCompute: () => collimate({ apiKey: process.env.COLLIMATE_API_KEY! }),
  // },
  {
    name: 'createos',
    requiredEnvVars: ['CREATEOS_SANDBOX_API_KEY'],
    createCompute: () => createosSandbox({ apiKey: process.env.CREATEOS_SANDBOX_API_KEY! }),
  },
  {
    name: 'daytona',
    requiredEnvVars: ['DAYTONA_API_KEY'],
    createCompute: () => daytona({ apiKey: process.env.DAYTONA_API_KEY! }),
    sandboxOptions: { autoStopInterval: 15, autoDeleteInterval: 0 },
  },
  {
    name: 'declaw',
    requiredEnvVars: ['DECLAW_API_KEY'],
    createCompute: () => declaw({ apiKey: process.env.DECLAW_API_KEY! }),
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
    name: 'isorun',
    requiredEnvVars: ['ISORUN_API_KEY'],
    createCompute: () => isorun({ apiKey: process.env.ISORUN_API_KEY! }),
    sandboxOptions: { image: 'node:22' },
  },
  {
    name: 'lelantos',
    requiredEnvVars: ['LELANTOS_API_KEY'],
    createCompute: () => lelantos({ apiKey: process.env.LELANTOS_API_KEY! }),
  },
  {
    name: 'lightning',
    requiredEnvVars: ['LIGHTNING_API_KEY'],
    createCompute: () => lightning({ apiKey: process.env.LIGHTNING_API_KEY! }),
  },
  {
    name: 'modal',
    requiredEnvVars: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
    createCompute: () => modal({ tokenId: process.env.MODAL_TOKEN_ID!, tokenSecret: process.env.MODAL_TOKEN_SECRET!, scalableSandboxes: true }),
  },
  // {
  //   name: 'namespace',
  //   requiredEnvVars: ['NSC_TOKEN'],
  //   createCompute: () => namespace({ token: process.env.NSC_TOKEN! }),
  //   sandboxOptions: { image: 'node:22' },
  // },
  {
    name: 'northflank',
    requiredEnvVars: ['NORTHFLANK_TOKEN', 'NORTHFLANK_PROJECT_ID'],
    createCompute: () => northflank({
      token: process.env.NORTHFLANK_TOKEN!,
      projectId: process.env.NORTHFLANK_PROJECT_ID!,
      runtime: 'node',
    }),
  },
  // {
  //   name: 'quilt',
  //   requiredEnvVars: ['QUILT_API_KEY', 'QUILT_BASE_URL'],
  //   createCompute: () => quilt({ apiKey: process.env.QUILT_API_KEY!, baseUrl: process.env.QUILT_BASE_URL! }),
  // },
  // {
  //   name: 'railway',
  //   requiredEnvVars: ['RAILWAY_API_TOKEN', 'RAILWAY_ENVIRONMENT_ID'],
  //   createCompute: () => railway({ token: process.env.RAILWAY_API_TOKEN!, environmentId: process.env.RAILWAY_ENVIRONMENT_ID! }),
  // },
  {
    name: 'runloop',
    requiredEnvVars: ['RUNLOOP_API_KEY'],
    createCompute: () => runloop({ apiKey: process.env.RUNLOOP_API_KEY! }),
  },
  {
    name: 'sprites',
    requiredEnvVars: ['SPRITES_TOKEN'],
    createCompute: () => sprites({ apiKey: process.env.SPRITES_TOKEN! }),
  },
  {
    name: 'superserve',
    requiredEnvVars: ['SUPERSERVE_API_KEY'],
    createCompute: () => superserve({ apiKey: process.env.SUPERSERVE_API_KEY! }),
    // Default template (superserve/base) has no Node; the `node -v` readiness probe needs it.
    sandboxOptions: { templateId: 'superserve/node-22' },
  },
  // {
  //   name: 'tenki',
  //   requiredEnvVars: ['TENKI_API_KEY'],
  //   createCompute: () => tenki({ apiKey: process.env.TENKI_API_KEY! }),
  // },
  {
    name: 'tensorlake',
    requiredEnvVars: ['TENSORLAKE_API_KEY'],
    createCompute: () => tensorlake({ apiKey: process.env.TENSORLAKE_API_KEY! }),
  },
  {
    name: 'upstash',
    requiredEnvVars: ['UPSTASH_BOX_API_KEY'],
    createCompute: () => upstash({ apiKey: process.env.UPSTASH_BOX_API_KEY! }),
    sandboxOptions: { ephemeral: true },
  },
  {
    name: 'vercel',
    requiredEnvVars: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'],
    createCompute: () => vercel({ token: process.env.VERCEL_TOKEN!, teamId: process.env.VERCEL_TEAM_ID!, projectId: process.env.VERCEL_PROJECT_ID! }),
  },
];
