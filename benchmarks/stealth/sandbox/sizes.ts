import { VMTier } from '@codesandbox/sdk';
import { SIZE_TEMPLATES, type SizeTemplateProvider } from './size-templates.js';

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

const templateTiers = (provider: SizeTemplateProvider, extra: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries(SIZE_TEMPLATES[provider]).map(([tier, t]) => [tier, { templateId: t.name, ...extra }]),
  ) as unknown as Record<MarketSize, Record<string, unknown>>;

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
 *   small–large use per-size team templates via sizeClass; its xlarge comes
 *   from the 'csdk-node22-8cpu-16gb' templateId in providers.ts.
 * - lightning is sized via LIGHTNING_INSTANCE_TYPE (8 vCPU / 16 GiB),
 *   applied on the provider factory in providers.ts — the SDK ignores an
 *   instanceType passed to create().
 * - archil's exec mode has no VM sizing; persistent VMs take sizeClass.
 * - `null` marks a tier the provider explicitly cannot provision — needed
 *   for xlarge, where a missing entry falls back to the base options.
 * - Providers not listed here don't support CPU/memory configuration at
 *   sandbox creation time; they run whatever their baseOptions provision.
 */
export const PROVIDER_SIZE_OPTIONS: Record<string, Partial<Record<MarketSize, Record<string, any> | null>>> = {
  // --- raw cpu/memory parameters: all four tiers ---
  'run-cloud': allTiers((c, m) => ({ cpu: c, memory: m })),
  // Modal: 1 core = 2 vCPUs, so cpus/2 (fractional cores are supported).
  modal: allTiers((c, m) => ({ cpu: c / 2, cpuLimit: c / 2, memoryMiB: m, templateId: 'node:22' })),
  // diskSizeGb: default disk is small; 20 GiB headroom is harmless for cpu.
  luxor: allTiers((c, m) => ({ cpuCores: c, memoryMb: m, diskSizeGb: 20 })),
  // Tensorlake's bench account rejects creates over its per-sandbox RAM cap
  // of 16000 MB — xlarge must floor under it or create is a limit error.
  // small stays under the tighter quota observed earlier (run-6: 0/3 at 1c/2G).
  tensorlake: {
    ...allTiers((c, m) => ({ cpus: c, memoryMb: m })),
    small: { cpus: 1, memoryMb: 1024 },
    xlarge: { cpus: 8, memoryMb: 16000 },
  },
  // isorun sizes to named tiers (micro 1/256, nano 1/1024, small 2/4096,
  // medium 4/8192, large 8/16384): market medium/large/xlarge map onto
  // small/medium/large, but there is no 1 vCPU / 2048 MiB tier — market
  // small is unsupported rather than substituted.
  isorun: {
    medium: { vcpus: 2, memMiB: 4096 },
    large: { vcpus: 4, memMiB: 8192 },
    xlarge: { vcpus: 8, memMiB: 16384 },
  },
  runloop: allTiers((c, m) => ({
    launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: c, custom_gb_memory: m / 1024 },
  })),
  // Vercel has no memory control at create time.
  vercel: allTiers((c) => ({ resources: { vcpus: c } })),
  // Blaxel derives cores = memory_MB / 2048; volume keeps the writable root off RAM.
  blaxel: allTiers((c, m) => ({
    memory: m,
    timeout: 900_000, // Server-side TTL backstop if client cleanup cannot run
    volumes: [{ name: 'cpu-root', type: 'ephemeral', sizeMb: 16384, mountPath: '/' }],
  })),
  // Briq's named sizes map 1:1 onto the market tiers via ComputeSDK sizeClass.
  briq: {
    small: { sizeClass: 'sm' },
    medium: { sizeClass: 'md' },
    large: { sizeClass: 'lg' },
    xlarge: { sizeClass: 'xl' },
  },
  // beam: cpu = cores, memory = MiB
  beam: allTiers((c, m) => ({ cpu: c, memory: m })),
  cloudflare: allTiers((c, m) => ({ vcpu: c, memoryMib: m, diskMb: 20000, image: 'builder' })),
  microsandbox: allTiers((c, m) => ({ cpus: c, memoryMib: m, rootDiskMib: 20480 })), // 20 GiB writable disk
  // Mosaic's 8 vCPU / 16 GiB offering is a build shape, not a create shape:
  // POST /v1/sandboxes only accepts 2048/1, 4096/2 and 8192/4. The xlarge
  // environment is materialized by the workflow pre-step (build-mosaic-
  // environment.ts); restoring it via snapshotId boots at its captured
  // shape — the memoryMb/vcpus sent alongside just have to be a supported
  // create pair, the gateway validates then ignores them on restore.
  mosaic: {
    ...allTiers((c, m) => ({ vcpus: c, memoryMb: m })),
    xlarge: { snapshotId: 'node22-8cpu-16gb', vcpus: 4, memoryMb: 8192 },
  },
  buddy: allTiers((c, m) => ({ cpu: c, memoryMb: m })),
  miosa: allTiers((c, m) => ({ vcpus: c, memory: m })),
  sfcompute: allTiers((c, m) => ({ vcpus: c, memoryMiB: m })),
  // Sandbox0 exposes only memory — vcpus are reported by the benchmark script.
  sandbox0: allTiers((c, m) => ({ memory: m })),
  // daytona rejects `resources` combined with a snapshot (incl. the implicit
  // default one) — pass `image` + `resources` so the SDK goes buildInfo ->
  // snapshot-from-image with sized resources; `resources.memory` is GiB.
  daytona: allTiers((c, m) => ({ resources: { cpu: c, memory: m / 1024 }, image: 'daytonaio/sandbox:0.10.0', snapshotId: '' })),
  // createos resolves cpus/memoryMb through its live shape catalog to the
  // smallest fitting shape; xlarge stays pinned to the proven explicit shape.
  createos: {
    small: { cpus: 1, memoryMb: 2048, ephemeralDiskMb: 61440 },
    medium: { cpus: 2, memoryMb: 4096, ephemeralDiskMb: 61440 },
    large: { cpus: 4, memoryMb: 8192, ephemeralDiskMb: 61440 },
    xlarge: { shape: 's-8vcpu-16gb', ephemeralDiskMb: 61440 },
  },

  // Sprites sizes via CreateSpriteRequest.config {cpus, ram_mb} — the
  // adapter passes provider options straight into the create body.
  sprites: allTiers((c, m) => ({ config: { cpus: c, ram_mb: m } })),
  // CodeSandbox VM tiers map 1:1 onto the market sizes.
  codesandbox: {
    small: { vmTier: VMTier.Pico },
    medium: { vmTier: VMTier.Nano },
    large: { vmTier: VMTier.Micro },
    xlarge: { vmTier: VMTier.Small },
  },
  // opencomputer sizes in physical cores (cpuCount = vCPUs / 2); skip small
  // since 1 vCPU would require a fractional core.
  opencomputer: {
    medium: { cpuCount: 1, memoryMB: 4096, timeout: 600_000 },
    large: { cpuCount: 2, memoryMB: 8192, timeout: 600_000 },
    xlarge: { cpuCount: 4, memoryMB: 16384, timeout: 600_000 },
  },
  // SDK standard sizes (computesdk INSTANCE_SIZE_PROFILES sm/md/lg = 1/2G,
  // 2/4G, 4/8G — the market tiers): the adapter maps sizeClass onto its
  // native shape. xlarge keeps the proven factory shape (providers.ts).
  namespace: { small: { sizeClass: 'sm' }, medium: { sizeClass: 'md' }, large: { sizeClass: 'lg' } },
  // Archil sizes persistent VMs only (workflows set ARCHIL_EXECUTION=persistent).
  archil: { small: { sizeClass: 'sm' }, medium: { sizeClass: 'md' }, large: { sizeClass: 'lg' } },
  // --- named presets / template-locked offerings ---
  // Arker sizes per create (resources.vcpu/memory_mib), bounded by the forked
  // golden. templateId: undefined drops the 1 vCPU 'ubuntu-small' base so the
  // adapter picks the smallest ubuntu-coding golden that fits. xlarge stays
  // pinned to ubuntu-full-8 so it remains comparable with earlier runs.
  arker: {
    small: { templateId: undefined, sizeClass: 'sm' },
    medium: { templateId: undefined, sizeClass: 'md' },
    large: { templateId: undefined, sizeClass: 'lg' },
    xlarge: { sizeClass: 'xl', templateId: 'ubuntu-full-8' },
  },
  // Agent37 sizes per create: 2/4, 4/8, 4/16, 4/32 only (4 vCPU ceiling, more
  // is silently capped). No 1 vCPU / 2 GiB or 8 vCPU / 16 GiB shape.
  agent37: { small: null, medium: { sizeClass: 'md' }, large: { sizeClass: 'lg' }, xlarge: null },
  // E2B fixes CPU/RAM per template; sizeClass boots the per-size team template
  // built by the computesdk Provider Setup job. templateId: undefined drops the
  // base 'csdk-node22-8cpu-16gb' default, which would conflict. xlarge keeps that base.
  e2b: { small: { templateId: undefined, sizeClass: 'sm' }, medium: { templateId: undefined, sizeClass: 'md' }, large: { templateId: undefined, sizeClass: 'lg' } },
  // upstash box sizes small/medium/large = 2c/4GB, 4c/8GB, 8c/16GB — market
  // medium/large/xlarge; there is no 1-core offering for market small.
  upstash: {
    medium: { size: 'small' },
    large: { size: 'medium' },
    xlarge: { size: 'large' },
  },
  northflank: { xlarge: { deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN || 'nf-compute-50', ephemeralStorageSize: 5120 } }, // 5 GiB ephemeral storage
  // Superserve sizes at the template (sandboxes can't override it). Medium is
  // the system superserve/node-22 (2 vCPU / 4 GiB); small/large/xlarge are
  // per-account setup (size-templates.ts), provisioned by the computesdk account-setup job.
  // https://docs.superserve.ai/llms-full.txt
  superserve: templateTiers('superserve'),
  // Gravix built-ins: base-small 2/1G, base-medium 2/4G, base-large 4/8G
  // (base-xlarge and up do not exist). No 1 vCPU / 2 GiB or 8 vCPU / 16 GiB.
  gravixlayer: {
    small: null,
    medium: { templateId: 'base-medium' },
    large: { templateId: 'base-large' },
    xlarge: null,
  },
  // Freestyle VMs boot at 4 vCPU / 8 GiB and resize grow-only; sizeClass
  // lg/xl is applied by computesdk#1075 (older adapters ignore it and run 4/8).
  freestyle: { small: null, medium: null, large: { sizeClass: 'lg' }, xlarge: { sizeClass: 'xl' } },
  // Promigence's base snapshot is 2 vCPU / 4 GiB; `tier` only sizes
  // image-built sandboxes and its shapes are not published, so only the
  // base (market medium) is claimed.
  promigence: { small: null, medium: {}, large: null, xlarge: null },
  // Railway sizes per create via resources {cpu, memoryGB} (railway >=3.16).
  railway: allTiers((c, m) => ({ resources: { cpu: c, memoryGB: m / 1024 } })),
  // Sail's standard sizes sm/md/lg/xl are 1/2/4/8 vCPU, each with 16 GiB
  // (its smallest memory limit).
  sail: {
    small: { sizeClass: 'sm' },
    medium: { sizeClass: 'md' },
    large: { sizeClass: 'lg' },
    xlarge: { sizeClass: 'xl' },
  },
  // Styne sizes small/default/large are 2/4, 4/8 and 8/16 (vCPU/GiB); it has
  // no 1-vCPU size, so market small is unsupported.
  styne: { small: null, medium: { size: 'small' }, large: { size: 'default' }, xlarge: { size: 'large' } },
  // Novita sizes at template build (cpuCount/memoryMB, E2B-compatible); tiers
  // are per-account setup (size-templates.ts). Raise the default 300s
  // lifetime — same backstop pattern as blaxel.
  novita: templateTiers('novita', { timeout: 900_000 }),
};

/**
 * The xlarge layer — kept as its own map for benchmarks that run a single
 * standardized size.
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
 * default/base options behavior.
 */
export function getSandboxOptionsWithResources(
  providerName: string,
  baseOptions?: Record<string, any>,
  size: MarketSize = 'xlarge',
): Record<string, any> | undefined {
  const resourceOpts = PROVIDER_SIZE_OPTIONS[providerName]?.[size];
  if (resourceOpts === null) return undefined;
  if (resourceOpts === undefined) {
    return size === 'xlarge' ? (baseOptions ?? {}) : undefined;
  }
  return { ...baseOptions, ...resourceOpts };
}
