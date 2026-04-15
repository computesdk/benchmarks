export interface ComputePerfProviderConfig {
  /** Provider name */
  name: string;
  /** Number of iterations (default: 5) */
  iterations?: number;
  /** Timeout per iteration in ms (default: 2700000) */
  timeout?: number;
  /** Environment variables that must all be set to run this benchmark */
  requiredEnvVars: string[];
  /** Creates a compute instance */
  createCompute: () => any;
  /** Options passed to sandbox.create() */
  sandboxOptions?: Record<string, any>;
  /** Timeout for sandbox.destroy() in ms (default: 15000) */
  destroyTimeoutMs?: number;
}

export interface ComputePerfTimingResult {
  /** End-to-end workload time inside sandbox command execution */
  totalMs: number;
  /** Linux kernel compile time captured in-sandbox */
  buildMs: number;
  /** Number of CPUs reported by sandbox */
  cpuCount?: number;
  /** Total memory in KB reported by sandbox */
  memTotalKb?: number;
  /** Error message if this iteration failed */
  error?: string;
}

export interface ComputePerfStats {
  median: number;
  p95: number;
  p99: number;
}

export interface ComputePerfBenchmarkResult {
  provider: string;
  mode: 'compute-perf';
  workload: 'linux-kernel-build';
  workloadAcronym: 'LKB';
  kernelVersion: string;
  iterations: ComputePerfTimingResult[];
  summary: {
    buildMs: ComputePerfStats;
    totalMs: ComputePerfStats;
  };
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export const KERNEL_VERSION = '6.12.24';
export const WORKLOAD = 'linux-kernel-build';
export const WORKLOAD_ACRONYM = 'LKB';
