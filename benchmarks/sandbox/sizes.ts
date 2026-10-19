import { VMTier } from '@codesandbox/sdk';

/**
 * Market size tiers — mirrors PLATFORM_SIZES in benchmarks-platform
 * (lib/sandboxes/sizes.ts): small / medium / large / xlarge.
 */
export const MARKET_SIZES = {
  small: { cpus: 1, memoryMb: 2048 },
  medium: { cpus: 2, memoryMb: 4096 },
  large: { cpus: 4, memoryMb: 8192 },
  xlarge: { cpus: 8, memoryMb: 16384 },
} as const;

export type MarketSize = keyof typeof MARKET_SIZES;
export const MARKET_SIZE_NAMES = Object.keys(MARKET_SIZES) as MarketSize[];

const allTiers = (
  build: (cpus: number, memoryMb: number) => Record<string, any>,
): Record<MarketSize, Record<string, any>> =>
  Object.fromEntries(
    MARKET_SIZE_NAMES.map((s) => [s, build(MARKET_SIZES[s].cpus, MARKET_SIZES[s].memoryMb)]),
  ) as Record<MarketSize, Record<string, any>>;

/**
 * Per-provider sandbox options per market size tier. Each provider uses
 * different parameter names and units, so we map per-provider.
 *
 * Providers that accept raw cpu/memory parameters get all four tiers; providers
 * sized by a prebuilt template or named preset only get the tiers they can
 * actually provision — a tier with no entry means "no such size", not
 * "quietly run the wrong size" (the benchmark marks that tier unsupported).
 *
 * Notes:
 * - E2B sets CPU/memory at template build time, not at sandbox creation —
 *   its xlarge comes from the 'base-8cpu-16gb' templateId in providers.ts.
 * - lightning is sized via LIGHTNING_INSTANCE_TYPE=cpu-8 (8 vCPU / 16 GiB),
 *   applied on the provider factory in providers.ts — the SDK ignores an
 *   instanceType passed to create().
 * - Providers not listed here don't support CPU/memory configuration at
 *   sandbox creation time; they run whatever their baseOptions provision.
 */
export const PROVIDER_SIZE_OPTIONS: Record<string, Partial<Record<MarketSize, Record<string, any>>>> = {
  // --- raw cpu/memory parameters: all four tiers ---
  // Modal: 1 core = 2 vCPUs, so cpus/2 (fractional cores are supported).
  modal: allTiers((c, m) => ({ cpu: c / 2, cpuLimit: c / 2, memoryMiB: m, templateId: 'node:22' })),
  // diskSizeGb: default disk cannot hold the OpenCode install (dax); harmless for cpu.
  tenki: allTiers((c, m) => ({ cpuCores: c, memoryMb: m, diskSizeGb: 20 })),
  tensorlake: allTiers((c, m) => ({ cpus: c, memoryMb: m })),
  isorun: allTiers((c, m) => ({ vcpus: c, memMiB: m })),
  runloop: allTiers((c, m) => ({
    launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: c, custom_gb_memory: m / 1024 },
  })),
  // Vercel has no memory control at create time.
  vercel: allTiers((c) => ({ resources: { vcpus: c } })),
  // Blaxel derives cores = memory_MB / 2048; volume keeps the writable root off RAM.
  blaxel: allTiers((c, m) => ({
    memory: m,
    timeout: 900_000, // Server-side TTL backstop if client cleanup cannot run
    volumes: [{ name: 'dax-root', type: 'ephemeral', sizeMb: 16384, mountPath: '/' }],
  })),
  // beam: cpu = cores, memory = MiB
  beam: allTiers((c, m) => ({ cpu: c, memory: m })),
  cloudflare: allTiers((c, m) => ({ vcpu: c, memoryMib: m, diskMb: 20000, image: 'builder' })),
  microsandbox: allTiers((c, m) => ({ cpus: c, memoryMib: m, rootDiskMib: 20480 })), // 20 GiB writable disk
  mosaic: allTiers((c, m) => ({ vcpus: c, memoryMb: m })),
  buddy: allTiers((c, m) => ({ cpu: c, memoryMb: m })), // provider maps cpu/memory to its 8x16 preset
  miosa: allTiers((c, m) => ({ vcpus: c, memory: m })), // maps to MIOSA size contract "large" at xlarge
  // givemeanode has no 8 vCPU / 16 GiB named shape; asking for 8 vCPU and 16 GiB
  // selects sandbox-lg (8 vCPU / 32 GiB). The actual memory is reported by the
  // benchmark script, so the mismatch is visible in results.
  givemeanode: allTiers((c, m) => ({ vcpus: c, memoryMiB: m })),
  // Sandbox0 exposes only memory — vcpus are reported by the benchmark script.
  sandbox0: allTiers((c, m) => ({ memory: m })),
  // opencomputer sizes in physical cores (cpuCount = vCPUs / 2); skip small
  // since 1 vCPU would require a fractional core.
  opencomputer: {
    medium: { cpuCount: 1, memoryMB: 4096, timeout: 600_000 },
    large: { cpuCount: 2, memoryMB: 8192, timeout: 600_000 },
    xlarge: { cpuCount: 4, memoryMB: 16384, timeout: 600_000 },
  },
  // --- template/preset-locked: xlarge only ---
  arker: { xlarge: { templateId: 'ubuntu-full-8' } },           // 8 vCPU / 16 GiB golden
  upstash: { xlarge: { size: 'large' } },                       // large = 8 cores, 16 GB
  codesandbox: { xlarge: { vmTier: VMTier.Small } },            // Small = 8 CPU, 16 GiB
  northflank: { xlarge: { deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN || 'nf-compute-50', ephemeralStorageSize: 5120 } }, // 5 GiB ephemeral storage
  declaw: { xlarge: { templateId: 'node-large' } },             // 8 vCPU / 16 GiB RAM / 8 GiB disk
  superserve: { xlarge: { templateId: 'node22-8cpu-16gb' } },   // template built in the workflow pre-step
  createos: { xlarge: { shape: 's-8vcpu-16gb', ephemeralDiskMb: 61440 } }, // 8 vCPU, 16 GiB, 60 GiB disk
  gravixlayer: { xlarge: { templateId: 'base-4xlarge' } },      // built-in template requested by the Gravix team
  sail: { xlarge: { size: 'l' } },
  // Novita sizes via templates (E2B-style); dax runs on the node22-8cpu-16gb
  // template built in the workflow pre-step (same pattern as superserve/e2b).
  // The provider's default sandbox lifetime (300s) is below the 10-min build
  // deadline, so raise it — same backstop pattern as blaxel.
  novita: { xlarge: { templateId: 'node22-8cpu-16gb', timeout: 900_000 } },
};

/**
 * The xlarge layer, kept as its own map for benchmarks that run a single
 * standardized size (dax).
 */
export const STANDARD_RESOURCE_OPTIONS: Record<string, Record<string, any>> = Object.fromEntries(
  Object.entries(PROVIDER_SIZE_OPTIONS).flatMap(([provider, tiers]) =>
    tiers.xlarge ? [[provider, tiers.xlarge]] : [],
  ),
);

/**
 * Merges a provider's base sandboxOptions with its resource options for
 * `size`. Returns undefined when the provider has no offering at that tier —
 * the caller should treat that as "size not supported" rather than fall back
 * to a wrong-size sandbox. At `xlarge`, providers without an entry keep the
 * historical behavior of running their default/base options.
 */
export function getSandboxOptionsWithResources(
  providerName: string,
  baseOptions?: Record<string, any>,
  size: MarketSize = 'xlarge',
): Record<string, any> | undefined {
  const resourceOpts = PROVIDER_SIZE_OPTIONS[providerName]?.[size];
  if (resourceOpts === undefined) {
    return size === 'xlarge' ? (baseOptions ?? {}) : undefined;
  }
  return { ...baseOptions, ...resourceOpts };
}
