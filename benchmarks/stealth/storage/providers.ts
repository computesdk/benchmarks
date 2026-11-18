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

export function normalizeGcsPrivateKey(value: string): string {
  let key = value.trim();
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      key = JSON.parse(key) as string;
    } catch {
      // Fall through and normalize the value as plain text.
    }
  }
  return key
    .replaceAll('\\\\r\\\\n', '\r\n')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r\\n', '\r\n')
    .replace(/\r\n/g, '\n');
}

export function isStorageProviderAvailable(provider: StorageProviderConfig): boolean {
  if (provider.requiredEnvVars.some((name) => !process.env[name])) {
    return false;
  }
  try {
    provider.createStorage();
    return true;
  } catch {
    console.warn(`Skipping ${provider.name}: storage credentials could not be initialized`);
    return false;
  }
}

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
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
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
          private_key: normalizeGcsPrivateKey(process.env.GCS_PRIVATE_KEY!),
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
];
