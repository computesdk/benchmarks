export interface StorageProviderConfig {
  /** Provider name */
  name: string;
  /** Number of iterations (default: 100) */
  iterations?: number;
  /** Timeout per operation in ms (default: 30000) */
  timeout?: number;
  /** Environment variables that must all be set to run this benchmark */
  requiredEnvVars: string[];
  /** Creates a storage instance */
  createStorage: () => any;
  /** Bucket name for testing */
  bucket: string;
  /** Test file sizes in bytes */
  fileSizes: number[];
}

export interface StorageTimingResult {
  /** Time to upload in ms */
  uploadMs: number;
  /** Time to download in ms */
  downloadMs: number;
  /** Throughput in Mbps */
  throughputMbps: number;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Error message if this iteration failed */
  error?: string;
}

export interface StorageStats {
  uploadMs: { median: number; p95: number; p99: number };
  downloadMs: { median: number; p95: number; p99: number };
  throughputMbps: { median: number; p95: number; p99: number };
}

export interface StorageBenchmarkResult {
  provider: string;
  mode: 'storage';
  bucket: string;
  fileSizeBytes: number;
  iterations: StorageTimingResult[];
  summary: StorageStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export type StorageFileSize = '1MB' | '10MB' | '100MB';

export const FILE_SIZE_BYTES: Record<StorageFileSize, number> = {
  '1MB': 1024 * 1024,
  '10MB': 10 * 1024 * 1024,
  '100MB': 100 * 1024 * 1024,
};
