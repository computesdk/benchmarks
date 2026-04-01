#!/usr/bin/env tsx
/**
 * Agent Runner for Self-Setup Benchmark
 * 
 * Abstraction layer that supports multiple AI agent backends:
 * - OpenCode (primary)
 * - Aider (fallback)
 * - Mock/Simulation (for testing)
 * 
 * Production features:
 * - Cost tracking
 * - Timeout enforcement
 * - Session recording
 * - Graceful fallbacks
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';
import type { SelfSetupResult, SelfSetupStep } from './types.js';

const sleep = promisify(setTimeout);

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
  /** Agent backend to use */
  backend?: 'auto' | 'opencode' | 'aider' | 'mock';
  /** Cost budget in USD (0 = unlimited) */
  budgetUsd?: number;
}

export interface AgentRunResult {
  /** Whether the run completed (not whether it was successful) */
  completed: boolean;
  /** Path to result file if generated */
  resultPath?: string;
  /** Path to recording if generated */
  recordingPath?: string;
  /** Backend that was used */
  backendUsed: string;
  /** Cost incurred (if tracked) */
  costUsd?: number;
  /** Error message if run failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Detect which agent backends are available
 */
export async function detectBackends(): Promise<string[]> {
  const available: string[] = [];
  
  // Check for OpenCode
  try {
    const result = await runCommand('which', ['opencode'], { timeout: 5000 });
    if (result.exitCode === 0) available.push('opencode');
  } catch { /* not available */ }
  
  // Check for Aider
  try {
    const result = await runCommand('which', ['aider'], { timeout: 5000 });
    if (result.exitCode === 0) available.push('aider');
  } catch { /* not available */ }
  
  // Mock is always available for testing
  available.push('mock');
  
  return available;
}

/**
 * Run a command with timeout
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
 * Run agent with OpenCode backend
 */
async function runOpenCode(config: AgentRunnerConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  const recordingPath = config.recordSession 
    ? path.join(config.workDir, 'session.log')
    : undefined;
  
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
  
  try {
    const result = await runCommand('opencode', args, {
      timeout: (config.timeoutSeconds || 900) * 1000 + 10000, // buffer for cleanup
      env: {
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || '',
      },
    });
    
    const durationMs = Date.now() - startTime;
    
    if (result.exitCode !== 0) {
      return {
        completed: false,
        backendUsed: 'opencode',
        durationMs,
        error: `OpenCode exited with code ${result.exitCode}: ${result.stderr}`,
      };
    }
    
    // Check if result was generated
    if (!fs.existsSync(config.outputPath)) {
      return {
        completed: false,
        backendUsed: 'opencode',
        durationMs,
        error: 'OpenCode completed but no result file generated',
      };
    }
    
    return {
      completed: true,
      resultPath: config.outputPath,
      recordingPath,
      backendUsed: 'opencode',
      durationMs,
      // TODO: Extract actual cost from OpenCode output when available
      costUsd: undefined,
    };
  } catch (err) {
    return {
      completed: false,
      backendUsed: 'opencode',
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run agent with Aider backend (fallback)
 */
async function runAider(config: AgentRunnerConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  
  // Aider doesn't have the same interface, so we adapt
  // Write prompt to a file and have aider work on it
  const promptFile = path.join(config.workDir, 'TASK.md');
  fs.writeFileSync(promptFile, config.prompt);
  
  const args = [
    '--message', 'Complete the task described in TASK.md',
    '--no-git',
    '--yes',
    '.', // current directory
  ];
  
  try {
    const result = await runCommand('aider', args, {
      cwd: config.workDir,
      timeout: (config.timeoutSeconds || 900) * 1000,
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      },
    });
    
    const durationMs = Date.now() - startTime;
    
    // Aider doesn't output JSON directly, so we'd need to parse its output
    // For now, mark as incomplete since we need custom parsing
    return {
      completed: false,
      backendUsed: 'aider',
      durationMs,
      error: 'Aider backend requires custom result parsing (not fully implemented)',
    };
  } catch (err) {
    return {
      completed: false,
      backendUsed: 'aider',
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run mock/simulation backend (for testing)
 */
async function runMock(config: AgentRunnerConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  
  // Simulate a delay
  await sleep(1000);
  
  // Generate a mock result
  const mockResult: Partial<SelfSetupResult> = {
    provider: config.provider,
    timestamp: new Date().toISOString(),
    success: false,
    totalTimeMs: 1000,
    steps: [
      { name: 'discovery', completed: true, timeMs: 200 },
      { name: 'installation', completed: true, timeMs: 200 },
      { name: 'configuration', completed: true, timeMs: 200 },
      { name: 'integration', completed: false, timeMs: 200, error: 'Mock: Agent not available' },
      { name: 'execution', completed: false, timeMs: 200 },
    ] as SelfSetupStep[],
    errors: [{
      message: 'Agent backend not available (mock mode)',
      step: 'integration',
      handled: false,
      timestamp: new Date().toISOString(),
    }],
    humanInterventions: 0,
    docComplaints: 0,
    codeQuality: 'failed',
    filesCreated: [],
    executionOutput: undefined,
  };
  
  fs.writeFileSync(config.outputPath, JSON.stringify(mockResult, null, 2));
  
  return {
    completed: true,
    resultPath: config.outputPath,
    backendUsed: 'mock',
    durationMs: Date.now() - startTime,
    costUsd: 0,
  };
}

/**
 * Main agent runner - tries backends in order
 */
export async function runAgent(config: AgentRunnerConfig): Promise<AgentRunResult> {
  const available = await detectBackends();
  console.log(`Available agent backends: ${available.join(', ')}`);
  
  const backend = config.backend || 'auto';
  
  // Determine which backend to use
  let backendsToTry: string[] = [];
  
  if (backend === 'auto') {
    // Try OpenCode first, then Aider, then Mock
    if (available.includes('opencode')) backendsToTry.push('opencode');
    if (available.includes('aider')) backendsToTry.push('aider');
    backendsToTry.push('mock');
  } else if (available.includes(backend)) {
    backendsToTry = [backend];
  } else {
    console.warn(`Requested backend '${backend}' not available, using mock`);
    backendsToTry = ['mock'];
  }
  
  // Try each backend
  for (const tryBackend of backendsToTry) {
    console.log(`Trying backend: ${tryBackend}`);
    
    let result: AgentRunResult;
    
    switch (tryBackend) {
      case 'opencode':
        result = await runOpenCode(config);
        break;
      case 'aider':
        result = await runAider(config);
        break;
      case 'mock':
        result = await runMock(config);
        break;
      default:
        continue;
    }
    
    if (result.completed) {
      console.log(`Backend ${tryBackend} completed successfully`);
      return result;
    } else {
      console.warn(`Backend ${tryBackend} failed: ${result.error}`);
    }
  }
  
  // All backends failed
  return {
    completed: false,
    backendUsed: 'none',
    durationMs: 0,
    error: 'All agent backends failed',
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const provider = args.find(a => !a.startsWith('--'));
  const workDir = args.find((_, i) => args[i - 1] === '--workdir') || '/tmp/selfsetup-test';
  const promptFile = args.find((_, i) => args[i - 1] === '--prompt-file');
  const outputPath = args.find((_, i) => args[i - 1] === '--output') || path.join(workDir, 'result.json');
  const backend = args.find((_, i) => args[i - 1] === '--backend') as AgentRunnerConfig['backend'] || 'auto';
  
  if (!provider || !promptFile) {
    console.error('Usage: tsx src/selfsetup/agent.ts <provider> --prompt-file <path> --workdir <dir> [--output <path>] [--backend <backend>]');
    console.error('');
    console.error('Backends: auto (default), opencode, aider, mock');
    process.exit(1);
  }
  
  const prompt = fs.readFileSync(promptFile, 'utf-8');
  
  runAgent({
    provider,
    workDir,
    prompt,
    outputPath,
    backend,
    recordSession: true,
  }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.completed ? 0 : 1);
  }).catch(err => {
    console.error('Agent runner failed:', err);
    process.exit(1);
  });
}
