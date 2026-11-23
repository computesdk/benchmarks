/**
 * Standardized large resource sizing for sandbox benchmarks (8 vCPU / 16 GiB
 * RAM) — at or above the Actions product's CI floor (4 vCPU / 8 GiB / 16 GiB).
 * Shared by dax.bench.ts and ci-capabilities.bench.ts.
 *
 * Each provider uses different parameter names and units, so we map per-provider.
 * Providers not listed here don't support CPU/memory configuration at sandbox
 * creation time (or size via their providers.ts sandboxOptions / factory).
 * Note: E2B sets CPU/memory at template build time, not at sandbox creation.
 * Note: lightning is sized via LIGHTNING_INSTANCE_TYPE=cpu-8 (8 vCPU / 16 GiB), applied on
 * the provider factory in providers.ts — the SDK ignores an instanceType passed to create().
 */
import { VMTier } from '@codesandbox/sdk';
import { PROVIDER_SIZE_OPTIONS } from './sizes.js';

/** Superserve CI template id (built by benchmarks/stealth/scripts/build-superserve-ci-template.ts):
 *  node:22, 8 vCPU / 16 GiB / 32 GiB disk — fresh kernel and enough disk for
 *  the CI free-space floor. Passed as the raw UUID per Superserve's request. */
const SUPERSERVE_CI_TEMPLATE_ID = '96d65ab3-926a-45f5-9060-2fd3632d364c';

export const LARGE_RESOURCE_OPTIONS: Record<string, Record<string, any>> = {
  'run-cloud': { cpu: 8, memory: 16384 },
  // archil maps vcpus -> vcpuCount, memoryMiB -> memSizeMiB on the VM create
  // (persistent mode only; ignored on the shared-disk exec path).
  archil:       { vcpus: 8, memoryMiB: 16384 },
  arker:        { templateId: 'ubuntu-full-8' },           // 8 vCPU / 16 GiB golden
  modal:        { cpu: 4, cpuLimit: 4, memoryMiB: 16384, templateId: 'node:22' }, // Modal: 1 core = 2 vCPUs, so 4 cores = 8 vCPUs
  luxor:        { cpuCores: 8, memoryMb: 16384, diskSizeGb: 20 }, // default disk cannot hold the OpenCode install
  tensorlake:   { cpus: 8, memoryMb: 16000 },               // per-sandbox RAM cap is 16000 MB
  isorun:       { vcpus: 8, memMiB: 16384 },
  runloop:      { launch_parameters: { resource_size_request: 'CUSTOM_SIZE', custom_cpu_cores: 8, custom_gb_memory: 16 } },
  upstash:      { size: 'large' },                          // large = 8 cores, 16 GB
  vercel:       { resources: { vcpus: 8 } },               // no memory control
  blaxel:       {
    memory: 16384,                                          // CPU derived: cores = memory_MB / 2048 = 8
    timeout: 900_000,                                       // Server-side TTL backstop if client cleanup cannot run
    volumes: [
      {
        name: 'dax-root',
        type: 'ephemeral',
        sizeMb: 16384,
        mountPath: '/',                                     // Keep the writable root off RAM
      },
    ],
  },
  // Briq's xl sizeClass is its 8 vCPU / 16 GiB shape.
  briq:         { sizeClass: 'xl' },
  beam:         { cpu: 8, memory: 16384 },                   // cpu = cores, memory = MiB
  cloudflare:   { vcpu: 8, memoryMib: 16384, diskMb: 20000, image: 'builder' },
  codesandbox:  { vmTier: VMTier.Small },                  // Small = 8 CPU, 16 GiB
  northflank:   { deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN || 'nf-compute-50', ephemeralStorageSize: 5120 },  // 5 GiB ephemeral storage
  superserve:   { templateId: SUPERSERVE_CI_TEMPLATE_ID },   // node:22, 8 vCPU / 16 GiB / 32 GiB disk
  createos:     { shape: 's-8vcpu-16gb', ephemeralDiskMb: 61440 }, // 8 vCPU, 16 GiB RAM, 60 GiB disk
  opencomputer: { cpuCount: 4, memoryMB: 16384, timeout: 600_000 },
  microsandbox: { cpus: 8, memoryMib: 16384, rootDiskMib: 20480 }, // 20 GiB writable disk
  mosaic:       { ...PROVIDER_SIZE_OPTIONS.mosaic.xlarge },
  buddy:        { cpu: 8, memoryMb: 16384 },               // provider maps cpu/memory to its 8x16 preset (8 vCPU / 16 GB)
  miosa:        { vcpus: 8, memory: 16384 },               // maps to MIOSA size contract "large" (8 vCPU / 16 GiB)
  // givemeanode has no 8 vCPU / 16 GiB named shape; asking for 8 vCPU and 16 GiB
  // selects sandbox-lg (8 vCPU / 32 GiB). The actual memory is reported by the
  // benchmark script, so the mismatch is visible in results.
  sfcompute:  { vcpus: 8, memoryMiB: 16384 },
  gravixlayer:  { templateId: 'base-large' },                  // largest built-in: 4 vCPU / 8 GiB (no 8/16 template)
  // Sandbox0 exposes only memory. Overrides the 128 MiB TTI size;
  // getSandboxOptionsWithResources preserves hardTtl from providers.ts.
  sandbox0:     { memory: 16384 },
  sail:         { sizeClass: 'xl' },                         // xl = 8 vCPU / 16 GiB
  freestyle:    { sizeClass: 'xl' },                         // applied by computesdk#1075; older adapters run 4/8
  railway:      { resources: { cpu: 8, memoryGB: 16 } },
  // Styne `large` is 8 vCPU / 16 GiB; raise the default 300s lifetime.
  styne:        { size: 'large', timeout: 900_000 },
};

export function getSandboxOptionsWithResources(providerName: string, baseOptions?: Record<string, any>): Record<string, any> {
  const resourceOpts = LARGE_RESOURCE_OPTIONS[providerName];
  if (!resourceOpts) return baseOptions ?? {};
  return { ...baseOptions, ...resourceOpts };
}

export function getCiSandboxOptions(
  provider: string,
  baseOptions: Record<string, any> | undefined,
  timeoutMs: number,
  purpose: 'workload' | 'deadline' = 'workload',
): Record<string, any> {
  const options = { ...(purpose === 'workload'
    ? getSandboxOptionsWithResources(provider, baseOptions)
    : baseOptions) };
  // Briq refuses create-time timeout.
  if (provider === 'briq') delete options.timeout;
  else options.timeout = timeoutMs;
  if (provider === 'run-cloud' && purpose === 'deadline') {
    options.onTimeout = 'destroy';
  }
  // Deadline check: the box must be gone after timeoutMs. Superserve's
  // default is pause-on-timeout (exec keeps working), which reads as
  // "deadline not honored"; autoDeleteSeconds: 0 hard-deletes it instead.
  if (provider === 'superserve' && purpose === 'deadline') {
    options.templateId = SUPERSERVE_CI_TEMPLATE_ID;
    options.autoDeleteSeconds = 0;
  }
  if (provider === 'sandbox0') {
    options.ttl = Math.ceil(timeoutMs / 1000);
    options.hardTtl = options.ttl;
  }
  return options;
}
