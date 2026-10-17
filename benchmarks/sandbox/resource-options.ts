/**
 * Standardized resource sizing for fair comparison across providers in
 * build-style sandbox benchmarks (dax, repo).
 * Target: 8 vCPU, 16 GiB RAM.
 * Each provider uses different parameter names and units, so we map per-provider.
 * Providers not listed here don't support CPU/memory configuration at sandbox creation time.
 * Note: E2B sets CPU/memory at template build time, not at sandbox creation.
 * Note: lightning is sized via LIGHTNING_INSTANCE_TYPE=cpu-8 (8 vCPU / 16 GiB), applied on
 * the provider factory in providers.ts — the SDK ignores an instanceType passed to create().
 */
import { VMTier } from '@codesandbox/sdk';

export const RESOURCE_OPTIONS_8CPU_16GB: Record<string, Record<string, any>> = {
  arker:        { templateId: 'ubuntu-full-8' },           // 8 vCPU / 16 GiB golden
  modal:        { cpu: 4, cpuLimit: 4, memoryMiB: 16384, templateId: 'node:22' }, // Modal: 1 core = 2 vCPUs, so 4 cores = 8 vCPUs
  tenki:        { cpuCores: 8, memoryMb: 16384, diskSizeGb: 20 }, // default disk cannot hold the OpenCode install
  tensorlake:   { cpus: 8, memoryMb: 16384 },
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
  beam:         { cpu: 8, memory: 16384 },                   // cpu = cores, memory = MiB
  cloudflare:   { vcpu: 8, memoryMib: 16384, diskMb: 20000, image: 'builder' },
  codesandbox:  { vmTier: VMTier.Small },                  // Small = 8 CPU, 16 GiB
  northflank:   { deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN || 'nf-compute-50', ephemeralStorageSize: 5120 },  // 5 GiB ephemeral storage
  declaw:       { templateId: 'node-large' },              // node-large template: 8 vCPU / 16 GiB RAM / 8 GiB disk
  superserve:   { templateId: 'node22-8cpu-16gb' },           // 8 vCPU / 16 GiB template built in the pre-step
  createos:     { shape: 's-8vcpu-16gb', ephemeralDiskMb: 61440 }, // 8 vCPU, 16 GiB RAM, 60 GiB disk
  opencomputer: { cpuCount: 4, memoryMB: 16384, timeout: 600_000 },
  microsandbox: { cpus: 8, memoryMib: 16384, rootDiskMib: 20480 }, // 20 GiB writable disk
  mosaic:       { vcpus: 8, memoryMb: 16384 },
  buddy:        { cpu: 8, memoryMb: 16384 },               // provider maps cpu/memory to its 8x16 preset (8 vCPU / 16 GB)
  miosa:        { vcpus: 8, memory: 16384 },               // maps to MIOSA size contract "large" (8 vCPU / 16 GiB)
  // givemeanode has no 8 vCPU / 16 GiB named shape; asking for 8 vCPU and 16 GiB
  // selects sandbox-lg (8 vCPU / 32 GiB). The actual memory is reported by the
  // benchmark script, so the mismatch is visible in results.
  givemeanode:  { vcpus: 8, memoryMiB: 16384 },
  gravixlayer:  { templateId: 'base-4xlarge' },                // built-in template requested by the Gravix team
  // Sandbox0 exposes only memory. Override the 128 MiB TTI size;
  // getSandboxOptionsWithResources preserves hardTtl from providers.ts.
  sandbox0:     { memory: 16384 },
  sail:         { size: 'l' },
  // Novita sizes via templates (E2B-style), so dax runs on the node22-8cpu-16gb
  // template built in the workflow pre-step (same pattern as superserve/e2b).
  // The provider's default sandbox lifetime (300s) is below the 10-min build
  // deadline, so raise it — same backstop pattern as blaxel.
  novita:       { templateId: 'node22-8cpu-16gb', timeout: 900_000 },
};

export function getSandboxOptionsWithResources(providerName: string, baseOptions?: Record<string, any>): Record<string, any> {
  const resourceOpts = RESOURCE_OPTIONS_8CPU_16GB[providerName];
  if (!resourceOpts) return baseOptions ?? {};
  return { ...baseOptions, ...resourceOpts };
}
