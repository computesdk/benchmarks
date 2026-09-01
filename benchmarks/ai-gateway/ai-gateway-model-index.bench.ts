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
import type { JsonObject } from '@benchsdk/api';
import { modelIndexProviders } from './model-index-providers.js';
import { runModelIndexTask } from './model-index-task.js';
import type { AIGatewayModelIndexProviderResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function writeModelIndexResults(
  results: AIGatewayModelIndexProviderResult[],
  resultsDir: string,
): void {
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
  const datedPath = path.join(resultsDir, `${date}.json`);
  const latestPath = path.join(resultsDir, 'latest.json');

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
    const results = outcome.participants
      .flatMap((p) => p.records)
      .map((r) => r.data as JsonObject | undefined)
      .filter((d): d is JsonObject => !!d)
      .map((d) => d as unknown as AIGatewayModelIndexProviderResult);

    writeModelIndexResults(
      results,
      path.resolve(__dirname, '../../results/ai-gateway-model-index'),
    );
  },
});

export const task = defineTask(runModelIndexTask);
