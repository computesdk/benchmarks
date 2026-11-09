#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWorkflowDefaults } from './oss-workflow-defaults.mjs';

const providerFilter = process.env.PROVIDER_FILTER || '';
const benchmarkFilter = process.env.BENCHMARK_FILTER || 'all';
const familyFilter = process.env.FAMILY_FILTER || 'all';
const runMode = process.env.RUN_MODE || 'manual';
const iterationOverride = process.env.ITERATIONS_OVERRIDE || '';
const categoryOverrides = {
  sandbox: process.env.SANDBOX_ITERATIONS || '',
  dax: process.env.DAX_ITERATIONS || '',
  storage: process.env.STORAGE_ITERATIONS || '',
  'snapshot-fork': process.env.SNAPSHOT_FORK_ITERATIONS || '',
  browser: process.env.BROWSER_ITERATIONS || '',
  'browser-throughput': process.env.BROWSER_THROUGHPUT_ITERATIONS || '',
  'ai-gateway': process.env.AI_GATEWAY_ITERATIONS || '',
};

function selected(kind) {
  return benchmarkFilter === 'all' || benchmarkFilter === kind;
}

function providerSelected(name) {
  return !providerFilter || providerFilter === name;
}

function familySelected(name) {
  return familyFilter === 'all' || familyFilter === name;
}

const defaultsCache = new Map();

function defaultsFor(kind) {
  if (!defaultsCache.has(kind)) {
    defaultsCache.set(kind, resolveWorkflowDefaults(process.cwd(), kind));
  }
  return defaultsCache.get(kind);
}

function iterationsFor(kind) {
  if (runMode === 'manual') {
    const override = categoryOverrides[kind] || iterationOverride;
    if (override) return override === '0' ? null : override;
    return defaultsFor(kind).manual;
  }
  return defaultsFor(kind)[runMode];
}

function concurrencyFor(kind) {
  return defaultsFor(kind).scheduleConcurrency;
}

async function load(modulePath, exportName) {
  const moduleNamespace = await import(pathToFileURL(path.resolve(process.cwd(), modulePath)));
  const providers = moduleNamespace[exportName];
  if (!Array.isArray(providers)) {
    throw new Error(`Expected ${exportName} to be an array in ${modulePath}`);
  }
  return providers;
}

const include = [];
function add(kind, providers, extra = {}) {
  if (!selected(kind)) return;
  const iterations = iterationsFor(kind);
  if (iterations === null) return;
  const concurrency = concurrencyFor(kind);
  for (const provider of providers) {
    // Dispatch-only providers (manualOnly in the OSS providers list) are
    // excluded from every generated matrix, including manual runs here —
    // they run via the OSS repo's own workflow_dispatch path.
    if (provider.manualOnly) continue;
    if (providerSelected(provider.name)) {
      const entry = { kind, provider: provider.name, iterations, ...extra };
      if (concurrency) entry.concurrency = concurrency;
      include.push(entry);
    }
  }
}

const sandboxProviders = await load('./benchmarks/sandbox/providers.ts', 'providers');
add('sandbox', sandboxProviders);
add('dax', sandboxProviders);

const storageProviders = await load('./benchmarks/storage/providers.ts', 'storageProviders');
const storageFileSize = defaultsFor('storage').scheduleFileSize;
const fileSize = storageFileSize || '1MB,4MB,10MB,16MB';
add('storage', storageProviders, { fileSize });
add('snapshot-fork', storageProviders.filter((provider) => provider.snapshotFork));

const browserProviders = await load('./benchmarks/browser/providers.ts', 'browserProviders');
add('browser', browserProviders);

const throughputProviders = await load(
  './benchmarks/browser/throughput-providers.ts',
  'throughputProviders',
);
add('browser-throughput', throughputProviders);

const aiGatewayFamilies = [
  {
    family: 'anthropic',
    module: './benchmarks/ai-gateway/providers.ts',
    script: 'benchmarks/ai-gateway/ai-gateway.bench.ts',
    resultsDir: 'anthropic',
    vaultKind: 'ai-gateway',
  },
  {
    family: 'openai',
    module: './benchmarks/ai-gateway/providers-openai.ts',
    script: 'benchmarks/ai-gateway/ai-gateway-openai.bench.ts',
    resultsDir: 'openai',
    vaultKind: 'ai-gateway-openai',
  },
  {
    family: 'gemini',
    module: './benchmarks/ai-gateway/providers-gemini.ts',
    script: 'benchmarks/ai-gateway/ai-gateway-gemini.bench.ts',
    resultsDir: 'gemini',
    vaultKind: 'ai-gateway-gemini',
  },
  {
    family: 'kimi',
    module: './benchmarks/ai-gateway/providers-kimi.ts',
    script: 'benchmarks/ai-gateway/ai-gateway-kimi.bench.ts',
    resultsDir: 'kimi',
    vaultKind: 'ai-gateway-kimi',
    timeout: 150,
  },
];

if (selected('ai-gateway')) {
  for (const family of aiGatewayFamilies) {
    if (benchmarkFilter === 'ai-gateway' && !familySelected(family.family)) continue;
    const providers = await load(family.module, 'providers');
    if (!providers.some((provider) => providerSelected(provider.name))) continue;

    const defaults = defaultsFor('ai-gateway');
    const override = categoryOverrides['ai-gateway'] || iterationOverride;
    const iterations = override
      ? (override === '0' ? null : override)
      : runMode === 'schedule'
        ? (defaults.scheduleByFamily?.[family.family] ?? defaults.schedule)
        : (defaults.manualByFamily?.[family.family] ?? defaults.manual);
    if (iterations !== null) {
      include.push({
        kind: 'ai-gateway',
        family: family.family,
        provider: providerFilter || 'all',
        iterations,
        benchScript: family.script,
        resultsDir: family.resultsDir,
        vaultKind: family.vaultKind,
        timeout: family.timeout,
      });
    }
  }
}

// Model index is a single-leg discovery benchmark (iterations is fixed at 1 in
// the bench config) — no family split, no per-provider legs.
if (selected('ai-gateway-model-index')) {
  const providers = await load(
    './benchmarks/ai-gateway/model-index-providers.ts',
    'modelIndexProviders',
  );
  if (providers.some((provider) => providerSelected(provider.name))) {
    include.push({
      kind: 'ai-gateway-model-index',
      provider: providerFilter || 'all',
      iterations: '1',
      benchScript: 'benchmarks/ai-gateway/ai-gateway-model-index.bench.ts',
      vaultKind: 'ai-gateway-model-index',
      timeout: 30,
    });
  }
}

process.stdout.write(`${JSON.stringify({ include })}\n`);
