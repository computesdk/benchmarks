/**
 * Sandbox agent benchmark. Measures the real-workload path of an agentic
 * coding loop — process spawn, filesystem writes, exec — with zero model
 * latency/cost/variance by running OpenCode inside the sandbox against a
 * MOCKED model: `mock-ai-provider` (a local OpenAI-compatible server) replaying
 * a canned deterministic script of chat-completion responses that drive real
 * tool calls (mkdir, write package.json, write index.js, run it, done).
 *
 * Unit of work: create sandbox → install OpenCode → write + start the mock
 * server → `opencode run` with a fixed prompt pointed at the mock → verify the
 * scripted file/command effects actually happened → destroy. Declarative —
 * exports `config` + `task`; `bench run` owns the entrypoint.
 *
 *   bench run benchmarks/sandbox/agent.bench.ts --iterations 3 --provider tensorlake
 *
 * To rank providers against each other, run each provider with the same
 * `--run-key`: they get-or-create one shared run and each claims its own worker.
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import type { SandboxInterface } from 'computesdk';

const CREATE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;
const MOCK_START_TIMEOUT_MS = 60_000;
const AGENT_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 15_000;
const DESTROY_TIMEOUT_MS = 30_000;

const MOCK_VERSION = '0.1.2';
const MOCK_PORT = 8401;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
const MOCK_JOURNAL = '/tmp/mock-requests.jsonl';
const WORK_DIR = '/tmp/agent-work';
const PROJ_DIR = '/tmp/proj';
const EXPECTED_OUTPUT = 'bench-agent-ok';

function preview(text: string | null | undefined, max = 2000): string | null {
  if (!text) return null;
  return text.length <= max ? text : text.slice(0, max) + '...';
}

/**
 * The canned tool-call script the mock replays, matched by request index:
 * one tool call per model response (mkdir, write package.json, write
 * index.js, run it), then a final text response that ends the agent loop.
 * `--title bench` on `opencode run` suppresses OpenCode's title-generation
 * request, which would otherwise consume requestIndex 0. Every tool call is
 * real work the sandbox executes — `verify` asserts the filesystem effects.
 */
const MOCK_SCRIPT = {
  id: 'agent-flow',
  steps: [
    { match: { apiSurface: 'chat.completions', requestIndex: 0 }, respond: { type: 'tool-calls', toolCalls: [{ name: 'bash', arguments: JSON.stringify({ command: `mkdir -p ${PROJ_DIR}` }) }] } },
    { match: { apiSurface: 'chat.completions', requestIndex: 1 }, respond: { type: 'tool-calls', toolCalls: [{ name: 'write', arguments: JSON.stringify({ filePath: `${PROJ_DIR}/package.json`, content: '{"name":"bench-proj","type":"module"}\n' }) }] } },
    { match: { apiSurface: 'chat.completions', requestIndex: 2 }, respond: { type: 'tool-calls', toolCalls: [{ name: 'write', arguments: JSON.stringify({ filePath: `${PROJ_DIR}/index.js`, content: `console.log('${EXPECTED_OUTPUT}')\n` }) }] } },
    { match: { apiSurface: 'chat.completions', requestIndex: 3 }, respond: { type: 'tool-calls', toolCalls: [{ name: 'bash', arguments: JSON.stringify({ command: `node ${PROJ_DIR}/index.js > ${PROJ_DIR}/run.log 2>&1` }) }] } },
    { match: { apiSurface: 'chat.completions' }, respond: { type: 'final-text', text: 'Done.' } },
  ],
};

const OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  model: 'mock/mock-model',
  provider: {
    mock: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Mock',
      options: { baseURL: MOCK_BASE_URL, apiKey: 'mock-key' },
      models: { 'mock-model': { name: 'Mock Model', tool_call: true } },
    },
  },
  permission: { '*': 'allow' },
};

const AGENT_PROMPT = 'Scaffold the project and run it.';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-agent',
  benchmarkName: 'Sandbox Agent (Mocked Model)',
  iterations: 3,
  concurrency: 1,
  participants: providers,
  display: {
    metrics: [
      { key: 'agentRunMs', label: 'Agent run', unit: 'ms', direction: 'lower-better' as const, decimals: 0 },
      { key: 'toolCalls', label: 'Tool calls', decimals: 0 },
      { key: 'mockRequests', label: 'Model requests', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'install', label: 'Install OpenCode' },
      { key: 'mock.start', label: 'Start mock model' },
      { key: 'agent.run', label: 'Run OpenCode agent' },
      { key: 'verify', label: 'Verify tool effects' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    overview: { defaultMetric: 'compositeScore', defaultLayout: 'ranking' },
  },
  scoring: {
    metrics: [
      { key: 'agentRunMs', unit: 'ms', ceiling: 60_000, weights: { median: 0.60, p95: 0.25, p99: 0.15 } },
    ],
  },
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;
  const compute = participant.createCompute();

  let sandbox: SandboxInterface | undefined;
  let agentRunMs: number | undefined;
  let toolCalls: number | undefined;
  let mockRequests: number | undefined;

  try {
    sandbox = await step('create', async () => {
      let timedOut = false;
      const pending = Promise.resolve(
        compute.sandbox.create({ ...participant.sandboxOptions, timeout: 600_000 }),
      ) as Promise<SandboxInterface>;
      // A timed-out create may still resolve later — destroy that sandbox so it
      // isn't leaked.
      void pending
        .then((late) => {
          if (timedOut) {
            return late.destroy().catch((err: unknown) =>
              log('destroyed sandbox that resolved after create timeout', { level: 'warn', meta: { error: formatError(err) } }),
            );
          }
          return undefined;
        })
        .catch(() => {});
      try {
        return await withTimeout(pending, participant.timeout ?? CREATE_TIMEOUT_MS, 'Sandbox creation timed out');
      } catch (err) {
        timedOut = true;
        throw err;
      }
    });
    if (sandbox === undefined) {
      throw new Error('create step did not return a sandbox');
    }
    const s = sandbox;

    await step('install', async () => {
      const result = await s.runCommand(
        'curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && HOME=/tmp/opencode-home bash /tmp/opencode-install.sh --no-modify-path',
        { timeout: INSTALL_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        log('OpenCode install failed', { level: 'error', meta: { exitCode: result.exitCode, stderr: preview(result.stderr) } });
        throw new TaskError(`OpenCode install failed (exit ${result.exitCode})`);
      }
      log('OpenCode install succeeded', { level: 'info' });
    });

    await step('mock.start', async () => {
      const cmd = `cat > /tmp/mock-script.json <<'__MOCK_EOF__'\n${JSON.stringify(MOCK_SCRIPT, null, 2)}\n__MOCK_EOF__\n` +
        `mkdir -p ${WORK_DIR}\n` +
        `cat > ${WORK_DIR}/opencode.json <<'__CFG_EOF__'\n${JSON.stringify(OPENCODE_CONFIG, null, 2)}\n__CFG_EOF__\n` +
        `cd ${WORK_DIR} && nohup npx -y mock-ai-provider@${MOCK_VERSION} serve --providers openai --script /tmp/mock-script.json --port ${MOCK_PORT} --request-log ${MOCK_JOURNAL} > /tmp/mock-server.log 2>&1 &\n` +
        `for i in $(seq 1 100); do curl -sf http://127.0.0.1:${MOCK_PORT}/health > /dev/null && echo MOCK_READY && exit 0; sleep 0.3; done\n` +
        `echo MOCK_FAILED; cat /tmp/mock-server.log; exit 1`;
      const result = await s.runCommand(cmd, { timeout: MOCK_START_TIMEOUT_MS });
      if (result.exitCode !== 0 || !result.stdout.includes('MOCK_READY')) {
        log('mock server failed to start', { level: 'error', meta: { exitCode: result.exitCode, stdout: preview(result.stdout), stderr: preview(result.stderr) } });
        throw new TaskError(`Mock server failed to start (exit ${result.exitCode})`);
      }
      log('mock server ready', { level: 'info', meta: { port: MOCK_PORT } });
    });

    agentRunMs = await step('agent.run', async () => {
      const t0 = performance.now();
      const result = await s.runCommand(
        `cd ${WORK_DIR} && export HOME=/tmp/opencode-home && export PATH="/tmp/opencode-home/.opencode/bin:$PATH" && opencode run --title bench --model mock/mock-model '${AGENT_PROMPT}'`,
        { timeout: AGENT_TIMEOUT_MS },
      );
      const elapsed = performance.now() - t0;
      measure({ agentRunMs: elapsed });
      if (result.exitCode !== 0) {
        log('OpenCode run failed', { level: 'error', meta: { exitCode: result.exitCode, stdout: preview(result.stdout), stderr: preview(result.stderr) } });
        throw new TaskError(`OpenCode run failed (exit ${result.exitCode})`);
      }
      log('OpenCode run completed', { level: 'info', meta: { agentRunMs: Math.round(elapsed), stdout: preview(result.stdout, 1000) } });
      return elapsed;
    });

    await step('verify', async () => {
      const result = await s.runCommand(
        `test -f ${PROJ_DIR}/index.js && grep -q '"bench-proj"' ${PROJ_DIR}/package.json && cat ${PROJ_DIR}/run.log` +
          ` && echo REQS=$(wc -l < ${MOCK_JOURNAL}) && echo TOOLCALLS=$(grep -cE '"toolCallsEmitted":[1-9]' ${MOCK_JOURNAL})`,
        { timeout: VERIFY_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        log('verify failed', { level: 'error', meta: { exitCode: result.exitCode, stdout: preview(result.stdout), stderr: preview(result.stderr) } });
        throw new TaskError(`Verification failed (exit ${result.exitCode})`);
      }
      const stdout = result.stdout;
      if (!stdout.includes(EXPECTED_OUTPUT)) {
        log('verify: expected output missing', { level: 'error', meta: { stdout: preview(stdout) } });
        throw new TaskError(`run.log did not include "${EXPECTED_OUTPUT}"`);
      }
      mockRequests = Number(stdout.match(/REQS=(\d+)/)?.[1]);
      toolCalls = Number(stdout.match(/TOOLCALLS=(\d+)/)?.[1]);
      if (toolCalls !== MOCK_SCRIPT.steps.length - 1) {
        log('verify: unexpected tool call count', { level: 'warn', meta: { toolCalls, expected: MOCK_SCRIPT.steps.length - 1 } });
      }
      measure({ toolCalls, mockRequests });
      log('verification passed', { level: 'info', meta: { toolCalls, mockRequests } });
    });

    if (agentRunMs === undefined) {
      throw new Error('agent.run did not produce an agentRunMs measurement');
    }
    const data = { agentRunMs, toolCalls: toolCalls ?? -1, mockRequests: mockRequests ?? -1 };
    measure(data);
    return { data };
  } finally {
    if (sandbox) {
      await step('destroy', () =>
        withTimeout(sandbox!.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timeout'),
        { reportConcurrency: false },
      ).catch((err: unknown) => log('destroy failed', { level: 'warn', meta: { error: formatError(err) } }));
      log('sandbox', { level: 'info', meta: { provider: participant.name, sandboxId: sandboxId(sandbox) } });
    }
  }
});
