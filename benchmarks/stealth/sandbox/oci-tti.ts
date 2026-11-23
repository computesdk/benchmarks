/**
 * OCI Boot TTI suite constants: the reference image every participant must
 * boot, the marker command that proves it booted, and the participant table
 * mapping each provider to its create-time options and mechanism label.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Image } from '@beamcloud/beam-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The OCI reference every participant boots. A stock library image on
 * purpose: it is public on Docker Hub, needs no publishing infrastructure,
 * and /etc/os-release gives a self-contained boot marker. Upgrading to a
 * custom image later only changes this ref and the marker check.
 */
export const REFERENCE_IMAGE = 'ubuntu:24.04';

/** Command run inside the sandbox to prove the reference image booted. */
export const MARKER_COMMAND = 'cat /etc/os-release';

/** The reference image's /etc/os-release identifies Ubuntu 24.04. */
export function markerVerified(stdout: string): boolean {
  return /ubuntu/i.test(stdout) && stdout.includes('24.04');
}

/**
 * One entry in oci-tti-artifacts.json: the create-time reference a
 * template-mechanism provider was materialized into, plus provenance.
 */
export interface OciArtifact {
  /** Provider-specific create-time ref (template id, imported image name, pinned image ref). */
  ref: string;
  /** When the artifact was materialized (ISO timestamp). */
  materializedAt?: string;
  /** Wall-clock ms the materialize step took; recorded on every record as context. */
  materializeMs?: number;
  /** Free-form provenance note (e.g. "manual VCR push"). */
  note?: string;
}

export interface OciArtifacts {
  /** The image the artifacts were built from — must match REFERENCE_IMAGE. */
  image?: string;
  artifacts?: Record<string, OciArtifact>;
}

export const ARTIFACTS_PATH = path.join(__dirname, 'oci-tti-artifacts.json');

export function loadArtifacts(): OciArtifacts {
  if (!existsSync(ARTIFACTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ARTIFACTS_PATH, 'utf-8')) as OciArtifacts;
  } catch {
    return {};
  }
}

/**
 * 'image'   — sandbox.create() takes the OCI ref directly (the provider may
 *             still build/cache internally; the UX is a raw ref on create).
 * 'template'— create takes a pre-materialized artifact built FROM the image
 *             by oci-tti-materialize.ts (e2b template, runloop blueprint...).
 */
export type OciMechanism = 'image' | 'template';

export interface OciResolved {
  sandboxOptions: Record<string, any>;
  /** The create-time ref actually used (image ref or artifact id) — recorded on every record. */
  imageRef: string;
  /** Materialize wall-clock ms from the artifact registry, when known. */
  materializeMs?: number;
}

interface OciParticipantSpec {
  mechanism: OciMechanism;
  /**
   * Resolve this provider's create options. Return null to exclude the
   * provider from the run (e.g. its artifact was never materialized).
   */
  resolve: (a: OciArtifacts) => OciResolved | null;
}

const image = (opts?: Record<string, any>): ((a: OciArtifacts) => OciResolved) => () => ({
  sandboxOptions: { image: REFERENCE_IMAGE, ...opts },
  imageRef: REFERENCE_IMAGE,
});

const artifact = (
  key: string,
  apply: (ref: string) => Record<string, any>,
): ((a: OciArtifacts) => OciResolved | null) => (a) => {
  const entry = a.artifacts?.[key];
  if (!entry?.ref) return null;
  return { sandboxOptions: apply(entry.ref), imageRef: entry.ref, materializeMs: entry.materializeMs };
};

/**
 * The OCI-capable set — every provider whose create can be fed the reference
 * image, one way or another. Providers registered in providers.ts but absent
 * here still run and record an oci_tti_unsupported failure.
 */
export const OCI_PARTICIPANTS: Record<string, OciParticipantSpec> = {
  // --- 'image': create() takes the OCI ref directly ---
  'run-cloud': { mechanism: 'image', resolve: image({ templateId: REFERENCE_IMAGE }) },
  // archil defaults to exec mode where create() only resolves a disk handle;
  // ephemeral: false forces persistent mode, where image → baseImage.
  archil: { mechanism: 'image', resolve: image({ ephemeral: false }) },
  // beam-js crashes on a bare image string — it requires an Image object
  // (the @computesdk/beam adapter forwards providerOptions untouched).
  beam: {
    mechanism: 'image',
    resolve: () => ({
      sandboxOptions: { name: 'computesdk-oci-tti', image: Image.fromRegistry(REFERENCE_IMAGE) },
      imageRef: REFERENCE_IMAGE,
    }),
  },
  // daytona passes image through providerOptions into createParams.
  daytona: { mechanism: 'image', resolve: image({ autoStopInterval: 15, autoDeleteInterval: 0 }) },
  // givemeanode requires a digest-pinned ref — resolved by the materialize script.
  sfcompute: { mechanism: 'image', resolve: artifact('sfcompute', (ref) => ({ image: ref })) },
  // buddy maps image → its `os` field; only the two Ubuntu refs are valid,
  // which is all REFERENCE_IMAGE needs.
  buddy: { mechanism: 'image', resolve: image() },
  isorun: { mechanism: 'image', resolve: image() },
  microsandbox: { mechanism: 'image', resolve: image() },
  // modal resolves templateId → images.fromRegistry (built + cached server-side).
  modal: {
    mechanism: 'image',
    resolve: () => ({ sandboxOptions: { templateId: REFERENCE_IMAGE }, imageRef: REFERENCE_IMAGE }),
  },

  namespace: { mechanism: 'image', resolve: image() },
  neevcloud: { mechanism: 'image', resolve: image() },
  // northflank maps image → deployment.external.imagePath.
  northflank: { mechanism: 'image', resolve: image() },
  // promigence builds a snapshot from the image on first create, then reuses it.
  promigence: { mechanism: 'image', resolve: image() },
  // sail builds the image on an account's first create, then reuses it.
  sail: { mechanism: 'image', resolve: image() },
  // tenki has no spec: see UNSUPPORTED_REASONS.
  // vercel resolves image against its Container Registry — the ref must be
  // pushed there first (see oci-tti-materialize.ts --provider vercel).
  vercel: {
    mechanism: 'image',
    resolve: artifact('vercel', (ref) => ({ image: ref, persistent: false })),
  },

  // --- 'template': create() takes a materialized artifact ---
  // blaxel cannot boot a library image; POST /v0/images imports it as a named image.
  blaxel: { mechanism: 'template', resolve: artifact('blaxel', (ref) => ({ image: ref })) },
  // mosaic create() maps image → snapshot_id (a named environment), never an
  // OCI ref; template.create({image}) builds that environment first.
  mosaic: { mechanism: 'template', resolve: artifact('mosaic', (ref) => ({ image: ref })) },
  codesandbox: { mechanism: 'template', resolve: artifact('codesandbox', (ref) => ({ templateId: ref })) },
  e2b: { mechanism: 'template', resolve: artifact('e2b', (ref) => ({ templateId: ref, timeout: 600_000 })) },
  gravixlayer: { mechanism: 'template', resolve: artifact('gravixlayer', (ref) => ({ templateId: ref })) },
  lelantos: { mechanism: 'template', resolve: artifact('lelantos', (ref) => ({ templateId: ref })) },
  novita: { mechanism: 'template', resolve: artifact('novita', (ref) => ({ templateId: ref })) },
  // runloop blueprint ids (bpt_*) map to blueprint_id on create.
  runloop: { mechanism: 'template', resolve: artifact('runloop', (ref) => ({ templateId: ref })) },
  // superserve ignores `image` on create; Template.create({from}) takes OCI
  // refs, so materialize builds the template and create takes its UUID via
  // templateId → fromTemplate.
  superserve: { mechanism: 'template', resolve: artifact('superserve', (ref) => ({ templateId: ref })) },
};

/**
 * Why a provider cannot run the OCI boot, for providers whose reason is more
 * specific than "no OCI_PARTICIPANTS spec".
 */
const UNSUPPORTED_REASONS: Record<string, string> = {
  luxor: "unsupported: luxor's image field only accepts refs in Luxor's own registry — no path imports an arbitrary OCI ref",
};

/**
 * Non-empty when a provider cannot boot the reference image: it has no
 * OCI_PARTICIPANTS spec, or its template/registry artifact was never
 * materialized. The task turns this into a failed iteration (score 0).
 */
export function ociUnsupportedReason(name: string, artifacts: OciArtifacts): string | undefined {
  const spec = OCI_PARTICIPANTS[name];
  if (!spec) {
    return UNSUPPORTED_REASONS[name] ?? `unsupported: no create-time path to boot an arbitrary OCI image is wired for ${name}`;
  }
  if (!spec.resolve(artifacts)) {
    return `unsupported: no ${name} artifact in oci-tti-artifacts.json (pnpm materialize:oci-tti --provider ${name} has not succeeded)`;
  }
  return undefined;
}

/**
 * Keep every provider in the shared registry, resolving sandboxOptions for the
 * OCI-capable ones against the committed artifact registry. Providers that
 * cannot boot the image stay as participants so their legs record failed
 * tasks (see ociUnsupportedReason) instead of disappearing from results.
 */
export function resolveOciParticipants<
  T extends { name: string; sandboxOptions?: Record<string, any>; requiredEnvVars?: string[] },
>(providers: T[], artifacts: OciArtifacts): T[] {
  return providers.map((p) => {
    const resolved = OCI_PARTICIPANTS[p.name]?.resolve(artifacts);
    return resolved ? { ...p, sandboxOptions: resolved.sandboxOptions } : p;
  });
}

/** Per-record context fields for a participant (mechanism + resolved refs). */
export function recordContext(
  name: string,
  artifacts: OciArtifacts,
): Record<string, string | number> {
  const spec = OCI_PARTICIPANTS[name];
  const resolved = spec?.resolve(artifacts);
  return {
    mechanism: spec?.mechanism ?? 'image',
    image_ref: resolved?.imageRef ?? '',
    ...(resolved?.materializeMs ? { materializeMs: resolved.materializeMs } : {}),
  };
}
