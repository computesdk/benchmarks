// Local-only seam: evaluate the actual CPU functions with no provider imports.
// No npm modules, cloud clients, credentials, or production edits are required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

export const cpuSourceUrl = new URL('../../../benchmarks/stealth/sandbox/cpu.bench.ts', import.meta.url);
export const scriptSourceUrl = new URL('../../../benchmarks/stealth/scripts/cpu-benchmark.sh', import.meta.url);
const source = fs.readFileSync(cpuSourceUrl, 'utf8');
const timeoutSource = fs.readFileSync(new URL('../../../benchmarks/stealth/src/util/timeout.ts', import.meta.url), 'utf8');
const sizesSource = fs.readFileSync(new URL('../../../benchmarks/stealth/sandbox/sizes.ts', import.meta.url), 'utf8');

function between(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source seam changed: ${start} / ${end}`);
  assert.equal(text.indexOf(start, a + start.length), -1, `ambiguous source seam: ${start}`);
  return text.slice(a, b);
}

const declarations = between(source, 'const timeout =', 'export const config =');
const marketSizes = vm.runInNewContext(
  '(' + between(sizesSource, 'export const MARKET_SIZES = ', ' as const;')
    .slice('export const MARKET_SIZES = '.length) + ')',
  {}, { timeout: 1000 },
);
const implementation = source.slice(source.indexOf('/** Runs the benchmark script inside'));
assert.ok(implementation.startsWith('/** Runs the benchmark script inside'));
assert.equal(implementation.match(/export const task =/g)?.length, 1);
const executable = stripTypeScriptTypes(
  timeoutSource.replaceAll('export ', '') + '\n' +
  declarations + '\n' + implementation.replaceAll('export const ', 'const ') +
  '\n;({ runCpuBenchmark, parseBenchOutput, benchOutputComplete, cpuPhaseSteps, task });',
);

class LocalTaskError extends Error {
  constructor(message, details) {
    super(message);
    Object.assign(this, details);
  }
}

export function loadCpu({ script = '#!/usr/bin/env bash\n# inert local fixture\n', supported = true } = {}) {
  const consoleMessages = [];
  const sandboxId = (sandbox) => sandbox.id;
  const context = vm.createContext({
    fs: {
      readFileSync(file, encoding) {
        assert.equal(file, '/local-fixture/cpu-benchmark.sh');
        assert.equal(encoding, 'utf8');
        return script;
      },
    },
    BENCH_SCRIPT_PATH: '/local-fixture/cpu-benchmark.sh',
    setTimeout,
    clearTimeout,
    console: { error: (...args) => consoleMessages.push(args.join(' ')) },
    formatError: (error) => String(error),
    sandboxId,
    defineTask: (task) => task,
    TaskError: LocalTaskError,
    getSandboxOptionsWithResources: () => supported ? {} : undefined,
    MARKET_SIZES: marketSizes,
    PROVIDER_SIZE_OPTIONS: {},
  });
  const functions = vm.runInContext(executable, context, { timeout: 1000 });
  return { ...functions, consoleMessages };
}

// Protocol-only output: these default numbers describe production byte totals;
// no hashing or sandbox creation occurs when this fixture is supplied.
export function output({
  singleMs = '100', multiMs = '200',
  singleBytes = String(4096 * 1048576), multiBytes = String(2 * 2048 * 1048576),
  nproc = '2', done = 'BENCH_DONE', omit = [], extra = '',
} = {}) {
  const records = [
    ['nproc', `BENCH_META\tlogical_cpus\t${nproc}`],
    ['singleMs', `BENCH_PHASE\tsingle\t${singleMs}`],
    ['multiMs', `BENCH_PHASE\tmulti\t${multiMs}`],
    ['singleBytes', `BENCH_BYTES\tsingle\t${singleBytes}`],
    ['multiBytes', `BENCH_BYTES\tmulti\t${multiBytes}`],
    ['done', done],
  ];
  return records.filter(([key]) => !omit.includes(key)).map(([, line]) => line).join('\n') + '\n' + extra;
}

export function fakeSandbox(responses) {
  const calls = [];
  let destroyed = 0;
  return {
    id: 'local-fixture-only',
    calls,
    get destroyed() { return destroyed; },
    async destroy() { destroyed++; },
    async runCommand(command, options) {
      calls.push({ command, options });
      assert.ok(calls.length <= responses.length, 'unexpected extra command/retry');
      const result = responses[calls.length - 1];
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(command, options) : result;
    },
  };
}

export function taskContext(sandbox) {
  const measurements = [];
  const logs = [];
  const stepNames = [];
  return {
    measurements, logs, stepNames,
    participant: { name: 'local-fixture', timeout: 1000, createCompute: () => ({
      sandbox: { create: async () => sandbox },
    }) },
    phase: 'small',
    log: (...args) => logs.push(args),
    measure: (metrics) => measurements.push(metrics),
    async step(name, callback) {
      stepNames.push(name);
      return callback();
    },
  };
}
