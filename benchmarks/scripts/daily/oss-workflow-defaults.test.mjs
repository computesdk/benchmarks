import assert from 'node:assert';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveWorkflowDefaults } from './oss-workflow-defaults.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ossRoot = process.env.BENCHMARKS_OSS_ROOT || resolve(__dirname, '../../..');

const expectations = {
  storage: {
    manual: '100',
    schedule: '110',
    scheduleConcurrency: '16',
    scheduleFileSizes: ['1MB', '4MB', '10MB', '16MB'],
  },
  sandbox: {
    manual: '100',
    schedule: '100',
    scheduleConcurrency: '100',
    scheduleFileSizes: undefined,
  },
  dax: {
    manual: '1',
    schedule: '1',
    scheduleConcurrency: undefined,
    scheduleFileSizes: undefined,
  },
  browser: {
    manual: '100',
    schedule: '100',
    scheduleConcurrency: undefined,
    scheduleFileSizes: undefined,
  },
  'browser-throughput': {
    manual: '100',
    schedule: '100',
    scheduleConcurrency: undefined,
    scheduleFileSizes: undefined,
  },
  'snapshot-fork': {
    manual: '100',
    schedule: '100',
    scheduleConcurrency: undefined,
    scheduleFileSizes: undefined,
  },
  // ai-gateway has no single --iterations expression: scheduled and manual
  // counts live on the per-family matrix entries instead.
  'ai-gateway': {
    manual: '50',
    scheduleByFamily: { anthropic: '50', openai: '50', gemini: '50', kimi: '25' },
    manualByFamily: { kimi: '25' },
    scheduleConcurrency: undefined,
    scheduleFileSizes: undefined,
  },
};

for (const [kind, expected] of Object.entries(expectations)) {
  test(`parses ${kind} defaults from OSS workflow`, () => {
    const defaults = resolveWorkflowDefaults(ossRoot, kind);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepStrictEqual(defaults[key], value, `${kind}.${key}`);
    }
  });
}
