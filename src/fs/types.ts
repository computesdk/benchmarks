export interface FsProviderConfig {
  /** Provider name */
  name: string;
  /** Number of iterations (default: 50) */
  iterations?: number;
  /** Timeout per iteration in ms (default: 120000) */
  timeout?: number;
  /** Environment variables that must all be set to run this benchmark */
  requiredEnvVars: string[];
  /** Creates a compute instance */
  createCompute: () => any;
  /** Options passed to sandbox.create() */
  sandboxOptions?: Record<string, any>;
  /** Timeout for sandbox.destroy() in ms */
  destroyTimeoutMs?: number;
}

export interface FsTimingResult {
  writeMs: number;
  readMs: number;
  smallFileOpsMs: number;
  metadataOpsMs: number;
  writeMbps: number;
  readMbps: number;
  fileSizeBytes: number;
  smallFilesCount: number;
  error?: string;
}

export interface FsStats {
  writeMs: { median: number; p95: number; p99: number };
  readMs: { median: number; p95: number; p99: number };
  smallFileOpsMs: { median: number; p95: number; p99: number };
  metadataOpsMs: { median: number; p95: number; p99: number };
  writeMbps: { median: number; p95: number; p99: number };
  readMbps: { median: number; p95: number; p99: number };
}

export interface FsBenchmarkResult {
  provider: string;
  mode: 'fs';
  fileSizeBytes: number;
  smallFilesCount: number;
  iterations: FsTimingResult[];
  summary: FsStats;
  compositeScore?: number;
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
