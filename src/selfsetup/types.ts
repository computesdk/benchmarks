/**
 * Self-Setup Benchmark Types
 * 
 * Based on the AI Self-Setup Benchmark v1.0 specification
 */

export interface SelfSetupStep {
  /** Step name */
  name: 'discovery' | 'installation' | 'configuration' | 'integration' | 'execution';
  /** Whether the step completed successfully */
  completed: boolean;
  /** Time taken in milliseconds */
  timeMs: number;
  /** Error message if failed */
  error?: string;
  /** Additional step-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface SelfSetupError {
  /** Error message */
  message: string;
  /** When it occurred */
  timestamp: string;
  /** Was it handled gracefully? */
  handled: boolean;
  /** Step where error occurred */
  step: string;
}

export interface SelfSetupResult {
  /** Provider name */
  provider: string;
  /** Test timestamp */
  timestamp: string;
  /** Overall success */
  success: boolean;
  /** Total time in milliseconds */
  totalTimeMs: number;
  /** Individual step results */
  steps: SelfSetupStep[];
  /** Errors encountered */
  errors: SelfSetupError[];
  /** Number of times AI asked for human help */
  humanInterventions: number;
  /** Number of times AI complained about docs */
  docComplaints: number;
  /** Quality of generated code */
  codeQuality: 'excellent' | 'good' | 'messy' | 'failed';
  /** Files created during test */
  filesCreated: string[];
  /** Command output from execution */
  executionOutput?: string;
  /** Score breakdown */
  score: {
    total: number;
    autonomy: number;
    time: number;
    quality: number;
    recovery: number;
    docs: number;
  };
  /** Whether it passed the threshold (>= 90) */
  passed: boolean;
  /** Session recording path if available */
  recordingPath?: string;
}

export interface ProviderSelfSetupConfig {
  /** Provider identifier */
  name: string;
  /** npm package name to expect */
  npmPackage: string;
  /** Expected SDK import path */
  importPath: string;
  /** Credentials available in env */
  credentials: {
    name: string;
    envVar: string;
    description: string;
  }[];
  /** Hints for the AI (optional) */
  hints?: string[];
}

export interface SelfSetupTestOptions {
  /** Provider to test */
  provider: string;
  /** Working directory for test */
  workDir: string;
  /** Timeout in milliseconds (default: 15 min) */
  timeoutMs?: number;
  /** Whether to record the session */
  recordSession?: boolean;
}
