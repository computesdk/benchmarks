export interface ProviderConfig {
  /** Provider name */
  name: string;
  /** Number of iterations (default: 10) */
  iterations?: number;
  /** Timeout per iteration in ms (default: 120000) */
  timeout?: number;
  /** Environment variables that must all be set to run this benchmark */
  requiredEnvVars: string[];
  /** Creates a compute instance — either direct SDK or gateway-based */
  createCompute: () => any;
}

export interface TimingResult {
  /** Total time from start to first successful code execution */
  ttiMs: number;
  /** Error message if this iteration failed */
  error?: string;
}

export interface Stats {
  min: number;
  max: number;
  median: number;
  p95: number;
  p99: number;
  avg: number;
}

export interface BenchmarkResult {
  provider: string;
  iterations: TimingResult[];
  summary: {
    ttiMs: Stats;
  };
  skipped?: boolean;
  skipReason?: string;
}
