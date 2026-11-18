#!/usr/bin/env tsx
/**
 * Write a GitHub Actions step summary for merged storage-concurrency results.
 *
 * Reads results/storage_concurrency/latest.json and writes the provider
 * ranking + per-cell detail tables to GITHUB_STEP_SUMMARY (or stdout outside
 * GitHub Actions).
 */
import fs from 'node:fs';
import type { StorageConcurrencyResults } from '../storage/storage-concurrency-results.js';

const INPUT = 'results/storage_concurrency/latest.json';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;

function write(text: string): void {
  if (SUMMARY_FILE) {
    fs.appendFileSync(SUMMARY_FILE, `${text}\n`);
  } else {
    console.log(text);
  }
}

function providerName(provider: string): string {
  return {
    'aws-s3': 'AWS S3',
    'cloudflare-r2': 'Cloudflare R2',
    'vercel-blob': 'Vercel Blob',
    'azure-blob': 'Azure Blob',
  }[provider] ?? provider;
}

function number(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

if (!fs.existsSync(INPUT)) {
  write('No storage concurrency results found.');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(INPUT, 'utf-8')) as StorageConcurrencyResults;

const summaries = [...data.results]
  .sort((a, b) => b.compositeScore - a.compositeScore)
  .map((provider) => ({
    ...provider,
    displayName: providerName(provider.provider),
    peakThroughput: Math.max(...provider.cells.map((cell) => cell.throughputOpsPerSecond), 0),
  }));

write('## Storage Concurrency Results');
write('');
write(`Run: \`${data.runId}\` · Generated: ${data.timestamp}`);
write('');
if (summaries.length > 0) {
  write(`Top provider: **${summaries[0].displayName}** (${summaries[0].compositeScore.toFixed(2)}/100)`);
  write('');
}
write('| Rank | Provider | Composite score | Success rate | Valid cells | Peak throughput (ops/s) |');
write('|---:|---|---:|---:|---:|---:|');
for (const [index, provider] of summaries.entries()) {
  write(`| ${index + 1} | ${provider.displayName} | ${provider.compositeScore.toFixed(2)} | ${(provider.successRate * 100).toFixed(1)}% | ${(provider.validCellRate * 100).toFixed(1)}% | ${provider.peakThroughput.toFixed(1)} |`);
}
write('');
write('Scores combine throughput (45%), p50 latency (20%), p95 latency (20%), and p99 latency (15%) per cell, then apply success-rate penalties.');
write('');
write('### Cell details');
write('');
write('| Provider | Cell | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | Success | Valid |');
write('|---|---|---:|---:|---:|---:|---:|:---:|');
for (const provider of summaries) {
  for (const cell of provider.cells) {
    write(`| ${provider.displayName} | ${cell.phase} | ${cell.throughputOpsPerSecond.toFixed(1)} | ${number(cell.p50Ms)} | ${number(cell.p95Ms)} | ${number(cell.p99Ms)} | ${(cell.successRate * 100).toFixed(1)}% | ${cell.valid ? 'yes' : 'NO'} |`);
  }
}
