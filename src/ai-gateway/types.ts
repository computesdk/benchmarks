export type AIGatewayScenario = 'short-nonstream' | 'short-stream';

export interface AIGatewayProviderConfig {
  name: string;
  requiredEnvVars: string[];
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultHeaders?: Record<string, string>;
  timeout?: number;
  iterations?: number;
}

export interface AIGatewayTimingResult {
  firstTokenMs: number;
  totalMs: number;
  outputTokens: number;
  outputTokensPerSec?: number;
  statusCode?: number;
  error?: string;
}

export interface AIGatewayStats {
  firstTokenMs: { median: number; p95: number; p99: number };
  totalMs: { median: number; p95: number; p99: number };
  outputTokensPerSec: { median: number; p95: number; p99: number };
}

export interface AIGatewayBenchmarkResult {
  provider: string;
  mode: 'ai-gateway';
  scenario: AIGatewayScenario;
  model: string;
  iterations: AIGatewayTimingResult[];
  summary: AIGatewayStats;
  throughputAvailable?: boolean;
  compositeScore?: number;
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
