/**
 * AI Gateway model index benchmark.
 *
 * Calls each gateway's model-list/catalog endpoint (`/v1/models` or equivalent)
 * and writes a normalized JSON matrix of every model each gateway exposes,
 * including provider/routing options when the response carries them. No chat
 * probes are sent — this is a pure discovery/catalog benchmark.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway-model-index.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-model-index.bench.ts --provider openrouter
 */
import '../src/env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { BenchmarkRunOutcome } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/api';
import { modelIndexProviders } from './model-index-providers.js';
import { runModelIndexTask } from './model-index-task.js';
import type { AIGatewayModelIndexProviderResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function gatherResults(outcome: BenchmarkRunOutcome): AIGatewayModelIndexProviderResult[] {
  return outcome.participants
    .flatMap((p) => p.records)
    .map((r) => r.data as JsonObject | undefined)
    .filter((d): d is JsonObject => !!d)
    .map((d) => d as unknown as AIGatewayModelIndexProviderResult);
}

function participantNames(outcome: BenchmarkRunOutcome): string[] {
  return outcome.participants.map((p) => p.participant);
}

function isFullRun(outcome: BenchmarkRunOutcome): boolean {
  const actual = new Set(participantNames(outcome));
  const all = new Set(modelIndexProviders.map((p) => p.name));
  return actual.size === all.size && [...actual].every((name) => all.has(name));
}

function resultSuffix(outcome: BenchmarkRunOutcome): string {
  if (isFullRun(outcome)) return '';
  const names = [...new Set(participantNames(outcome))].sort();
  return names.length ? `-${names.join('+')}` : '-empty';
}

function writeModelIndexResults(outcome: BenchmarkRunOutcome, resultsDir: string): void {
  const results = gatherResults(outcome);
  fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const payload = {
    version: '1.0',
    timestamp,
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    results,
  };

  const date = timestamp.slice(0, 10);
  const suffix = resultSuffix(outcome);
  const datedPath = path.join(resultsDir, `${date}${suffix}.json`);
  const latestPath = path.join(resultsDir, `latest${suffix}.json`);

  fs.writeFileSync(datedPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2));

  console.log(`Wrote model index results to ${datedPath} and ${latestPath}`);
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'ai-gateway-model-index',
  benchmarkName: 'AI Gateway Model Index',
  iterations: 1,
  participants: modelIndexProviders,
  onComplete: (outcome) => {
    writeModelIndexResults(
      outcome,
      path.resolve(__dirname, '../../results/ai-gateway-model-index'),
    );
  },
});

export const task = defineTask(runModelIndexTask);
