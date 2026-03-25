import crypto from 'crypto';
import { withTimeout } from '../benchmark.js';
import type { StorageProviderConfig, StorageBenchmarkResult, StorageTimingResult } from './types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeStorageStats(values: number[]): { median: number; p95: number; p99: number } {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}


async function runStorageIteration(
  storage: any,
  bucket: string,
  testData: Buffer,
  timeout: number
): Promise<StorageTimingResult> {
  const fileSizeBytes = testData.length;
  const key = `benchmark-${Date.now()}-${randomId()}`;

  try {
    // Upload timing
    const uploadStart = performance.now();
    await withTimeout(
      storage.upload(bucket, key, testData),
      timeout,
      'Upload timed out'
    );
    const uploadMs = performance.now() - uploadStart;

    // Download timing
    const downloadStart = performance.now();
    await withTimeout(
      storage.download(bucket, key),
      timeout,
      'Download timed out'
    );
    const downloadMs = performance.now() - downloadStart;

    // Calculate throughput (Mbps)
    const throughputMbps = (fileSizeBytes * 8) / (downloadMs / 1000) / 1_000_000;

    // Cleanup
    try {
      await withTimeout(
        storage.delete(bucket, key),
        10000,
        'Delete timed out'
      );
    } catch (err) {
      console.warn(`    [cleanup] delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { uploadMs, downloadMs, throughputMbps, fileSizeBytes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    
    // Attempt cleanup even on failure
    try {
      await withTimeout(storage.delete(bucket, key), 10000, 'Delete timed out');
    } catch {
      // Ignore cleanup errors
    }

    return { uploadMs: 0, downloadMs: 0, throughputMbps: 0, fileSizeBytes, error };
  }
}

export async function runStorageBenchmark(config: StorageProviderConfig, fileSizeBytes: number): Promise<StorageBenchmarkResult> {
  const { name, iterations = 100, timeout = 30000, requiredEnvVars, createStorage, bucket } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'storage',
      bucket,
      fileSizeBytes,
      iterations: [],
      summary: {
        uploadMs: { median: 0, p95: 0, p99: 0 },
        downloadMs: { median: 0, p95: 0, p99: 0 },
        throughputMbps: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const storage = createStorage();
  const results: StorageTimingResult[] = [];
  const fileSizeLabel = `${(fileSizeBytes / 1024 / 1024).toFixed(0)}MB`;
  const testData = crypto.randomBytes(fileSizeBytes);

  console.log(`\n--- Storage Benchmarking: ${name} (${fileSizeLabel}, ${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);

    try {
      const iterationResult = await runStorageIteration(storage, bucket, testData, timeout);
      results.push(iterationResult);

      if (iterationResult.error) {
        console.log(`    FAILED: ${iterationResult.error}`);
      } else {
        console.log(`    Upload: ${(iterationResult.uploadMs / 1000).toFixed(2)}s, Download: ${(iterationResult.downloadMs / 1000).toFixed(2)}s, Throughput: ${iterationResult.throughputMbps.toFixed(2)} Mbps`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({ uploadMs: 0, downloadMs: 0, throughputMbps: 0, fileSizeBytes, error });
    }
  }

  const successful = results.filter(r => !r.error);

  // If every iteration failed, mark as skipped
  if (successful.length === 0) {
    return {
      provider: name,
      mode: 'storage',
      bucket,
      fileSizeBytes,
      iterations: results,
      summary: {
        uploadMs: { median: 0, p95: 0, p99: 0 },
        downloadMs: { median: 0, p95: 0, p99: 0 },
        throughputMbps: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: 'All iterations failed',
    };
  }

  const uploadTimes = successful.map(r => r.uploadMs);
  const downloadTimes = successful.map(r => r.downloadMs);
  const throughputs = successful.map(r => r.throughputMbps);

  return {
    provider: name,
    mode: 'storage',
    bucket,
    fileSizeBytes,
    iterations: results,
    summary: {
      uploadMs: computeStorageStats(uploadTimes),
      downloadMs: computeStorageStats(downloadTimes),
      throughputMbps: computeStorageStats(throughputs),
    },
  };
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeStorageResultsJson(results: StorageBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    bucket: r.bucket,
    fileSizeBytes: r.fileSizeBytes,
    iterations: r.iterations.map(i => ({
      uploadMs: round(i.uploadMs),
      downloadMs: round(i.downloadMs),
      throughputMbps: round(i.throughputMbps),
      fileSizeBytes: i.fileSizeBytes,
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      uploadMs: roundStats(r.summary.uploadMs),
      downloadMs: roundStats(r.summary.downloadMs),
      throughputMbps: roundStats(r.summary.throughputMbps),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.1',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 30000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
