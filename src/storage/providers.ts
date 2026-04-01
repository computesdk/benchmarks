import { s3 } from '@computesdk/s3';
import { r2 } from '@computesdk/r2';
import { tigris } from '@computesdk/tigris';
import type { StorageProviderConfig } from './types.js';

/**
 * Storage provider benchmark configurations.
 *
 * All providers use ComputeSDK's storage packages directly (no ComputeSDK API key).
 */
export const storageProviders: StorageProviderConfig[] = [
  {
    name: 'aws-s3',
    requiredEnvVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET'],
    bucket: process.env.S3_BUCKET!,
    createStorage: () => s3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      region: process.env.AWS_REGION || 'us-east-1',
    }),
    fileSizes: [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024], // 1MB, 10MB, 100MB
  },
  {
    name: 'cloudflare-r2',
    requiredEnvVars: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ACCOUNT_ID'],
    bucket: process.env.R2_BUCKET!,
    createStorage: () => r2({
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      accountId: process.env.R2_ACCOUNT_ID!,
    }),
    fileSizes: [1024 * 1024, 10 * 1024 * 1024],
  },
  {
    name: 'tigris',
    requiredEnvVars: ['TIGRIS_STORAGE_ACCESS_KEY_ID', 'TIGRIS_STORAGE_SECRET_ACCESS_KEY', 'TIGRIS_STORAGE_BUCKET'],
    bucket: process.env.TIGRIS_STORAGE_BUCKET!,
    createStorage: () => tigris({
      accessKeyId: process.env.TIGRIS_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY!,
    }),
    fileSizes: [1024 * 1024, 10 * 1024 * 1024],
  },
  // 
  // add providers above
];
