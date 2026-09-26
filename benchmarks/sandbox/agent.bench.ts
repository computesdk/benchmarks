/**
 * Sandbox agent benchmark. Measures the real-workload path of an agentic
 * coding loop — process spawn, filesystem writes, exec — with zero model
 * latency/cost/variance by running OpenCode inside the sandbox against a
 * MOCKED model: a tiny OpenAI-compatible server on localhost that replays a
 * canned deterministic sequence of chat-completion responses driving real
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
const MOCK_START_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 15_000;
const DESTROY_TIMEOUT_MS = 30_000;

const MOCK_PORT = 8401;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
const WORK_DIR = '/tmp/agent-work';
const PROJ_DIR = '/tmp/proj';
const EXPECTED_OUTPUT = 'bench-agent-ok';

function preview(text: string | null | undefined, max = 2000): string | null {
  if (!text) return null;
  return text.length <= max ? text : text.slice(0, max) + '...';
}

/**
 * The canned tool-call script the mock replays. Each entry is one assistant
 * response containing a single tool call; the last entry is a plain text
 * response that ends the agent loop. Every command is real work the sandbox
 * must execute — verification asserts on the filesystem effects.
 */
const SCRIPT: { name: string; arguments: Record<string, string> }[] = [
  { name: 'bash', arguments: { command: `mkdir -p ${PROJ_DIR}` } },
  { name: 'write', arguments: { filePath: `${PROJ_DIR}/package.json`, content: '{"name":"bench-proj","type":"module"}\n' } },
  { name: 'write', arguments: { filePath: `${PROJ_DIR}/index.js`, content: `console.log('${EXPECTED_OUTPUT}')\n` } },
  { name: 'bash', arguments: { command: `node ${PROJ_DIR}/index.js > ${PROJ_DIR}/run.log 2>&1` } },
];

/**
 * Minimal OpenAI-compatible chat server (no deps — node:http). Replays SCRIPT
 * in order: request i returns a `tool_calls` response for SCRIPT[i], and the
 * (SCRIPT.length+1)-th request returns a final text message. Supports both
 * plain JSON and `stream: true` (SSE chunks), since the AI SDK OpenAI-
 * compatible provider OpenCode uses streams by default. GET /v1/models and
 * GET /stats are implemented for provider probing and verification.
 *
 * Written into the sandbox via heredoc — keep it free of `${` and backticks.
 */
const MOCK_SERVER_JS = `
var http = require('node:http');
var SCRIPT = ${JSON.stringify(SCRIPT)};
var requests = 0;
var toolCalls = 0;

function completion(i) {
  var msg;
  var finish;
  if (i < SCRIPT.length) {
    toolCalls += 1;
    msg = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_' + i,
        type: 'function',
        function: { name: SCRIPT[i].name, arguments: JSON.stringify(SCRIPT[i].arguments) },
      }],
    };
    finish = 'tool_calls';
  } else {
    msg = { role: 'assistant', content: 'Done.' };
    finish = 'stop';
  }
  return {
    id: 'chatcmpl-mock-' + i,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 },
  };
}

function sendStreamed(res, i) {
  var body = completion(i);
  var choice = body.choices[0];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  function chunk(delta, finishReason) {
    return 'data: ' + JSON.stringify({
      id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model,
      choices: [{ index: 0, delta: delta, finish_reason: finishReason }],
    }) + '\\n\\n';
  }
  res.write(chunk({ role: 'assistant', content: choice.message.content === null ? null : choice.message.content, tool_calls: choice.message.tool_calls }, null));
  res.write(chunk({}, choice.finish_reason));
  res.write('data: [DONE]\\n\\n');
  res.end();
}

var server = http.createServer(function (req, res) {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requests: requests, toolCalls: toolCalls }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      var parsed = {};
      try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
      var i = requests;
      requests += 1;
      if (parsed.stream) sendStreamed(res, i);
      else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion(i)));
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found: ' + req.method + ' ' + req.url } }));
});
server.listen(${MOCK_PORT}, '127.0.0.1', function () {
  console.log('mock listening on ${MOCK_PORT}');
});
`;

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
      const heredoc = `cat > /tmp/mock-server.js <<'__MOCK_EOF__'\n${MOCK_SERVER_JS}\n__MOCK_EOF__\n` +
        `mkdir -p ${WORK_DIR}\n` +
        `cat > ${WORK_DIR}/opencode.json <<'__CFG_EOF__'\n${JSON.stringify(OPENCODE_CONFIG, null, 2)}\n__CFG_EOF__\n` +
        `nohup node /tmp/mock-server.js > /tmp/mock-server.log 2>&1 &\n` +
        `for i in $(seq 1 50); do curl -sf ${MOCK_BASE_URL}/models > /dev/null && echo MOCK_READY && exit 0; sleep 0.2; done\n` +
        `echo MOCK_FAILED; cat /tmp/mock-server.log; exit 1`;
      const result = await s.runCommand(heredoc, { timeout: MOCK_START_TIMEOUT_MS });
      if (result.exitCode !== 0 || !result.stdout.includes('MOCK_READY')) {
        log('mock server failed to start', { level: 'error', meta: { exitCode: result.exitCode, stdout: preview(result.stdout), stderr: preview(result.stderr) } });
        throw new TaskError(`Mock server failed to start (exit ${result.exitCode})`);
      }
      log('mock server ready', { level: 'info', meta: { port: MOCK_PORT } });
    });

    agentRunMs = await step('agent.run', async () => {
      const t0 = performance.now();
      const result = await s.runCommand(
        `cd ${WORK_DIR} && export HOME=/tmp/opencode-home && export PATH="/tmp/opencode-home/.opencode/bin:$PATH" && opencode run --model mock/mock-model '${AGENT_PROMPT}'`,
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
        `test -f ${PROJ_DIR}/index.js && grep -q '"bench-proj"' ${PROJ_DIR}/package.json && cat ${PROJ_DIR}/run.log && echo --- && curl -sf http://127.0.0.1:${MOCK_PORT}/stats`,
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
      const statsLine = stdout.split('---').pop()?.trim() ?? '';
      try {
        const stats = JSON.parse(statsLine) as { requests?: number; toolCalls?: number };
        mockRequests = stats.requests;
        toolCalls = stats.toolCalls;
      } catch {
        log('verify: could not parse mock stats', { level: 'warn', meta: { statsLine: preview(statsLine) } });
      }
      if (toolCalls !== SCRIPT.length) {
        log('verify: unexpected tool call count', { level: 'warn', meta: { toolCalls: toolCalls ?? -1, expected: SCRIPT.length } });
      }
      measure({ toolCalls: toolCalls ?? -1, mockRequests: mockRequests ?? -1 });
      log('verification passed', { level: 'info', meta: { toolCalls: toolCalls ?? -1, mockRequests: mockRequests ?? -1 } });
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
