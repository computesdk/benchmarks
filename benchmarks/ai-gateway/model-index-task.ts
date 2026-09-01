import https from 'node:https';
import type { TaskContext, TaskResult } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/api';
import type {
  AIGatewayModelIndexEntry,
  AIGatewayModelIndexProviderConfig,
  AIGatewayModelIndexProviderResult,
  AIGatewayModelListFormat,
} from './types.js';

const REQUEST_TIMEOUT_MS = 30_000;

type AnyModel = Record<string, unknown>;

function asModel(value: unknown): AnyModel | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyModel) : undefined;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1_000_000_000) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function providerFromId(id: string): string[] | undefined {
  const slash = id.indexOf('/');
  if (slash > 0) return [id.slice(0, slash)];
  return undefined;
}

function extractProviders(model: AnyModel): string[] | undefined {
  const rawProviders = model.providers;
  if (Array.isArray(rawProviders) && rawProviders.length > 0) {
    return rawProviders
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const provider =
            (p as AnyModel).providerId ??
            (p as AnyModel).provider ??
            (p as AnyModel).id ??
            (p as AnyModel).name;
          if (typeof provider === 'string') return provider;
        }
        return undefined;
      })
      .filter((p): p is string => typeof p === 'string');
  }

  const topProvider =
    (model.top_provider as AnyModel | undefined)?.provider ??
    (model.top_provider as AnyModel | undefined)?.provider_name;
  if (typeof topProvider === 'string') return [topProvider];

  const ownedBy = model.owned_by;
  if (typeof ownedBy === 'string') return [ownedBy];

  const id = model.id;
  if (typeof id === 'string') return providerFromId(id);

  return undefined;
}

function extractContextLength(model: AnyModel): number | undefined {
  const candidates = [model.context_length, model.context_window, model.contextLength, model.max_context];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

function extractMaxOutputTokens(model: AnyModel): number | undefined {
  const candidates = [
    model.max_completion_tokens,
    model.max_tokens,
    model.maxOutputTokens,
    model.max_output_tokens,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

function normalizeModel(model: AnyModel): AIGatewayModelIndexEntry | undefined {
  const id = model.id;
  if (typeof id !== 'string' || !id) return undefined;

  const providers = extractProviders(model);
  const ownedBy =
    typeof model.owned_by === 'string' ? model.owned_by : providers?.[0];

  return {
    id,
    name: typeof model.name === 'string' ? model.name : undefined,
    displayName:
      typeof model.display_name === 'string' ? model.display_name : undefined,
    ownedBy,
    providers,
    contextLength: extractContextLength(model),
    maxOutputTokens: extractMaxOutputTokens(model),
    createdAt: normalizeTimestamp(model.created ?? model.created_at ?? model.release_date),
  };
}

function normalizeModels(
  format: AIGatewayModelListFormat,
  body: unknown,
): AIGatewayModelIndexEntry[] {
  const data = (body as AnyModel)?.data;
  if (!Array.isArray(data)) return [];

  if (format === 'anthropic') {
    return data
      .map(asModel)
      .filter((m): m is AnyModel => !!m)
      .map((m) => ({
        id: String(m.id ?? ''),
        displayName: typeof m.display_name === 'string' ? m.display_name : undefined,
        ownedBy: 'anthropic',
        providers: ['anthropic'],
        createdAt: typeof m.created_at === 'string' ? m.created_at : undefined,
      }))
      .filter((m) => m.id);
  }

  return data
    .map(asModel)
    .filter((m): m is AnyModel => !!m)
    .map(normalizeModel)
    .filter((m): m is AIGatewayModelIndexEntry => !!m);
}

interface FetchResult {
  statusCode?: number;
  body?: unknown;
  responseMs: number;
  error?: string;
}

function fetchModelList(config: AIGatewayModelIndexProviderConfig): Promise<FetchResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = https.request(
      {
        method: 'GET',
        hostname: config.host,
        path: config.modelsPath,
        headers: {
          Accept: 'application/json',
          ...config.buildHeaders(),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const responseMs = Date.now() - startedAt;
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const parsed = parseJson(body);
            resolve({ statusCode: res.statusCode, body: parsed, responseMs });
          } else {
            resolve({
              statusCode: res.statusCode,
              responseMs,
              error: `HTTP ${res.statusCode}: ${body.slice(0, 500)}`,
            });
          }
        });
      },
    );

    req.on('error', (err) => {
      resolve({ responseMs: Date.now() - startedAt, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ responseMs: Date.now() - startedAt, error: 'Request timed out' });
    });

    req.end();
  });
}

export async function runModelIndexTask(
  ctx: TaskContext<AIGatewayModelIndexProviderConfig>,
): Promise<TaskResult> {
  const config = ctx.participant;
  const startedAt = Date.now();

  const { statusCode, body, responseMs, error } = await fetchModelList(config);

  if (error) {
    const result: AIGatewayModelIndexProviderResult = {
      provider: config.name,
      statusCode,
      responseMs,
      modelCount: 0,
      models: [],
      error,
    };
    return { data: result as unknown as JsonObject, latencyMs: responseMs };
  }

  const models = normalizeModels(config.modelListFormat, body);
  const result: AIGatewayModelIndexProviderResult = {
    provider: config.name,
    statusCode,
    responseMs,
    modelCount: models.length,
    models,
  };

  ctx.log(`${config.name}: listed ${models.length} models (${responseMs}ms)`);
  return { data: result as unknown as JsonObject, latencyMs: responseMs };
}
