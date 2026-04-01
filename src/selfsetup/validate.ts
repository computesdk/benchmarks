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

// Read raw result (produced by OpenCode agent)
const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

// Compute score
const score = computeScore(raw);

// Build final result
const result: SelfSetupResult = {
  ...raw,
  score,
  passed: didPass(score.total),
};

// Ensure output directory exists
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

// Write scored result
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

console.log(`Validated: ${inputPath}`);
console.log(`Scored: ${score.total}/100 (${result.passed ? 'PASS' : 'FAIL'})`);
console.log(`Output: ${outputPath}`);
