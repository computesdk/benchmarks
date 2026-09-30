import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKFLOWS = {
  sandbox: 'sandbox-tti-benchmarks.yml',
  dax: 'sandbox-dax-benchmarks.yml',
  storage: 'storage-benchmarks.yml',
  'snapshot-fork': 'snapshot-fork-benchmarks.yml',
  browser: 'browser-benchmarks.yml',
  'browser-throughput': 'browser-throughput-benchmarks.yml',
  'ai-gateway': 'ai-gateway-benchmarks.yml',
};

const FALLBACK_DEFAULTS = {
  // ai-gateway uses a shell-computed ITERATIONS value and an empty manual
  // default that resolves to 30 for non-schedule runs.
  'ai-gateway': { manual: '30', schedule: '10' },
};

function workflowInputDefault(source) {
  const workflowDispatch = source.match(
    /^  workflow_dispatch:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\s\S]))/m,
  )?.[1];
  if (!workflowDispatch) throw new Error('workflow_dispatch section not found');

  const iterations = workflowDispatch.match(
    /^\s{6}iterations:\n([\s\S]*?)(?=^\s{6}[A-Za-z0-9_-]+:|(?![\s\S]))/m,
  )?.[1];
  const value = iterations?.match(/^\s{8}default:\s*['"]?([^'"\n]*)['"]?\s*$/m)?.[1];
  if (value === undefined) throw new Error('workflow_dispatch iterations default not found');
  return value.trim();
}

function scheduledDefault(source) {
  const expressions = [...source.matchAll(/--iterations\s+\$\{\{([\s\S]*?)\}\}/g)];
  if (expressions.length === 0) throw new Error('benchmark iterations expression not found');

  const expression = expressions[expressions.length - 1][1];
  const scheduled = expression.match(
    /github\.event_name\s*==\s*['"]schedule['"]\s*&&\s*['"](\d+)['"]/,
  )?.[1];
  if (scheduled) return scheduled;

  const fallback = [...expression.matchAll(/\|\|\s*['"](\d+)['"]/g)].at(-1)?.[1];
  if (!fallback) throw new Error('scheduled iterations fallback not found');
  return fallback;
}

export function resolveWorkflowDefaults(ossRoot, kind) {
  const workflow = WORKFLOWS[kind];
  if (!workflow) throw new Error(`Unknown benchmark kind: ${kind}`);

  const source = fs.readFileSync(
    path.join(ossRoot, '.github', 'workflows', workflow),
    'utf8',
  );
  try {
    return {
      manual: workflowInputDefault(source),
      schedule: scheduledDefault(source),
    };
  } catch (err) {
    if (FALLBACK_DEFAULTS[kind]) return FALLBACK_DEFAULTS[kind];
    throw err;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const root = flag('--root') || process.cwd();
  const kind = flag('--kind');
  const runMode = flag('--run-mode') || 'manual';
  const defaults = resolveWorkflowDefaults(root, kind);
  process.stdout.write(`${defaults[runMode]}\n`);
}
