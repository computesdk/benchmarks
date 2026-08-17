import { Storage } from '@storagesdk/core';
import { s3 } from '@storagesdk/adapters/s3';
import { r2 } from '@storagesdk/adapters/r2';
import { tigris } from '@storagesdk/adapters/tigris';
import { vercel } from '@storagesdk/adapters/vercel';
import { gcs } from '@storagesdk/adapters/gcs';
import { azure } from '@storagesdk/adapters/azure';
import { tensorlake } from '@storagesdk/adapters/tensorlake';
import { archil } from '@storagesdk/adapters/archil';
import { neon } from '@storagesdk/adapters/neon';
import type { StorageProviderConfig } from './types.js';

/**
 * Storage provider benchmark configurations.
 *
 * All providers use StorageSDK (https://storagesdk.dev) adapters directly
 * (no ComputeSDK API key).
 */
export const storageProviders: StorageProviderConfig[] = [
  {
    name: 'aws-s3',
    requiredEnvVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_BUCKET'],
    bucket: process.env.S3_BUCKET!,
    createStorage: () => new Storage({
      adapter: s3({
        bucket: process.env.S3_BUCKET!,
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024], // 1MB, 4MB, 10MB, 16MB
    // S3 snapshots/forks are emulated as sibling buckets (server-side copy +
    // root manifest), so they need credentials with bucket create/delete
    // permission — broader than the object-only creds used for upload/download.
    // Uses a dedicated bucket so the sibling-bucket churn is isolated.
    snapshotFork: {
      requiredEnvVars: ['S3_SNAPSHOT_ACCESS_KEY_ID', 'S3_SNAPSHOT_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_SNAPSHOT_BUCKET'],
      bucket: process.env.S3_SNAPSHOT_BUCKET!,
      createStorage: () => new Storage({
        adapter: s3({
          bucket: process.env.S3_SNAPSHOT_BUCKET!,
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.S3_SNAPSHOT_ACCESS_KEY_ID!,
            secretAccessKey: process.env.S3_SNAPSHOT_SECRET_ACCESS_KEY!,
          },
        }),
      }),
    },
  },
  {
    name: 'cloudflare-r2',
    requiredEnvVars: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ACCOUNT_ID'],
    bucket: process.env.R2_BUCKET!,
    createStorage: () => new Storage({
      adapter: r2({
        bucket: process.env.R2_BUCKET!,
        accountId: process.env.R2_ACCOUNT_ID!,
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
    // R2 snapshots/forks are emulated as sibling buckets (server-side copy +
    // root manifest object), so they need an API token with bucket create/delete
    // permission (R2 "Admin Read & Write") — broader than the object-only token
    // used for upload/download. Uses a dedicated bucket (same account) so the
    // sibling-bucket churn is isolated from the upload/download bucket.
    snapshotFork: {
      requiredEnvVars: ['R2_SNAPSHOT_ACCESS_KEY_ID', 'R2_SNAPSHOT_SECRET_ACCESS_KEY', 'R2_SNAPSHOT_BUCKET', 'R2_ACCOUNT_ID'],
      bucket: process.env.R2_SNAPSHOT_BUCKET!,
      createStorage: () => new Storage({
        adapter: r2({
          bucket: process.env.R2_SNAPSHOT_BUCKET!,
          accountId: process.env.R2_ACCOUNT_ID!,
          accessKeyId: process.env.R2_SNAPSHOT_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SNAPSHOT_SECRET_ACCESS_KEY!,
        }),
      }),
    },
  },
  {
    name: 'tigris',
    requiredEnvVars: ['TIGRIS_STORAGE_ACCESS_KEY_ID', 'TIGRIS_STORAGE_SECRET_ACCESS_KEY', 'TIGRIS_STORAGE_BUCKET'],
    bucket: process.env.TIGRIS_STORAGE_BUCKET!,
    createStorage: () => new Storage({
      adapter: tigris({
        bucket: process.env.TIGRIS_STORAGE_BUCKET!,
        accessKeyId: process.env.TIGRIS_STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY!,
        ...(process.env.TIGRIS_STORAGE_ENDPOINT ? { endpoint: process.env.TIGRIS_STORAGE_ENDPOINT } : {}),
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
    // Tigris snapshots require a Standard-tier, snapshot-enabled bucket, which
    // the default upload/download bucket is not. Point snapshot-fork mode at a
    // dedicated snapshot-enabled bucket with its own credentials.
    snapshotFork: {
      requiredEnvVars: ['TIGRIS_SNAPSHOT_ACCESS_KEY', 'TIGRIS_SNAPSHOT_SECRET_KEY', 'TIGRIS_SNAPSHOT_STORAGE_BUCKET'],
      bucket: process.env.TIGRIS_SNAPSHOT_STORAGE_BUCKET!,
      createStorage: () => new Storage({
        adapter: tigris({
          bucket: process.env.TIGRIS_SNAPSHOT_STORAGE_BUCKET!,
          accessKeyId: process.env.TIGRIS_SNAPSHOT_ACCESS_KEY!,
          secretAccessKey: process.env.TIGRIS_SNAPSHOT_SECRET_KEY!,
          ...(process.env.TIGRIS_STORAGE_ENDPOINT ? { endpoint: process.env.TIGRIS_STORAGE_ENDPOINT } : {}),
        }),
      }),
    },
  },
  {
    name: 'vercel-blob',
    requiredEnvVars: ['BLOB_READ_WRITE_TOKEN'],
    bucket: process.env.VERCEL_BLOB_BUCKET || 'benchmarks',
    createStorage: () => new Storage({
      adapter: vercel({
        bucket: process.env.VERCEL_BLOB_BUCKET || 'benchmarks',
        token: process.env.BLOB_READ_WRITE_TOKEN!,
        access: 'private',
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
    // Snapshot-fork is disabled for Vercel Blob pending an adapter fix. The
    // adapter emulates snapshots/forks via a single shared manifest object and
    // read-modify-writes it on every create/delete. On Vercel Blob's
    // eventually-consistent overwrites this is unreliable: snapshot.create can
    // be invisible to the immediate fork (stale read, 0.3s–>30s window) and
    // ~60% of deletes are lost, so the manifest accumulates orphans and teardown
    // can't drain it. Re-enable once @storagesdk/adapters makes the Vercel
    // snapshot/fork metadata strongly consistent (e.g. per-entry objects).
    // snapshotFork: {
    //   requiredEnvVars: ['VERCEL_SNAPSHOT_BLOB_READ_WRITE_TOKEN'],
    //   bucket: process.env.VERCEL_SNAPSHOT_BLOB_BUCKET || 'benchmarks-snapshot',
    //   createStorage: () => new Storage({
    //     adapter: vercel({
    //       bucket: process.env.VERCEL_SNAPSHOT_BLOB_BUCKET || 'benchmarks-snapshot',
    //       token: process.env.VERCEL_SNAPSHOT_BLOB_READ_WRITE_TOKEN!,
    //       access: 'private',
    //     }),
    //   }),
    // },
  },
  {
    name: 'gcs',
    requiredEnvVars: ['GCS_PROJECT_ID', 'GCS_BUCKET', 'GCS_CLIENT_EMAIL', 'GCS_PRIVATE_KEY'],
    bucket: process.env.GCS_BUCKET!,
    createStorage: () => new Storage({
      adapter: gcs({
        bucket: process.env.GCS_BUCKET!,
        projectId: process.env.GCS_PROJECT_ID!,
        credentials: {
          client_email: process.env.GCS_CLIENT_EMAIL!,
          // Secrets store the key with literal "\n"; restore real newlines.
          private_key: process.env.GCS_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        },
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
  },
  {
    name: 'azure-blob',
    requiredEnvVars: ['AZURE_ACCOUNT_NAME', 'AZURE_ACCOUNT_KEY', 'AZURE_CONTAINER'],
    bucket: process.env.AZURE_CONTAINER!,
    createStorage: () => new Storage({
      adapter: azure({
        bucket: process.env.AZURE_CONTAINER!,
        accountName: process.env.AZURE_ACCOUNT_NAME!,
        accountKey: process.env.AZURE_ACCOUNT_KEY!,
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
    // Azure snapshots/forks are emulated as sibling containers (server-side
    // copy-from-URL per blob + a root manifest blob), so they need an account
    // key with container create/delete permission — the account key grants this
    // at the storage-account level. Point snapshot-fork mode at a dedicated
    // snapshot container/account so the sibling-container churn is isolated from
    // the upload/download container.
    snapshotFork: {
      requiredEnvVars: ['AZURE_SNAPSHOT_ACCOUNT_NAME', 'AZURE_SNAPSHOT_ACCOUNT_KEY', 'AZURE_SNAPSHOT_CONTAINER'],
      bucket: process.env.AZURE_SNAPSHOT_CONTAINER!,
      createStorage: () => new Storage({
        adapter: azure({
          bucket: process.env.AZURE_SNAPSHOT_CONTAINER!,
          accountName: process.env.AZURE_SNAPSHOT_ACCOUNT_NAME!,
          accountKey: process.env.AZURE_SNAPSHOT_ACCOUNT_KEY!,
        }),
      }),
    },
  },
  {
    name: 'tensorlake',
    requiredEnvVars: [
      'TENSORLAKE_API_KEY',
      'TENSORLAKE_ORGANIZATION_ID',
      'TENSORLAKE_PROJECT_ID',
      'TENSORLAKE_FILESYSTEM',
    ],
    bucket: process.env.TENSORLAKE_FILESYSTEM!,
    createStorage: () => new Storage({
      adapter: tensorlake({
        apiKey: process.env.TENSORLAKE_API_KEY!,
        organizationId: process.env.TENSORLAKE_ORGANIZATION_ID!,
        projectId: process.env.TENSORLAKE_PROJECT_ID!,
        filesystem: process.env.TENSORLAKE_FILESYSTEM!,
        ...(process.env.TENSORLAKE_API_URL
          ? { apiUrl: process.env.TENSORLAKE_API_URL }
          : {}),
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
  },
  {
    // Archil disks speak S3 through their own endpoints; `bucket` is the disk id.
    name: 'archil',
    requiredEnvVars: [
      'ARCHIL_S3_ACCESS_KEY_ID',
      'ARCHIL_S3_SECRET_ACCESS_KEY',
      'ARCHIL_BUCKET',
      'ARCHIL_REGION',
    ],
    bucket: process.env.ARCHIL_BUCKET!,
    createStorage: () => new Storage({
      adapter: archil({
        bucket: process.env.ARCHIL_BUCKET!,
        region: process.env.ARCHIL_REGION!,
        accessKeyId: process.env.ARCHIL_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.ARCHIL_S3_SECRET_ACCESS_KEY!,
        ...(process.env.ARCHIL_BRANCH ? { branch: process.env.ARCHIL_BRANCH } : {}),
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
    // The Archil adapter wraps the S3 adapter, so it inherits its
    // sibling-bucket snapshot/fork emulation (server-side copy + root
    // manifest) — here a sibling disk. Reuse the same envs as the storage
    // benchmark for Archil.
    snapshotFork: {
      requiredEnvVars: [
        'ARCHIL_S3_ACCESS_KEY_ID',
        'ARCHIL_S3_SECRET_ACCESS_KEY',
        'ARCHIL_BUCKET',
        'ARCHIL_REGION',
      ],
      bucket: process.env.ARCHIL_BUCKET!,
      createStorage: () => new Storage({
        adapter: archil({
          bucket: process.env.ARCHIL_BUCKET!,
          region: process.env.ARCHIL_REGION!,
          accessKeyId: process.env.ARCHIL_S3_ACCESS_KEY_ID!,
          secretAccessKey: process.env.ARCHIL_S3_SECRET_ACCESS_KEY!,
          ...(process.env.ARCHIL_BRANCH ? { branch: process.env.ARCHIL_BRANCH } : {}),
        }),
      }),
    },
  },
  {
    name: 'neon',
    requiredEnvVars: ['NEON_BUCKET', 'NEON_ENDPOINT', 'NEON_ACCESS_KEY_ID', 'NEON_SECRET_ACCESS_KEY'],
    bucket: process.env.NEON_BUCKET!,
    createStorage: () => new Storage({
      adapter: neon({
        bucket: process.env.NEON_BUCKET!,
        endpoint: process.env.NEON_ENDPOINT!,
        accessKeyId: process.env.NEON_ACCESS_KEY_ID!,
        secretAccessKey: process.env.NEON_SECRET_ACCESS_KEY!,
        ...(process.env.NEON_REGION ? { region: process.env.NEON_REGION } : {}),
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
    // Neon Object Storage is S3-compatible and uses sibling buckets for
    // snapshot/fork emulation. The same branch endpoint/credentials can be
    // reused; set NEON_SNAPSHOT_* vars to point snapshot/fork operations at a
    // dedicated bucket if the upload/download credential lacks bucket
    // create/delete permission.
    snapshotFork: {
      requiredEnvVars: ['NEON_BUCKET', 'NEON_ENDPOINT', 'NEON_ACCESS_KEY_ID', 'NEON_SECRET_ACCESS_KEY'],
      bucket: process.env.NEON_SNAPSHOT_BUCKET || process.env.NEON_BUCKET!,
      createStorage: () => new Storage({
        adapter: neon({
          bucket: process.env.NEON_SNAPSHOT_BUCKET || process.env.NEON_BUCKET!,
          endpoint: process.env.NEON_SNAPSHOT_ENDPOINT || process.env.NEON_ENDPOINT!,
          accessKeyId: process.env.NEON_SNAPSHOT_ACCESS_KEY_ID || process.env.NEON_ACCESS_KEY_ID!,
          secretAccessKey: process.env.NEON_SNAPSHOT_SECRET_ACCESS_KEY || process.env.NEON_SECRET_ACCESS_KEY!,
          ...(process.env.NEON_SNAPSHOT_REGION || process.env.NEON_REGION
            ? { region: process.env.NEON_SNAPSHOT_REGION || process.env.NEON_REGION }
            : {}),
        }),
      }),
    },
  },
  {
    // Mosaic Object Storage is an S3-compatible service that places and
    // replicates data itself, so `region` is 'auto' and buckets are addressed
    // by path. Credentials come from an API key created at
    // storage.mosaicos.com (`POST /v1/api-keys/<id>/sigv4`).
    //
    // No snapshotFork entry: snapshot/fork emulation churns sibling buckets,
    // and a Mosaic account is capped at 10 buckets, so the suite runs out of
    // buckets partway through rather than measuring anything.
    name: 'mosaic',
    requiredEnvVars: [
      'MOSAIC_STORAGE_BUCKET',
      'MOSAIC_STORAGE_ACCESS_KEY_ID',
      'MOSAIC_STORAGE_SECRET_ACCESS_KEY',
    ],
    bucket: process.env.MOSAIC_STORAGE_BUCKET!,
    createStorage: () => new Storage({
      adapter: s3({
        bucket: process.env.MOSAIC_STORAGE_BUCKET!,
        region: 'auto',
        endpoint: process.env.MOSAIC_STORAGE_ENDPOINT || 'https://storage.mosaicos.com',
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.MOSAIC_STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.MOSAIC_STORAGE_SECRET_ACCESS_KEY!,
        },
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
  },
  //
  // add providers above
];
