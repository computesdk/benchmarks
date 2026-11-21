#!/usr/bin/env tsx
/**
 * Materialize OCI artifacts for the oci-tti benchmark: for every
 * 'template'-mechanism provider, build the artifact their create() takes —
 * an e2b template, a runloop blueprint, a blaxel image build — FROM the
 * reference image, and write the resulting refs into
 * benchmarks/stealth/sandbox/oci-tti-artifacts.json (committed).
 *
 * Also resolves the digest-pinned ref givemeanode needs and records a
 * previously-pushed VCR ref for vercel.
 *
 * Idempotent: existing artifacts are kept unless --force is passed or the
 * recorded image differs from REFERENCE_IMAGE.
 *
 *   pnpm materialize:oci-tti                      # every provider that can be resolved
 *   pnpm materialize:oci-tti --provider e2b,novita
 *   pnpm materialize:oci-tti --provider vercel --image-ref <pushed-vcr-ref>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync as writeFile, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SANDBOX_API_IMAGE,
  SANDBOX_API_PATH,
  getImage,
  initialize as initializeBlaxel,
  listImageTags,
  settings as blaxelSettings,
  type ImageTag as BlaxelImageTag,
} from '@blaxel/core';
import { gravixlayer } from '@computesdk/gravixlayer';
import { mosaic } from '@computesdk/mosaic';
import { novita } from '@computesdk/novita';
import { runloop } from '@computesdk/runloop';
import { ConflictError, Template as SuperserveTemplate } from '@superserve/sdk';
import { Template } from 'e2b';
import { strToU8, zipSync } from 'fflate';

import {
  ARTIFACTS_PATH,
  loadArtifacts,
  OCI_PARTICIPANTS,
  REFERENCE_IMAGE,
  type OciArtifact,
  type OciArtifacts,
} from './oci-tti.js';
import { providers } from './providers.js';

const ARTIFACT_NAME = 'oci-tti-ubuntu-2404';
const RUNLOOP_DOCKERFILE = `FROM ${REFERENCE_IMAGE}\n`;

const args = process.argv.slice(2);
function flagValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 || i + 1 >= args.length ? undefined : args[i + 1];
}
const onlyProviders = flagValue('--provider')?.split(',').map((s) => s.trim()).filter(Boolean);
const force = args.includes('--force');
const vercelImageRef = flagValue('--image-ref') ?? process.env.OCI_TTI_VERCEL_IMAGE;

function needEnv(...keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
}

function timed(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

/** Docker Hub anonymous-token flow → the digest-pinned ref for a library image. */
async function resolveDockerHubDigest(repo: string, tag: string): Promise<string> {
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${repo}:pull`,
  );
  if (!tokenRes.ok) throw new Error(`docker hub auth: HTTP ${tokenRes.status}`);
  const { token } = (await tokenRes.json()) as { token: string };
  const manifest = await fetch(`https://registry-1.docker.io/v2/library/${repo}/manifests/${tag}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  if (!manifest.ok) throw new Error(`docker hub manifest: HTTP ${manifest.status}`);
  const digest = manifest.headers.get('docker-content-digest');
  if (!digest) throw new Error('docker hub manifest: no docker-content-digest header');
  // givemeanode rejects refs that name no registry host — fully qualify.
  return `docker.io/library/${repo}@${digest}`;
}

const BLAXEL_IMAGE_TYPE = 'sandbox';
const BLAXEL_BUILD_TIMEOUT_MS = 5 * 60_000;
/** How long a rebuild waits for a new tag before it takes one the image already had. */
const BLAXEL_TAG_SETTLE_MS = 10_000;

/**
 * Build REFERENCE_IMAGE into a Blaxel sandbox image and return the ref
 * create() boots (`sandbox/<name>:<tag>`). Blaxel boots only images whose
 * entrypoint is its sandbox API, so the build adds it, the same Dockerfile
 * the Blaxel adapter's template build uses. A bare registry import has no
 * sandbox API and never answers.
 *
 * The image is named after a hash of the Dockerfile: Blaxel reuses an
 * identical build without saying which tag it reused, so one image per
 * distinct build keeps the tag exact. The build result comes from the
 * image's events; the tag comes from the image's tags list, since the image
 * read no longer carries tags.
 */
async function buildBlaxelImage(): Promise<string> {
  const dockerfile = [
    `FROM ${REFERENCE_IMAGE}`,
    `COPY --from=${SANDBOX_API_IMAGE}:latest /sandbox-api ${SANDBOX_API_PATH}`,
    `ENTRYPOINT ["${SANDBOX_API_PATH}"]`,
    '',
  ].join('\n');
  const name = `${ARTIFACT_NAME}-${createHash('sha256').update(dockerfile).digest('hex').slice(0, 8)}`;
  const path = { resourceType: BLAXEL_IMAGE_TYPE, imageName: name };

  const before = await getImage({ path });
  const existed = before.error === undefined;
  if (!existed && before.response?.status !== 404) {
    throw new Error(`blaxel image ${name}: read HTTP ${before.response?.status}`);
  }
  const lastEventBefore = Math.max(0, ...(before.data?.metadata?.events ?? []).map(blaxelEventTime));
  const tagsBefore = new Set(existed ? (await listBlaxelTags(path)).map((t) => t.name) : []);

  await blaxelSettings.authenticate();
  const created = await fetch(`${blaxelSettings.baseUrl}/images?upload=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...blaxelSettings.headers },
    body: JSON.stringify({ name, resourceType: BLAXEL_IMAGE_TYPE }),
  });
  const uploadUrl = created.headers.get('x-blaxel-upload-url');
  if (!created.ok || !uploadUrl) {
    throw new Error(`blaxel image build ${name}: HTTP ${created.status} ${(await created.text()).slice(0, 400)}`);
  }
  const uploaded = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    body: zipSync({ Dockerfile: strToU8(dockerfile) }),
  });
  if (!uploaded.ok) {
    throw new Error(`blaxel image upload ${name}: HTTP ${uploaded.status} ${(await uploaded.text()).slice(0, 400)}`);
  }

  // The build is done when the image records a result newer than any event
  // it had before the upload.
  const deadline = Date.now() + BLAXEL_BUILD_TIMEOUT_MS;
  let builtAt: number | undefined;
  for (;;) {
    const { data, error, response } = await getImage({ path });
    if (error !== undefined && response?.status !== 404) {
      throw new Error(`blaxel image ${name}: read HTTP ${response?.status}`);
    }
    const result = (data?.metadata?.events ?? []).find(
      (e) => blaxelEventTime(e) > lastEventBefore && (e.status === 'BUILT' || e.status === 'FAILED'),
    );
    if (result?.status === 'FAILED') {
      throw new Error(`blaxel image build ${name} failed: ${result.message?.replace(/\s+/g, ' ').trim() || 'no message'}`);
    }
    if (result) {
      builtAt ??= Date.now();
      // A new build adds a tag; an identical rebuild reuses one without
      // saying so, so after the settle time any tag of this image will do.
      const tags = await listBlaxelTags(path);
      const fresh = tags.find((t) => t.name && !tagsBefore.has(t.name));
      const settled = Date.now() - builtAt >= BLAXEL_TAG_SETTLE_MS;
      const tag = fresh ?? (settled ? newestBlaxelTag(tags) : undefined);
      if (tag?.name) return `${BLAXEL_IMAGE_TYPE}/${name}:${tag.name}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(`blaxel image ${name}: ${result ? 'built but no tag listed' : 'build did not finish'} in ${BLAXEL_BUILD_TIMEOUT_MS / 60_000} min`);
    }
    await new Promise((resolve) => setTimeout(resolve, result ? 1_000 : 2_000));
  }
}

/** Every tag of a Blaxel image, following the list's pages. */
async function listBlaxelTags(path: { resourceType: string; imageName: string }): Promise<BlaxelImageTag[]> {
  const tags: BlaxelImageTag[] = [];
  let cursor: string | undefined;
  do {
    const { data, error, response } = await listImageTags({ path, query: { limit: 100, ...(cursor ? { cursor } : {}) } });
    if (error !== undefined || !data) throw new Error(`blaxel image ${path.imageName}: tags HTTP ${response?.status}`);
    tags.push(...data.data);
    cursor = data.meta?.hasMore ? data.meta.nextCursor : undefined;
  } while (cursor);
  return tags;
}

function blaxelEventTime(event: { time?: string }): number {
  return Date.parse(event.time ?? '') || 0;
}

function newestBlaxelTag(tags: BlaxelImageTag[]): BlaxelImageTag | undefined {
  const time = (t: BlaxelImageTag) => Date.parse(t.updatedAt ?? t.createdAt ?? '') || 0;
  return [...tags].sort((a, b) => time(b) - time(a))[0];
}

async function buildE2bStyle(opts: { apiKey: string; domain?: string }): Promise<string> {
  const t = (Template as any)().fromImage(REFERENCE_IMAGE);
  const info = await (Template as any).build(t, ARTIFACT_NAME, opts);
  if (!info?.templateId) throw new Error(`e2b build returned no templateId: ${JSON.stringify(info)}`);
  return info.templateId;
}

const MATERIALIZERS: Record<string, () => Promise<{ ref: string; note?: string } | null>> = {
  // --- template-mechanism providers ---
  async e2b() {
    needEnv('E2B_API_KEY');
    return { ref: await buildE2bStyle({ apiKey: process.env.E2B_API_KEY! }) };
  },
  async lelantos() {
    needEnv('LELANTOS_API_KEY');
    // Lelantos is e2b-SDK compatible; builds hit api.lelantos.ai via `domain`.
    return {
      ref: await buildE2bStyle({
        apiKey: process.env.LELANTOS_API_KEY!,
        domain: process.env.LELANTOS_DOMAIN ?? 'lelantos.ai',
      }),
    };
  },
  async mosaic() {
    needEnv('MOSAIC_API_URL', 'MOSAIC_API_TOKEN');
    const t = (await mosaic({
      baseUrl: process.env.MOSAIC_API_URL!,
      apiKey: process.env.MOSAIC_API_TOKEN!,
    }).template!.create({ name: ARTIFACT_NAME, image: REFERENCE_IMAGE } as any)) as {
      id?: string;
    };
    if (!t?.id) throw new Error('mosaic template create returned no environment id');
    return { ref: t.id };
  },
  async novita() {
    needEnv('NOVITA_API_KEY');
    const t = await novita({ apiKey: process.env.NOVITA_API_KEY! }).template!.create({
      name: ARTIFACT_NAME,
      image: REFERENCE_IMAGE,
    } as any);
    return { ref: t.id };
  },
  async gravixlayer() {
    needEnv('GRAVIXLAYER_API_KEY');
    // The create call is held open for the image build — the SDK's 60s
    // default request timeout kills it mid-import.
    const t = await gravixlayer({
      apiKey: process.env.GRAVIXLAYER_API_KEY!,
      timeout: 10 * 60_000,
    }).template!.create({
      name: ARTIFACT_NAME,
      fromImage: REFERENCE_IMAGE,
    } as any);
    return { ref: t.id };
  },
  async runloop() {
    needEnv('RUNLOOP_API_KEY');
    const bp = (await runloop({ apiKey: process.env.RUNLOOP_API_KEY! }).template!.create({
      name: ARTIFACT_NAME,
      dockerfile: RUNLOOP_DOCKERFILE,
    } as any)) as { id?: string };
    if (!bp?.id) throw new Error('runloop blueprint create returned no id');
    return { ref: bp.id };
  },
  async superserve() {
    needEnv('SUPERSERVE_API_KEY');
    const apiKey = process.env.SUPERSERVE_API_KEY!;
    try {
      const t = await SuperserveTemplate.create({
        apiKey,
        name: ARTIFACT_NAME,
        from: REFERENCE_IMAGE,
      });
      return { ref: (await t.waitUntilReady()).id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const is409 =
        error instanceof ConflictError ||
        message.toLowerCase().includes('already exists') ||
        message.toLowerCase().includes('already taken') ||
        message.toLowerCase().includes('duplicate') ||
        message.includes('409');
      if (!is409) throw error;
    }
    // Duplicate name: GET /templates/<arg> is UUID-only, so resolve the name
    // to an id via the list endpoint (same fix as build-superserve-soak-template.ts).
    const match = (await SuperserveTemplate.list({ apiKey })).find(
      (t) => t.name === ARTIFACT_NAME,
    );
    if (!match) {
      throw new Error(`superserve: 409 on create but no template named ${ARTIFACT_NAME} in list`);
    }
    const existing = await SuperserveTemplate.connect(match.id, { apiKey });
    return { ref: (await existing.waitUntilReady()).id };
  },
  async blaxel() {
    needEnv('BL_API_KEY', 'BL_WORKSPACE');
    initializeBlaxel({ apikey: process.env.BL_API_KEY!, workspace: process.env.BL_WORKSPACE! });
    return { ref: await buildBlaxelImage(), note: 'reference image built with the Blaxel sandbox API as entrypoint' };
  },
  async codesandbox() {
    needEnv('CSB_API_KEY');
    // Template builds go through the csb CLI: a Docker build of a project dir
    // yields a memory-snapshot template id.
    const dir = mkdtempSync(path.join(tmpdir(), 'oci-tti-csb-'));
    try {
      writeFile(path.join(dir, 'Dockerfile'), `FROM ${REFERENCE_IMAGE}\n`);
      const out = execFileSync('csb', ['build', dir], { encoding: 'utf-8', stdio: 'pipe' });
      // Require a digit — a bare alnum run also matches words like "CODESANDBOX".
      const match = out.match(/[a-z0-9]*\d[a-z0-9]{9,}/i) ?? out.match(/[a-z0-9]{9,}\d[a-z0-9]*/i);
      if (!match) throw new Error(`csb build: could not parse template id from output: ${out.slice(0, 300)}`);
      return { ref: match[0], note: 'built via csb build' };
    } catch (err) {
      throw new Error(
        `codesandbox materialize needs the csb CLI on PATH (csb build <dir>): ${(err as Error).message}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  // --- raw-image providers that still need a resolved/pushed ref ---
  async sfcompute() {
    // No credentials needed: resolves the digest the provider requires.
    const [repo, tag] = REFERENCE_IMAGE.split(':');
    const ref = await resolveDockerHubDigest(repo!, tag!);
    return { ref };
  },
  async vercel() {
    // There is no import API — push the image to the project's Vercel
    // Container Registry once, then record the ref here (or pass --image-ref).
    if (!vercelImageRef) {
      // The workflow's matrix legs always pass --provider, so "run for vercel
      // only" is indistinguishable from a full-matrix leg — skip in both.
      console.log(
        '[materialize] vercel: skipped — push the reference image to VCR once, ' +
          'then re-run with --image-ref <pushed-ref>',
      );
      return null;
    }
    return { ref: vercelImageRef, note: 'pre-pushed VCR ref' };
  },
};

async function main(): Promise<void> {
  const artifacts: OciArtifacts = loadArtifacts();
  // Compare BEFORE overwriting: a changed reference image invalidates every
  // artifact built from the old one.
  if (artifacts.image !== REFERENCE_IMAGE) {
    artifacts.image = REFERENCE_IMAGE;
    artifacts.artifacts = {};
  }
  artifacts.artifacts ??= {};

  const names = Object.keys(MATERIALIZERS).filter((n) => !onlyProviders || onlyProviders.includes(n));
  const known = new Set(providers.map((p) => p.name));
  const unknown = names.filter((n) => !known.has(n));
  for (const n of unknown) console.warn(`[materialize] ${n} is not registered in providers.ts`);

  const unmatched = (onlyProviders ?? []).filter((n) => !names.includes(n));
  if (unmatched.length) {
    console.error(`[materialize] no materializer for: ${unmatched.join(', ')}`);
    process.exit(1);
  }

  let wrote = false;
  let failed = false;
  for (const name of names) {
    const existing = artifacts.artifacts[name];
    if (existing?.ref && !force) {
      console.log(`[materialize] ${name}: already materialized (${existing.ref}) — pass --force to rebuild`);
      continue;
    }
    const elapsed = timed();
    try {
      const result = await MATERIALIZERS[name]!();
      if (result === null) continue; // explicit skip (e.g. vercel with no VCR ref)
      const { ref, note } = result;
      if (!ref) throw new Error('materializer returned an empty ref');
      const entry: OciArtifact = {
        ref,
        materializedAt: new Date().toISOString(),
        materializeMs: elapsed(),
        ...(note ? { note } : {}),
      };
      artifacts.artifacts[name] = entry;
      wrote = true;
      console.log(`[materialize] ${name}: ${ref} (${entry.materializeMs}ms)`);
    } catch (err) {
      failed = true;
      console.error(`[materialize] ${name}: FAILED — ${(err as Error).message}`);
    }
  }

  if (wrote || !existsSync(ARTIFACTS_PATH)) {
    writeFileSync(ARTIFACTS_PATH, JSON.stringify(artifacts, null, 2) + '\n');
    console.log(`[materialize] wrote ${ARTIFACTS_PATH}`);
  }

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
