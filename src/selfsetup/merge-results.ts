#!/usr/bin/env tsx
/**
 * Merge self-setup results from multiple provider runs
 * 
 * Usage: tsx src/selfsetup/merge-results.ts <artifacts-dir> <output-dir>
 */

import fs from 'fs';
import path from 'path';
import type { SelfSetupResult } from './types.js';

const artifactsDir = process.argv[2];
const outputDir = process.argv[3];

if (!artifactsDir || !outputDir) {
  console.error('Usage: tsx src/selfsetup/merge-results.ts <artifacts-dir> <output-dir>');
  process.exit(1);
}

const results: Record<string, SelfSetupResult> = {};

// Find all result files in artifacts
if (fs.existsSync(artifactsDir)) {
  const entries = fs.readdirSync(artifactsDir);
  
  for (const entry of entries) {
    const resultPath = path.join(artifactsDir, entry, `${entry}.json`);
    
    if (fs.existsSync(resultPath)) {
      const result: SelfSetupResult = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      results[result.provider] = result;
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

// Write latest.json symlink data
const latestPath = path.join(outputDir, 'latest.json');
const date = new Date().toISOString().slice(0, 10);
const datedPath = path.join(outputDir, `${date}.json`);
fs.writeFileSync(datedPath, JSON.stringify(summary, null, 2));
fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2));

console.log(`Merged ${summary.summary.total} results`);
console.log(`Passed: ${summary.summary.passed}`);
console.log(`Failed: ${summary.summary.failed}`);
console.log(`Output: ${summaryPath}`);
