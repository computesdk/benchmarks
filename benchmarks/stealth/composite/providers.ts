/**
 * Union of provider identities reported by every categorized benchmark.
 *
 * These participants never provision compute: the benchmark only reads each
 * provider's daily compositeScore from the benchmarks-platform v1 API. Every
 * entry therefore has empty `requiredEnvVars` and a `createCompute` stub that
 * throws if it is ever invoked (it never is — the task only calls the API).
 * `name` must match what benchmarks report as `provider` in run summaries.
 *
 * Keep this list in sync with the matrix in
 * `.github/workflows/provider-weekly-composite.yml`.
 */
import type { ProviderConfig } from './types.js';

// Canonical sandbox registry — mirrors benchmarks/stealth/sandbox/providers.ts.
const SANDBOX_PROVIDERS = [
  'agent37',
  'archil',
  'arker',
  'beam',
  'blaxel',
  'boat',
  'briq',
  'buddy',
  'cloud-run',
  'cloudflare',
  'codesandbox',
  'createos',
  'daytona',
  'declaw',
  'e2b',
  'freestyle',
  'sfcompute',
  'gravixlayer',
  'hopx',
  'isorun',
  'kosa8',
  // 'lightning', // parked — re-activate with the sandbox registry entry
  'modal',
  'microsandbox',
  'promigence',
  'miosa',
  'mosaic',
  'namespace',
  'northflank',
  'novita',
  // 'opencomputer', // parked — re-activate with the sandbox registry entry
  'railway',
  'run-cloud',
  'sandbox0',
  'sail',
  'sprites',
  'styne',
  'superserve',
  'luxor',
  'tensorlake',
  'uno',
  'upstash',
  'vercel',
] as const;

// Browser-only providers — benchmarks/stealth/browser/concurrent-providers.ts (and the
// upstream computesdk/benchmarks browser registry).
const BROWSER_PROVIDERS = ['browserbase', 'browseruse', 'hyperbrowser', 'kernel', 'notte', 'steel', 'tilion'] as const;

// Storage-only providers — benchmarks/stealth/storage/providers.ts (tensorlake/archil
// already appear in the sandbox list).
const STORAGE_PROVIDERS = ['aws-s3', 'azure-blob', 'cloudflare-r2', 'gcs', 'neon', 'tigris', 'vercel-blob'] as const;

// AI gateway providers — upstream computesdk/benchmarks ai-gateway registry
// (neon/novita already appear above).
const AI_GATEWAY_PROVIDERS = [
  'openrouter',
  'vercel-ai-gateway',
  'cloudflare-ai-gateway',
  'blazerail',
  'llmgateway',
  'pydantic-ai-gateway',
  'concentrate-ai-gateway',
  'ramp',
  'ngrok',
  'llmapi',
  'github-copilot',
  'anthropic-direct',
] as const;

export type CompositeCategory = 'sandbox' | 'browser' | 'storage' | 'ai-gateway';

export interface CategorizedProvider extends ProviderConfig {
  /** Categories this provider reports scores in (which legs it belongs to). */
  categories: readonly CompositeCategory[];
}

function identity(name: string, categories: readonly CompositeCategory[]): CategorizedProvider {
  return {
    name,
    categories,
    requiredEnvVars: [],
    createCompute: () => {
      throw new Error('provider-weekly-composite reads the benchmarks-platform API and never provisions compute');
    },
  };
}

const MULTI_CATEGORY: Record<string, readonly CompositeCategory[]> = {
  archil: ['sandbox', 'storage'],
  tensorlake: ['sandbox', 'storage'],
  neon: ['storage', 'ai-gateway'],
  novita: ['sandbox', 'ai-gateway'],
};

export const providers: CategorizedProvider[] = [
  ...SANDBOX_PROVIDERS.map((name) => identity(name, ['sandbox'])),
  ...BROWSER_PROVIDERS.map((name) => identity(name, ['browser'])),
  ...STORAGE_PROVIDERS.map((name) => identity(name, ['storage'])),
  ...AI_GATEWAY_PROVIDERS.map((name) => identity(name, ['ai-gateway'])),
].map((p) => (MULTI_CATEGORY[p.name] ? { ...p, categories: MULTI_CATEGORY[p.name] } : p));
