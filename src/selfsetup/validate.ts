#!/usr/bin/env tsx
/**
 * Validate and score a self-setup result file
 * 
 * Usage: tsx src/selfsetup/validate.ts <input.json> <output.json>
 */

import fs from 'fs';
import path from 'path';
import { computeScore, didPass } from './score.js';
import type { SelfSetupResult } from './types.js';

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: tsx src/selfsetup/validate.ts <input.json> <output.json>');
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

// Read raw result (produced by OpenCode agent or fallback)
let raw: Record<string, unknown>;
try {
  raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
} catch (err) {
  console.error(`Failed to parse ${inputPath}:`, err);
  process.exit(1);
}

// Apply defaults for missing fields
const result: SelfSetupResult = {
  provider: (raw.provider as string) || 'unknown',
  timestamp: (raw.timestamp as string) || new Date().toISOString(),
  success: (raw.success as boolean) ?? false,
  totalTimeMs: (raw.totalTimeMs as number) || 0,
  steps: (raw.steps as SelfSetupResult['steps']) || [],
  errors: (raw.errors as SelfSetupResult['errors']) || [],
  humanInterventions: (raw.humanInterventions as number) || 0,
  docComplaints: (raw.docComplaints as number) || 0,
  codeQuality: (raw.codeQuality as SelfSetupResult['codeQuality']) || 'failed',
  filesCreated: (raw.filesCreated as string[]) || [],
  executionOutput: raw.executionOutput as string | undefined,
  recordingPath: raw.recordingPath as string | undefined,
  
  // Compute score and passed status
  score: { total: 0, autonomy: 0, time: 0, quality: 0, recovery: 0, docs: 0 },
  passed: false,
};

// Compute score
result.score = computeScore(result);
result.passed = didPass(result.score.total);

// Ensure output directory exists
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

// Write scored result
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

console.log(`Validated: ${inputPath}`);
console.log(`Scored: ${result.score.total}/100 (${result.passed ? 'PASS' : 'FAIL'})`);
console.log(`Output: ${outputPath}`);
