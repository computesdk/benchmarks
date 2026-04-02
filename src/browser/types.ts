export interface BrowserProviderConfig {
  /** Provider name */
  name: string;
  /** Number of iterations (default: 25) */
  iterations?: number;
  /** Timeout for session creation in ms (default: 120000) */
  timeout?: number;
  /** Environment variables that must all be set to run this benchmark */
  requiredEnvVars: string[];
  /** Creates a browser provider instance */
  createBrowserProvider: () => any;
}

export interface BrowserTimingResult {
  /** Time to create a browser session in ms */
  createMs: number;
  /** Time to connect over CDP in ms */
  connectMs: number;
  /** Time to navigate to example.com in ms */
  navigateMs: number;
  /** Time to release/destroy the session in ms */
  releaseMs: number;
  /** Total time for the full lifecycle in ms */
  totalMs: number;
  /** Error message if this iteration failed */
  error?: string;
}

export interface BrowserStats {
  createMs: { median: number; p95: number; p99: number };
  connectMs: { median: number; p95: number; p99: number };
  navigateMs: { median: number; p95: number; p99: number };
  releaseMs: { median: number; p95: number; p99: number };
  totalMs: { median: number; p95: number; p99: number };
}

export interface BrowserBenchmarkResult {
  provider: string;
  mode: 'browser';
  iterations: BrowserTimingResult[];
  summary: BrowserStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
