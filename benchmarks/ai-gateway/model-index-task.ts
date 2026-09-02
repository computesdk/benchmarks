import https from 'node:https';
import type { TaskContext, TaskResult } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/api';
import type {
  AIGatewayModelIndexEntry,
  AIGatewayModelIndexProviderConfig,
  AIGatewayModelIndexProviderResult,
  AIGatewayModelListFormat,
  AIGatewayModelPricing,
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

function extractOwnedBy(model: AnyModel): string | undefined {
  if (typeof model.owned_by === 'string') return model.owned_by;

  const id = model.id;
  if (typeof id === 'string') {
    const fromId = providerFromId(id);
    if (fromId && fromId.length > 0) return fromId[0];
  }

  return undefined;
}

function extractProviders(model: AnyModel): string[] | undefined {
  const rawProviders = model.providers;
  if (Array.isArray(rawProviders) && rawProviders.length > 0) {
    const providers = rawProviders
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
    if (providers.length > 0) return providers;
  }

  return undefined;
}

function asPricing(value: unknown): AIGatewayModelPricing | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as AnyModel;
  return Object.keys(obj).length > 0 ? (obj as AIGatewayModelPricing) : undefined;
}

function providerPricing(model: AnyModel): AIGatewayModelPricing | undefined {
  const rawProviders = model.providers;
  if (!Array.isArray(rawProviders)) return undefined;

  for (const raw of rawProviders) {
    if (!raw || typeof raw !== 'object') continue;
    const provider = raw as AnyModel;
    const pricing = asPricing(provider.pricing) ?? asPricing(provider.cost);
    if (pricing) return pricing;
  }
  return undefined;
}

function extractPricing(model: AnyModel): AIGatewayModelPricing | undefined {
  return asPricing(model.pricing) ?? asPricing(model.cost) ?? providerPricing(model);
}

function extractContextLength(model: AnyModel): number | undefined {
  const candidates = [model.context_length, model.context_window, model.contextLength, model.max_context];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

function providerOutputLimits(model: AnyModel): number[] {
  const rawProviders = model.providers;
  if (!Array.isArray(rawProviders)) return [];

  const limits: number[] = [];
  for (const p of rawProviders) {
    if (!p || typeof p !== 'object') continue;
    const provider = p as AnyModel;
    const candidates = [
      provider.max_output,
      provider.max_output_tokens,
      provider.maxOutputTokens,
      provider.max_tokens,
      provider.max_completion_tokens,
    ];
    for (const v of candidates) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        limits.push(v);
        break;
      }
    }
  }
  return limits;
}

function extractMaxOutputTokens(model: AnyModel): number | undefined {
  const topProvider = asModel(model.top_provider);
  const providerLimits = providerOutputLimits(model);
  const maxProviderLimit = providerLimits.length > 0 ? Math.max(...providerLimits) : undefined;

  const candidates = [
    model.max_completion_tokens,
    model.max_tokens,
    model.maxOutputTokens,
    model.max_output_tokens,
    topProvider?.max_completion_tokens,
    topProvider?.max_tokens,
    topProvider?.maxOutputTokens,
    topProvider?.max_output_tokens,
    maxProviderLimit,
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
  const ownedBy = extractOwnedBy(model);

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
    pricing: extractPricing(model),
  };
}

function normalizePydanticModel(
  routeName: string | undefined,
  provider: string | undefined,
  model: AnyModel,
): AIGatewayModelIndexEntry | undefined {
  const id = model.id;
  if (typeof id !== 'string' || !id) return undefined;

  const name = typeof model.name === 'string' ? model.name : undefined;

  return {
    id,
    name,
    displayName: name ?? id,
    ownedBy: provider,
    providers: routeName ? [routeName] : undefined,
    contextLength: extractContextLength(model),
    maxOutputTokens: extractMaxOutputTokens(model),
    createdAt: normalizeTimestamp(model.created ?? model.created_at ?? model.release_date),
    pricing: extractPricing(model),
  };
}

function normalizePydanticRoutes(routes: unknown[]): AIGatewayModelIndexEntry[] {
  const byId = new Map<
    string,
    AIGatewayModelIndexEntry & { _providers: Set<string> }
  >();

  for (const raw of routes) {
    const route = asModel(raw);
    if (!route) continue;

    const routeName = typeof route.route === 'string'
      ? route.route
      : typeof route.provider === 'string'
        ? route.provider
        : undefined;
    const provider = typeof route.provider === 'string' ? route.provider : routeName;

    const chatModels = Array.isArray(route.models) ? route.models : [];
    const embeddingModels = Array.isArray(route.embedding_models) ? route.embedding_models : [];

    for (const rawModel of [...chatModels, ...embeddingModels]) {
      const model = asModel(rawModel);
      if (!model) continue;
      const entry = normalizePydanticModel(routeName, provider, model);
      if (!entry) continue;

      const existing = byId.get(entry.id);
      if (!existing) {
        byId.set(entry.id, { ...entry, _providers: new Set(entry.providers ?? []) });
        continue;
      }

      // Merge route options; for other metadata keep the first non-undefined
      // value so the result is deterministic across routes.
      for (const p of entry.providers ?? []) existing._providers.add(p);
      existing.ownedBy ??= entry.ownedBy;
      existing.name ??= entry.name;
      existing.displayName ??= entry.displayName;
      existing.contextLength ??= entry.contextLength;
      existing.maxOutputTokens ??= entry.maxOutputTokens;
      existing.createdAt ??= entry.createdAt;
      existing.pricing ??= entry.pricing;
    }
  }

  return Array.from(byId.values()).map(({ _providers, ...entry }) => ({
    ...entry,
    providers: _providers.size > 0 ? Array.from(_providers) : undefined,
  }));
}

function normalizeModels(
  format: AIGatewayModelListFormat,
  body: unknown,
): AIGatewayModelIndexEntry[] {
  if (format === 'pydantic' && Array.isArray(body)) {
    return normalizePydanticRoutes(body);
  }

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
    let settled = false;

    function settle(result: FetchResult) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

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

        res.on('error', (err) => {
          settle({ statusCode: res.statusCode, responseMs: Date.now() - startedAt, error: err.message });
        });

        res.on('aborted', () => {
          settle({ statusCode: res.statusCode, responseMs: Date.now() - startedAt, error: 'Response aborted' });
        });

        res.on('end', () => {
          const responseMs = Date.now() - startedAt;
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            settle({ statusCode: res.statusCode, responseMs, error: `HTTP ${res.statusCode}: ${body.slice(0, 500)}` });
            return;
          }

          const parsed = parseJson(body);
          if (parsed === undefined) {
            settle({ statusCode: res.statusCode, responseMs, error: 'Invalid JSON response' });
            return;
          }

          const isPydantic = config.modelListFormat === 'pydantic';
          const data = isPydantic ? parsed : (parsed as AnyModel).data;
          if (!Array.isArray(data)) {
            settle({ statusCode: res.statusCode, responseMs, error: 'Response did not contain a model list' });
            return;
          }

          settle({ statusCode: res.statusCode, body: parsed, responseMs });
        });
      },
    );

    req.on('error', (err) => {
      settle({ responseMs: Date.now() - startedAt, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      settle({ responseMs: Date.now() - startedAt, error: 'Request timed out' });
    });

    req.on('close', () => {
      if (!settled) {
        settle({ responseMs: Date.now() - startedAt, error: 'Request closed unexpectedly' });
      }
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
