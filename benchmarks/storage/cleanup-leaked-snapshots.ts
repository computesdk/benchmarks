/**
 * One-off cleanup for snapshots the snapshot-fork bench leaked before its
 * teardown deleted the fork-from-live auto snapshot.
 *
 *   tsx benchmarks/storage/cleanup-leaked-snapshots.ts <provider>
 *
 * Dry run by default; set DELETE=1 to delete. Snapshots younger than
 * MIN_AGE_MIN minutes (default 60) are skipped so an in-flight run is safe.
 * Only unnamed (auto) snapshots and the bench's own `snap-*` snapshots that no
 * fork still uses are deleted; anything else is left alone.
 */
import '../src/env.js';
import { pathToFileURL } from 'node:url';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { BlobServiceClient } from '@azure/storage-blob';
import type { Storage, SnapshotInfo } from '@storagesdk/core';
import { MANIFEST_PATH, parseManifest, serializeManifest } from '@storagesdk/core/adapter';
import { formatError } from '../src/util/error.js';
import { storageProviders } from './providers.js';

type Kind = 'azure' | 's3' | 'tensorlake';

const KINDS: Record<string, Kind> = {
  'azure-blob': 'azure',
  'aws-s3': 's3',
  'cloudflare-r2': 's3',
  neon: 's3',
  mosaic: 's3',
  tensorlake: 'tensorlake',
};

const CONCURRENCY = 8;
const MAX_ATTEMPTS = 5;

interface Candidate {
  id: string;
  createdAt: Date;
}

export interface CleanupOptions {
  storage: Storage;
  kind: Kind;
  /** Parent bucket / container / filesystem the bench snapshots. */
  parent: string;
  minAgeMs: number;
  delete: boolean;
  log?: (line: string) => void;
}

export interface CleanupResult {
  matched: number;
  skippedRecent: number;
  skippedKept: number;
  deleted: string[];
  failed: string[];
}

const isBenchOwned = (s: SnapshotInfo) => s.name === undefined || s.name.startsWith('snap-');

export async function cleanupLeakedSnapshots(opts: CleanupOptions): Promise<CleanupResult> {
  const log = opts.log ?? console.log;
  const cutoff = Date.now() - opts.minAgeMs;
  const snapshots = await opts.storage.snapshots.list();
  const listed = new Map(snapshots.map((s) => [s.id, s]));
  // Tensorlake ids are content-addressed, so one id can carry several names.
  const keep = new Set(snapshots.filter((s) => !isBenchOwned(s)).map((s) => s.id));
  const forkBases = new Set((await opts.storage.forks.list()).map((f) => f.fromSnapshot).filter(Boolean));

  const found = opts.kind === 'tensorlake'
    ? [...listed.keys()].map((id) => ({ id, createdAt: new Date(listed.get(id)!.createdAt) }))
    : await listSiblingSnapshots(opts.storage, opts.kind, opts.parent);

  let skippedRecent = 0;
  let skippedKept = 0;
  const hits: Candidate[] = [];
  for (const c of found) {
    if (forkBases.has(c.id) || keep.has(c.id)) skippedKept++;
    else if (c.createdAt.getTime() > cutoff) skippedRecent++;
    else hits.push(c);
  }
  hits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  log(`matched ${found.length} snapshot(s) of ${opts.parent} | to delete: ${hits.length} | skipped, under the age cutoff: ${skippedRecent} | kept (named or a fork's base): ${skippedKept}`);
  if (hits.length) {
    log(`oldest ${hits[0]!.createdAt.toISOString()} newest ${hits[hits.length - 1]!.createdAt.toISOString()} example ${hits[0]!.id}`);
  }
  const result: CleanupResult = { matched: found.length, skippedRecent, skippedKept, deleted: [], failed: [] };
  if (!opts.delete) {
    log('dry run, nothing deleted. Re-run with DELETE=1 to delete.');
    return result;
  }

  const queue = hits.map((c) => c.id);
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        await withRetries(() => deleteSnapshot(opts.storage, opts.kind, id!));
        result.deleted.push(id);
        if (result.deleted.length % 500 === 0) log(`deleted ${result.deleted.length}`);
      } catch (err) {
        result.failed.push(`${id}: ${formatError(err)}`);
      }
    }
  }));
  log(`deleted ${result.deleted.length} failed ${result.failed.length}`);
  for (const f of result.failed.slice(0, 5)) log(`  ${f}`);

  if (opts.kind !== 'tensorlake') {
    const stale = result.deleted.filter((id) => listed.has(id));
    if (stale.length) await pruneManifest(opts.storage, opts.kind, opts.parent, new Set(stale), log);
  }
  return result;
}

/** Sibling containers / buckets named `<parent>-snapshot-<25 digits>`. */
async function listSiblingSnapshots(storage: Storage, kind: Kind, parent: string): Promise<Candidate[]> {
  const prefix = `${parent}-snapshot-`;
  const isSnapshot = (name: string) => name.startsWith(prefix) && /^[0-9]{25}$/.test(name.slice(prefix.length));
  const out: Candidate[] = [];
  if (kind === 'azure') {
    const svc = storage.raw as BlobServiceClient;
    for await (const c of svc.listContainers({ prefix })) {
      if (isSnapshot(c.name)) out.push({ id: c.name, createdAt: c.properties.lastModified });
    }
    return out;
  }
  const client = storage.raw as S3Client;
  let token: string | undefined;
  do {
    const res = await client.send(new ListBucketsCommand({ Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
    for (const b of res.Buckets ?? []) {
      if (b.Name && isSnapshot(b.Name)) out.push({ id: b.Name, createdAt: b.CreationDate ?? new Date(0) });
    }
    token = res.ContinuationToken;
  } while (token);
  return out;
}

async function deleteSnapshot(storage: Storage, kind: Kind, id: string): Promise<void> {
  if (kind === 'tensorlake') {
    await storage.snapshots.delete(id).catch((err: { code?: string }) => {
      if (err?.code !== 'NotFound') throw err;
    });
    return;
  }
  if (kind === 'azure') {
    await (storage.raw as BlobServiceClient).getContainerClient(id).deleteIfExists();
    return;
  }
  const client = storage.raw as S3Client;
  try {
    await emptyBucket(client, id);
    await client.send(new DeleteBucketCommand({ Bucket: id }));
  } catch (err) {
    if ((err as { name?: string })?.name !== 'NoSuchBucket') throw err;
  }
}

async function emptyBucket(client: S3Client, bucket: string): Promise<void> {
  let versioned = true;
  for (;;) {
    let objects: { Key: string; VersionId?: string }[];
    let truncated: boolean;
    if (versioned) {
      try {
        const res = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
        objects = [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]
          .filter((v) => v.Key)
          .map((v) => ({ Key: v.Key!, ...(v.VersionId ? { VersionId: v.VersionId } : {}) }));
        truncated = !!res.IsTruncated;
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name !== 'NotImplemented' && (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 501) throw err;
        versioned = false;
        continue;
      }
    } else {
      const res = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      objects = (res.Contents ?? []).filter((o) => o.Key).map((o) => ({ Key: o.Key! }));
      truncated = !!res.IsTruncated;
    }
    if (objects.length) {
      const out = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      if (out.Errors?.length) throw new Error(`DeleteObjects failed for ${out.Errors.length} key(s) in ${bucket}`);
    }
    if (!objects.length && !truncated) return;
  }
}

/**
 * Drop deleted ids from the parent's manifest in one write. Adapters that keep
 * the manifest in bucket tags (AWS S3) fall back to per-id `snapshots.delete`,
 * which tolerates the already-gone sibling.
 */
async function pruneManifest(storage: Storage, kind: Kind, parent: string, gone: Set<string>, log: (line: string) => void) {
  const raw = await readManifestObject(storage, kind, parent);
  if (raw === undefined) {
    for (const id of gone) await withRetries(() => storage.snapshots.delete(id));
    log(`manifest: removed ${gone.size} entr${gone.size === 1 ? 'y' : 'ies'} via snapshots.delete`);
    return;
  }
  const manifest = parseManifest(raw);
  const before = manifest.snapshots.length;
  manifest.snapshots = manifest.snapshots.filter((s) => !gone.has(s.id));
  const body = serializeManifest(manifest);
  if (kind === 'azure') {
    await (storage.raw as BlobServiceClient).getContainerClient(parent).getBlockBlobClient(MANIFEST_PATH)
      .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
  } else {
    await (storage.raw as S3Client).send(new PutObjectCommand({ Bucket: parent, Key: MANIFEST_PATH, Body: body, ContentType: 'application/json' }));
  }
  log(`manifest snapshots ${before} -> ${manifest.snapshots.length}`);
}

async function readManifestObject(storage: Storage, kind: Kind, parent: string): Promise<string | undefined> {
  if (kind === 'azure') {
    const blob = (storage.raw as BlobServiceClient).getContainerClient(parent).getBlockBlobClient(MANIFEST_PATH);
    return (await blob.exists()) ? (await blob.downloadToBuffer()).toString() : undefined;
  }
  try {
    const out = await (storage.raw as S3Client).send(new GetObjectCommand({ Bucket: parent, Key: MANIFEST_PATH }));
    return out.Body ? await out.Body.transformToString() : undefined;
  } catch (err) {
    if ((err as { name?: string })?.name === 'NoSuchKey') return undefined;
    throw err;
  }
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

async function main() {
  const name = process.argv[2];
  const kind = name ? KINDS[name] : undefined;
  if (!name || !kind) {
    throw new Error(`usage: tsx benchmarks/storage/cleanup-leaked-snapshots.ts <${Object.keys(KINDS).join('|')}>`);
  }
  const base = storageProviders.find((p) => p.name === name);
  if (!base) throw new Error(`unknown provider ${name}`);
  const p = base.snapshotFork ? { ...base, ...base.snapshotFork } : base;
  const missing = p.requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);

  const result = await cleanupLeakedSnapshots({
    storage: p.createStorage(),
    kind,
    parent: p.bucket,
    minAgeMs: Number(process.env.MIN_AGE_MIN ?? 60) * 60_000,
    delete: process.env.DELETE === '1',
  });
  if (result.failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(formatError(err));
    process.exit(1);
  });
}
