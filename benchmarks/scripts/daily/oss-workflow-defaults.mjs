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

function workflowInputDefault(source) {
  const workflowDispatch = source.match(
    /^  workflow_dispatch:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\s\S]))/m,
  )?.[1];
  if (!workflowDispatch) throw new Error('workflow_dispatch section not found');

  const iterations = workflowDispatch.match(
    /^\s{6}iterations:\n([\s\S]*?)(?=^\s{6}[A-Za-z0-9_-]+:|(?![\s\S]))/m,
  )?.[1];
  const match = iterations?.match(/^\s{8}default:\s*(['"]?)(.*?)\1\s*$/m);
  if (!match) throw new Error('workflow_dispatch iterations default not found');
  const value = match[2].trim();
  if (value !== '') return value;

  // Some workflows (e.g. ai-gateway) leave the dispatch default empty and
  // compute a fallback in the run block. Use the else-branch fallback.
  const fallback = source.match(
    /if\s*\[[\s\S]*?schedule[\s\S]*?];\s*then[\s\S]*?else\s*\n\s*ITERATIONS\s*=\s*['"](\d+)['"]/,
  )?.[1];
  if (fallback) return fallback;
  return value;
}

function scheduledDefault(source) {
  const expressions = [...source.matchAll(/--iterations\s+\$\{\{([\s\S]*?)\}\}/g)];
  if (expressions.length === 0) {
    // Some workflows (e.g. ai-gateway) set ITERATIONS via shell instead of a
    // --iterations expression. Look for the schedule branch assignment.
    const fallback = source.match(
      /if\s*\[[\s\S]*?schedule[\s\S]*?];\s*then\s*\n\s*ITERATIONS\s*=\s*['"](\d+)['"]/,
    )?.[1];
    if (fallback) return fallback;
    throw new Error('benchmark iterations expression not found');
  }

  const expression = expressions[expressions.length - 1][1];
  const scheduled = expression.match(
    /github\.event_name\s*==\s*['"]schedule['"]\s*&&\s*['"](\d+)['"]/,
  )?.[1];
  if (scheduled) return scheduled;

  const fallback = [...expression.matchAll(/\|\|\s*['"](\d+)['"]/g)].at(-1)?.[1];
  if (!fallback) throw new Error('scheduled iterations fallback not found');
  return fallback;
}

function getFlagToken(source, flag) {
  const re = new RegExp(`--${flag}([ \\t]+)([^\\n\\\\]*)`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) return undefined;
  return matches.at(-1)[2].trim();
}

function resolveVariable(source, name) {
  const re = new RegExp(`^\\s*${name}=(.+)`, 'm');
  const match = source.match(re);
  if (!match) return undefined;
  let value = match[1].replace(/\\$/, '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function resolveToken(source, token) {
  token = token.trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  if (token.startsWith('${{') && token.endsWith('}}')) {
    return token.slice(3, -2).trim();
  }
  if (token.startsWith('$')) {
    const name = token.replace(/^\$\{?/, '').replace(/\}$/, '');
    const assigned = resolveVariable(source, name);
    if (!assigned) return undefined;
    return resolveToken(source, assigned);
  }
  return token;
}

function getFlagExpression(source, flag) {
  const token = getFlagToken(source, flag);
  if (!token) return undefined;
  return resolveToken(source, token);
}

function scheduledValue(expression) {
  const scheduled = expression.match(
    /github\.event_name\s*==\s*['"]schedule['"]\s*&&\s*['"]([^'"]+)['"]/,
  )?.[1];
  if (scheduled) return scheduled;

  const fallback = [...expression.matchAll(/\|\|\s*['"]([^'"]+)['"]/g)].at(-1)?.[1];
  if (fallback) return fallback;

  const literal = expression.match(/^['"]([^'"]+)['"]$/)?.[1];
  if (literal) return literal;

  return undefined;
}

function scheduledConcurrency(source) {
  const expression = getFlagExpression(source, 'concurrency');
  if (!expression) return undefined;
  return scheduledValue(expression);
}

function scheduledFileSize(source) {
  const assigned = resolveVariable(source, 'FILE_SIZE');
  if (!assigned) return undefined;
  const expression = resolveToken(source, assigned);
  if (!expression) return undefined;
  return scheduledValue(expression);
}

function scheduledFileSizes(source) {
  const value = scheduledFileSize(source);
  if (!value) return undefined;
  return value.split(',').map((size) => size.trim()).filter(Boolean);
}

// Per-family values from a `matrix.family` list of `- slug:` entries — used by
// ai-gateway, where each family's scheduled/manual iteration count lives on
// its matrix entry rather than in a single --iterations expression.
function familyField(source, field) {
  const values = {};
  const blocks = source.matchAll(
    /-\s+slug:\s*(\w+)([\s\S]*?)(?=\n\s*-\s+slug:|\n\s*#|\n\s{4}\w|$)/g,
  );
  for (const block of blocks) {
    const value = block[2].match(
      new RegExp(`^\\s*${field}:\\s*["']?(\\S+?)["']?\\s*$`, 'm'),
    );
    if (value) values[block[1]] = value[1];
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

export function resolveWorkflowDefaults(ossRoot, kind) {
  const workflow = WORKFLOWS[kind];
  if (!workflow) throw new Error(`Unknown benchmark kind: ${kind}`);

  const source = fs.readFileSync(
    path.join(ossRoot, '.github', 'workflows', workflow),
    'utf8',
  );
  return {
    get manual() {
      return workflowInputDefault(source);
    },
    get schedule() {
      return scheduledDefault(source);
    },
    get scheduleByFamily() {
      return familyField(source, 'scheduleIterations');
    },
    get manualByFamily() {
      return familyField(source, 'iterations');
    },
    get scheduleConcurrency() {
      return scheduledConcurrency(source);
    },
    get scheduleFileSize() {
      return scheduledFileSize(source);
    },
    get scheduleFileSizes() {
      return scheduledFileSizes(source);
    },
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[process.argv.indexOf('--root') + 1] || process.cwd();
  const kind = process.argv[process.argv.indexOf('--kind') + 1];
  const runMode = process.argv[process.argv.indexOf('--run-mode') + 1] || 'manual';
  const defaults = resolveWorkflowDefaults(root, kind);
  process.stdout.write(`${defaults[runMode]}\n`);
}
