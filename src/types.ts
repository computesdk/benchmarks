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

export interface WorkloadConfig {
  /** Human-readable workload name */
  name: string;
  /** Optional command to prepare dependencies or code */
  setupCommand?: string;
  /** Optional command that represents the workload under test */
  command?: string;
  /** Working directory for setup/workload commands */
  cwd?: string;
  /** Per-command timeout in milliseconds */
  timeoutMs?: number;
}

export interface TimingResult {
  /** Total time from start to first successful code execution */
  ttiMs: number;
  /** Time spent running setup + workload command(s), when configured */
  workloadMs?: number;
  /** Total time from sandbox creation start through workload completion */
  totalMs?: number;
  /** Error message if this iteration failed */
  error?: string;
}

export interface Stats {
  min: number;
  max: number;
  median: number;
  avg: number;
}

export interface BenchmarkResult {
  provider: string;
  iterations: TimingResult[];
  summary: {
    ttiMs: Stats;
    workloadMs?: Stats;
    totalMs?: Stats;
  };
  skipped?: boolean;
  skipReason?: string;
}
