#!/usr/bin/env tsx
/**
 * OpenCode Agent Runner for Self-Setup Benchmark
 * 
 * Production-grade runner with:
 * - Timeout enforcement
 * - Session recording
 * - Error handling
 * - Multiple AI provider support (OpenAI, Anthropic, Cloudflare)
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export type AIProvider = 'openai' | 'anthropic' | 'cloudflare';

export interface AgentRunnerConfig {
  /** Provider to test */
  provider: string;
  /** Working directory */
  workDir: string;
  /** Prompt to send to agent */
  prompt: string;
  /** Timeout in seconds (default: 900 = 15 min) */
  timeoutSeconds?: number;
  /** Whether to record session */
  recordSession?: boolean;
  /** Output file path */
  outputPath: string;
  /** AI provider to use (default: openai) */
  aiProvider?: AIProvider;
}

export interface AgentRunResult {
  /** Whether the run completed */
  completed: boolean;
  /** Path to result file if generated */
  resultPath?: string;
  /** Path to recording if generated */
  recordingPath?: string;
  /** Error message if run failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** AI provider used */
  aiProvider?: AIProvider;
}

/**
 * Check if OpenCode CLI is available
 */
export async function isOpenCodeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', ['opencode'], { timeout: 5000 });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Run command with timeout
 */
async function runCommand(
  cmd: string,
  args: string[],
  options: { timeout?: number; cwd?: string; env?: Record<string, string> }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeout,
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout?.on('data', (data) => stdout += data.toString());
    child.stderr?.on('data', (data) => stderr += data.toString());
    
    child.on('exit', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    
    child.on('error', (err) => reject(err));
  });
}

/**
 * Get environment variables for specific AI provider
 */
function getAIProviderEnv(aiProvider: AIProvider): Record<string, string> {
  const baseEnv: Record<string, string> = {
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || '',
  };
  
  switch (aiProvider) {
    case 'openai':
      return {
        ...baseEnv,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        OPENCODE_LLM_PROVIDER: 'openai',
      };
    case 'anthropic':
      return {
        ...baseEnv,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        OPENCODE_LLM_PROVIDER: 'anthropic',
      };
    case 'cloudflare':
      return {
        ...baseEnv,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '',
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
        OPENCODE_LLM_PROVIDER: 'cloudflare',
      };
    default:
      return baseEnv;
  }
}

/**
 * Run agent with OpenCode
 */
export async function runAgent(config: AgentRunnerConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  const recordingPath = config.recordSession 
    ? path.join(config.workDir, 'session.log')
    : undefined;
  
  const aiProvider = config.aiProvider || 'openai';
  
  // Check OpenCode availability
  const available = await isOpenCodeAvailable();
  if (!available) {
    return {
      completed: false,
      durationMs: Date.now() - startTime,
      error: 'OpenCode CLI not available. Please ensure opencode is installed and in PATH.',
      aiProvider,
    };
  }
  
  const args = [
    'run',
    '--workdir', config.workDir,
    '--timeout', String(config.timeoutSeconds || 900),
    '--prompt', config.prompt,
    '--output', config.outputPath,
  ];
  
  if (recordingPath) {
    args.push('--record-session', recordingPath);
  }
  
  // Add AI provider flag if OpenCode supports it
  if (aiProvider !== 'openai') {
    args.push('--llm-provider', aiProvider);
  }
  
  try {
    const result = await runCommand('opencode', args, {
      timeout: (config.timeoutSeconds || 900) * 1000 + 10000,
      env: getAIProviderEnv(aiProvider),
    });
    
    const durationMs = Date.now() - startTime;
    
    if (result.exitCode !== 0) {
      return {
        completed: false,
        durationMs,
        error: `OpenCode exited with code ${result.exitCode}: ${result.stderr}`,
        aiProvider,
      };
    }
    
    // Check if result was generated
    if (!fs.existsSync(config.outputPath)) {
      return {
        completed: false,
        durationMs,
        error: 'OpenCode completed but no result file generated',
        aiProvider,
      };
    }
    
    return {
      completed: true,
      resultPath: config.outputPath,
      recordingPath,
      durationMs,
      aiProvider,
    };
  } catch (err) {
    return {
      completed: false,
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
      aiProvider,
    };
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  const provider = args.find(a => !a.startsWith('--'));
  const workDir = args.find((_, i) => args[i - 1] === '--workdir') || '/tmp/selfsetup-test';
  const promptFile = args.find((_, i) => args[i - 1] === '--prompt-file');
  const outputPath = args.find((_, i) => args[i - 1] === '--output') || path.join(workDir, 'result.json');
  const timeoutSeconds = parseInt(args.find((_, i) => args[i - 1] === '--timeout') || '900', 10);
  const aiProvider = (args.find((_, i) => args[i - 1] === '--ai-provider') || 'openai') as AIProvider;
  
  if (!provider || !promptFile) {
    console.error('Usage: tsx src/selfsetup/agent.ts <provider> --prompt-file <path> --workdir <dir> [--output <path>] [--timeout <seconds>] [--ai-provider <openai|anthropic|cloudflare>]');
    process.exit(1);
  }
  
  const prompt = fs.readFileSync(promptFile, 'utf-8');
  
  runAgent({
    provider,
    workDir,
    prompt,
    outputPath,
    timeoutSeconds,
    aiProvider,
    recordSession: true,
  }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.completed ? 0 : 1);
  }).catch(err => {
    console.error('Agent runner failed:', err);
    process.exit(1);
  });
}
