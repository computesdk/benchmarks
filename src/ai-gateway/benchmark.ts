import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';
import type {
  AIGatewayProviderConfig,
  AIGatewayScenario,
  AIGatewayTimingResult,
  AIGatewayBenchmarkResult,
} from './types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const SCENARIO_PROMPTS: Record<AIGatewayScenario, { prompt: string; maxTokens: number; stream: boolean }> = {
  'short-nonstream': {
    prompt: 'Reply with exactly: ok',
    maxTokens: 16,
    stream: false,
  },
  'short-stream': {
    prompt: 'Write one short sentence about distributed systems.',
    maxTokens: 64,
    stream: true,
  },
};

function extractCompletionTokens(payload: any): number {
  if (typeof payload?.usage?.completion_tokens === 'number') return payload.usage.completion_tokens;
  if (typeof payload?.usage?.output_tokens === 'number') return payload.usage.output_tokens;
  if (typeof payload?.completion_tokens === 'number') return payload.completion_tokens;
  return 0;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function buildCompletionBody(
  provider: AIGatewayProviderConfig,
  request: { prompt: string; maxTokens: number; stream: boolean },
) {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: [{ role: 'user', content: request.prompt }],
    temperature: 0,
    stream: request.stream,
    max_completion_tokens: request.maxTokens,
  };

  return body;
}

async function runNonStreamingIteration(
  provider: AIGatewayProviderConfig,
  timeout: number,
  scenario: AIGatewayScenario,
): Promise<AIGatewayTimingResult> {
  const request = SCENARIO_PROMPTS[scenario];
  const start = performance.now();

  try {
    const response = await withTimeout(fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
        ...provider.defaultHeaders,
      },
      body: JSON.stringify(buildCompletionBody(provider, { ...request, stream: false })),
    }), timeout, 'Gateway request timed out');

    const totalMs = performance.now() - start;
    const statusCode = response.status;
    const bodyText = await response.text();

    if (!response.ok) {
      return {
        firstTokenMs: 0,
        totalMs,
        outputTokens: 0,
        outputTokensPerSec: 0,
        statusCode,
        error: `HTTP ${statusCode}: ${bodyText.slice(0, 200)}`,
      };
    }

    const payload = JSON.parse(bodyText);
    const outputTokens = extractCompletionTokens(payload);
    const seconds = Math.max(totalMs / 1000, 0.001);

    return {
      firstTokenMs: totalMs,
      totalMs,
      outputTokens,
      outputTokensPerSec: outputTokens > 0 ? outputTokens / seconds : 0,
      statusCode,
    };
  } catch (err) {
    return {
      firstTokenMs: 0,
      totalMs: performance.now() - start,
      outputTokens: 0,
      outputTokensPerSec: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runStreamingIteration(
  provider: AIGatewayProviderConfig,
  timeout: number,
  scenario: AIGatewayScenario,
): Promise<AIGatewayTimingResult> {
  const request = SCENARIO_PROMPTS[scenario];
  const start = performance.now();

  try {
    const response = await withTimeout(fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
        ...provider.defaultHeaders,
      },
      body: JSON.stringify(buildCompletionBody(provider, { ...request, stream: true })),
    }), timeout, 'Gateway request timed out');

    const statusCode = response.status;
    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      return {
        firstTokenMs: 0,
        totalMs: performance.now() - start,
        outputTokens: 0,
        outputTokensPerSec: 0,
        statusCode,
        error: `HTTP ${statusCode}: ${errorText.slice(0, 200)}`,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let firstTokenMs = 0;
    let outputTokens = 0;
    let done = false;

    while (!done) {
      const readResult = await withTimeout(reader.read(), timeout, 'Stream read timed out');
      done = readResult.done;
      if (done) break;
      const chunk = decoder.decode(readResult.value, { stream: true });

      if (chunk.includes('data:') && firstTokenMs === 0) {
        firstTokenMs = performance.now() - start;
      }

      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
      for (const line of lines) {
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const payload = JSON.parse(data);
          const tokenText = payload?.choices?.[0]?.delta?.content;
          if (typeof tokenText === 'string' && tokenText.length > 0) {
            outputTokens += 1;
          }
        } catch {
          // Ignore malformed partial SSE chunks.
        }
      }
    }

    const totalMs = performance.now() - start;
    const effectiveStart = firstTokenMs > 0 ? firstTokenMs : totalMs;
    const generationSeconds = Math.max((totalMs - effectiveStart) / 1000, 0.001);

    return {
      firstTokenMs: effectiveStart,
      totalMs,
      outputTokens,
      outputTokensPerSec: outputTokens > 0 ? outputTokens / generationSeconds : 0,
      statusCode,
    };
  } catch (err) {
    return {
      firstTokenMs: 0,
      totalMs: performance.now() - start,
      outputTokens: 0,
      outputTokensPerSec: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runAIGatewayBenchmark(
  config: AIGatewayProviderConfig,
  scenario: AIGatewayScenario,
): Promise<AIGatewayBenchmarkResult> {
  const { name, requiredEnvVars, iterations = 100, timeout = 45_000 } = config;
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'ai-gateway',
      scenario,
      model: config.model || process.env.AI_GATEWAY_MODEL || '',
      iterations: [],
      summary: {
        firstTokenMs: { median: 0, p95: 0, p99: 0 },
        totalMs: { median: 0, p95: 0, p99: 0 },
        outputTokensPerSec: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const resolved: AIGatewayProviderConfig = {
    ...config,
    model: config.model || process.env.AI_GATEWAY_MODEL || '',
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || '',
  };

  const results: AIGatewayTimingResult[] = [];
  const isStreaming = SCENARIO_PROMPTS[scenario].stream;

  console.log(`\n--- AI Gateway Benchmarking: ${name} (${scenario}, ${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    const run = isStreaming ? runStreamingIteration : runNonStreamingIteration;
    const result = await run(resolved, timeout, scenario);
    results.push(result);

    const status = result.error ? `FAILED: ${result.error}` : `${(result.totalMs / 1000).toFixed(2)}s`;
    const first = result.firstTokenMs > 0 ? `${(result.firstTokenMs / 1000).toFixed(2)}s` : '--';
    console.log(`  Iteration ${i + 1}/${iterations}: total ${status}, first ${first}`);
  }

  const successful = results.filter(r => !r.error);
  return {
    provider: name,
    mode: 'ai-gateway',
    scenario,
    model: resolved.model,
    iterations: results,
    summary: {
      firstTokenMs: computeStats(successful.map(r => r.firstTokenMs).filter(v => v > 0)),
      totalMs: computeStats(successful.map(r => r.totalMs)),
      outputTokensPerSec: computeStats(successful.map(r => r.outputTokensPerSec)),
    },
  };
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeAIGatewayResultsJson(results: AIGatewayBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    scenario: r.scenario,
    model: r.model,
    iterations: r.iterations.map(i => ({
      firstTokenMs: round(i.firstTokenMs),
      totalMs: round(i.totalMs),
      outputTokens: i.outputTokens,
      outputTokensPerSec: round(i.outputTokensPerSec),
      ...(i.statusCode !== undefined ? { statusCode: i.statusCode } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      firstTokenMs: roundStats(r.summary.firstTokenMs),
      totalMs: roundStats(r.summary.totalMs),
      outputTokensPerSec: roundStats(r.summary.outputTokensPerSec),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 45000,
      scenario: results[0]?.scenario || null,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
