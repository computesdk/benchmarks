#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWorkflowDefaults } from './oss-workflow-defaults.mjs';

const providerFilter = process.env.PROVIDER_FILTER || '';
const benchmarkFilter = process.env.BENCHMARK_FILTER || 'all';
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

function iterationsFor(kind) {
  if (runMode === 'manual') {
    const override = categoryOverrides[kind] || iterationOverride;
    if (override) return override === '0' ? null : override;
    return resolveWorkflowDefaults(process.cwd(), kind).manual;
  }
  return resolveWorkflowDefaults(process.cwd(), kind)[runMode];
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
  for (const provider of providers) {
    if (providerSelected(provider.name)) {
      include.push({ kind, provider: provider.name, iterations, ...extra });
    }
  }
}

const sandboxProviders = await load('./benchmarks/sandbox/providers.ts', 'providers');
add('sandbox', sandboxProviders);
add('dax', sandboxProviders);

const storageProviders = await load('./benchmarks/storage/providers.ts', 'storageProviders');
for (const size of ['1MB', '4MB', '10MB', '16MB']) {
  add('storage', storageProviders, { fileSize: size });
}
add('snapshot-fork', storageProviders.filter((provider) => provider.snapshotFork));

const browserProviders = await load('./benchmarks/browser/providers.ts', 'browserProviders');
add('browser', browserProviders);

const throughputProviders = await load(
  './benchmarks/browser/throughput-providers.ts',
  'throughputProviders',
);
add('browser-throughput', throughputProviders);

const aiGatewayProviders = await load('./benchmarks/ai-gateway/providers.ts', 'providers');
if (
  selected('ai-gateway') &&
  aiGatewayProviders.some((provider) => providerSelected(provider.name))
) {
  const iterations = iterationsFor('ai-gateway');
  if (iterations !== null) {
    include.push({ kind: 'ai-gateway', provider: 'all', iterations });
  }
}

process.stdout.write(`${JSON.stringify({ include })}\n`);
