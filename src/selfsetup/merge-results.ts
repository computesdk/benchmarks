#!/usr/bin/env tsx
/**
 * Merge self-setup results from multiple provider runs
 * 
 * Usage: tsx src/selfsetup/merge-results.ts <artifacts-dir> <output-dir>
 */

import fs from 'fs';
import path from 'path';
import { computeScore, didPass } from './score.js';
import type { SelfSetupResult } from './types.js';

const artifactsDir = process.argv[2];
const outputDir = process.argv[3];

if (!artifactsDir || !outputDir) {
  console.error('Usage: tsx src/selfsetup/merge-results.ts <artifacts-dir> <output-dir>');
  process.exit(1);
}

const results: Record<string, SelfSetupResult> = {};

/**
 * Recursively find all JSON result files in artifacts
 */
function findResultFiles(dir: string): string[] {
  const files: string[] = [];
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      files.push(...findResultFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

/**
 * Validate and ensure score is present on a result
 */
function validateResult(raw: Record<string, unknown>): SelfSetupResult {
  // Apply defaults and ensure score exists
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
    score: (raw.score as SelfSetupResult['score']) || { total: 0, autonomy: 0, time: 0, quality: 0, recovery: 0, docs: 0 },
    passed: (raw.passed as boolean) ?? false,
  };
  
  // Compute score if missing or invalid
  if (!result.score || result.score.total === 0) {
    result.score = computeScore(result);
    result.passed = didPass(result.score.total);
  }
  
  return result;
}

// Find all result files in artifacts
if (fs.existsSync(artifactsDir)) {
  const resultFiles = findResultFiles(artifactsDir);
  
  console.log(`Found ${resultFiles.length} result files`);
  
  for (const resultPath of resultFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      const result = validateResult(raw);
      results[result.provider] = result;
      console.log(`  - ${result.provider}: ${result.score.total}/100 (${result.passed ? 'PASS' : 'FAIL'})`);
    } catch (err) {
      console.warn(`  - Failed to process ${resultPath}:`, err);
    }
  }
}

// Create merged summary
const summary = {
  version: '1.0',
  timestamp: new Date().toISOString(),
  results: Object.values(results).sort((a, b) => b.score.total - a.score.total),
  summary: {
    total: Object.keys(results).length,
    passed: Object.values(results).filter(r => r.passed).length,
    failed: Object.values(results).filter(r => !r.passed).length,
  },
};

// Ensure output directory
fs.mkdirSync(outputDir, { recursive: true });

// Write merged results
const summaryPath = path.join(outputDir, 'summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

// Write dated and latest files
const date = new Date().toISOString().slice(0, 10);
const datedPath = path.join(outputDir, `${date}.json`);
fs.writeFileSync(datedPath, JSON.stringify(summary, null, 2));

const latestPath = path.join(outputDir, 'latest.json');
fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2));

console.log(`\nMerged ${summary.summary.total} results`);
console.log(`Passed: ${summary.summary.passed}`);
console.log(`Failed: ${summary.summary.failed}`);
console.log(`Output: ${summaryPath}`);
