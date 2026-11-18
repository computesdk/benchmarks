import type { MarketSize } from './sizes.js';

/**
 * Size-tier templates for providers that size at the template (sandboxes
 * can't override vcpu/memory at create). They are per-account setup,
 * provisioned outside this repo by the computesdk account-setup job; the
 * benches only reference the names (via `sizes.ts`).
 */
export interface SizeTemplate {
  name: string;
  vcpu: number;
  memoryMib: number;
  /** Provider system template; never built or modified by the setup script. */
  builtIn?: boolean;
}

export type SizeTemplateProvider = 'superserve' | 'novita';

const tierName = (vcpu: number, memoryMib: number) => `csdk-node22-${vcpu}cpu-${memoryMib / 1024}gb`;
const tier = (vcpu: number, memoryMib: number): SizeTemplate => ({
  name: tierName(vcpu, memoryMib),
  vcpu,
  memoryMib,
});

// xlarge keeps the name the per-run pre-steps still build (Superserve
// build-superserve-template.ts; Novita out-of-band) until the account-setup
// job provisions csdk-node22-8cpu-16gb and those pre-steps are removed.
const LEGACY_XLARGE: SizeTemplate = { name: 'node22-8cpu-16gb', vcpu: 8, memoryMib: 16384 };

export const SIZE_TEMPLATES: Record<SizeTemplateProvider, Record<MarketSize, SizeTemplate>> = {
  // https://docs.superserve.ai/llms-full.txt (templates/overview, build-spec):
  // superserve/node-22 is already 2 vCPU / 4096 MiB, so medium uses it.
  superserve: {
    small: tier(1, 2048),
    medium: { name: 'superserve/node-22', vcpu: 2, memoryMib: 4096, builtIn: true },
    large: tier(4, 8192),
    xlarge: LEGACY_XLARGE,
  },
  // https://novita.ai/docs/guides/sandbox-template-build-operations.md —
  // cpuCount/memoryMB are set at template build (E2B-compatible API).
  novita: {
    small: tier(1, 2048),
    medium: tier(2, 4096),
    large: tier(4, 8192),
    xlarge: LEGACY_XLARGE,
  },
};

/** The setup-provisioned (non-built-in) template behind `templateId`, if any. */
export function provisionedSizeTemplate(
  provider: string,
  templateId: unknown,
): SizeTemplate | undefined {
  const tiers = SIZE_TEMPLATES[provider as SizeTemplateProvider];
  if (!tiers || typeof templateId !== 'string') return undefined;
  return Object.values(tiers).find((t) => t.name === templateId && !t.builtIn);
}

function looksLikeMissingTemplate(err: unknown): boolean {
  const e = err as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown } | undefined;
  if (e?.name === 'NotFoundError' || e?.status === 404 || e?.statusCode === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|not[ _-]?found|does not exist|no such template|unknown template/i.test(msg);
}

/**
 * A "template not provisioned" message when `err` is a create failure caused
 * by a missing setup-provisioned template, else undefined.
 */
export function templateNotProvisionedReason(
  provider: string,
  sandboxOptions: Record<string, unknown> | undefined,
  err: unknown,
): string | undefined {
  const t = provisionedSizeTemplate(provider, sandboxOptions?.templateId);
  if (!t || !looksLikeMissingTemplate(err)) return undefined;
  return (
    `template '${t.name}' (${t.vcpu} vCPU / ${t.memoryMib} MiB) is not provisioned on the ${provider} account; ` +
    'run the computesdk provider account-setup job'
  );
}
