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

function providerNameFromProviderObject(p: AnyModel): string | undefined {
  const name = p.providerId ?? p.provider ?? p.id ?? p.name;
  return typeof name === 'string' ? name : undefined;
}

function extractProviders(model: AnyModel): string[] | undefined {
  const rawProviders = model.providers;
  if (Array.isArray(rawProviders) && rawProviders.length > 0) {
    const providers = rawProviders
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          return providerNameFromProviderObject(p as AnyModel);
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

const flatPricingKeys = [
  'input_cost',
  'output_cost',
  'input_cost_per_token',
  'output_cost_per_token',
  'cost_input',
  'cost_output',
  'price_input',
  'price_output',
  'token_cost',
  'per_token',
];

function extractPricingFromObject(model: AnyModel): AIGatewayModelPricing | undefined {
  const router = asModel(model.router);
  const pricing = {
    ...(asPricing(model.pricing) ?? {}),
    ...(asPricing(router?.pricing) ?? {}),
  };
  const cost = asPricing(model.cost);
  const flat = Object.fromEntries(
    flatPricingKeys
      .filter((key) => model[key] !== undefined)
      .map((key) => [key, model[key]]),
  );
  const result = {
    ...pricing,
    ...(cost ? { cost } : {}),
    ...flat,
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractProviderPricing(model: AnyModel): Record<string, AIGatewayModelPricing> | undefined {
  const rawProviders = model.providers;
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) return undefined;

  const providerPricing: Record<string, AIGatewayModelPricing> = {};
  let hasAny = false;
  for (const raw of rawProviders) {
    if (!raw || typeof raw !== 'object') continue;
    const provider = raw as AnyModel;
    const providerId = providerNameFromProviderObject(provider);
    const pricing = extractPricingFromObject(provider);
    if (providerId && pricing) {
      providerPricing[providerId] = pricing;
      hasAny = true;
    }
  }
  return hasAny ? providerPricing : undefined;
}

function extractPricing(model: AnyModel): AIGatewayModelPricing | undefined {
  return extractPricingFromObject(model);
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
    providerPricing: extractProviderPricing(model),
  };
}

function normalizePydanticModel(
  routeName: string | undefined,
  provider: string | undefined,
  model: AnyModel,
  providerPricing?: Record<string, AIGatewayModelPricing>,
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
    providerPricing,
  };
}

function normalizePydanticRoutes(routes: unknown[]): AIGatewayModelIndexEntry[] {
  const byId = new Map<
    string,
    AIGatewayModelIndexEntry & { _providers: Set<string>; _providerPricing: Record<string, AIGatewayModelPricing> }
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
    const routePricing = extractPricing(route);
    const providerPricing = provider && routePricing ? { [provider]: routePricing } : undefined;

    const chatModels = Array.isArray(route.models) ? route.models : [];
    const embeddingModels = Array.isArray(route.embedding_models) ? route.embedding_models : [];

    for (const rawModel of [...chatModels, ...embeddingModels]) {
      const model = asModel(rawModel);
      if (!model) continue;
      const entry = normalizePydanticModel(routeName, provider, model, providerPricing);
      if (!entry) continue;

      const existing = byId.get(entry.id);
      if (!existing) {
        byId.set(entry.id, { ...entry, _providers: new Set(entry.providers ?? []), _providerPricing: { ...(entry.providerPricing ?? {}) } });
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
      for (const [providerId, pricing] of Object.entries(entry.providerPricing ?? {})) {
        existing._providerPricing[providerId] ??= pricing;
      }
    }
  }

  return Array.from(byId.values()).map(({ _providers, _providerPricing, ...entry }) => ({
    ...entry,
    providers: _providers.size > 0 ? Array.from(_providers) : undefined,
    providerPricing: Object.keys(_providerPricing).length > 0 ? _providerPricing : undefined,
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

function fetchJson(
  host: string,
  requestPath: string,
  headers: Record<string, string>,
): Promise<FetchResult> {
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
        hostname: host,
        path: requestPath,
        headers: { Accept: 'application/json', ...headers },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
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
          settle(parsed === undefined
            ? { statusCode: res.statusCode, responseMs, error: 'Invalid JSON response' }
            : { statusCode: res.statusCode, body: parsed, responseMs });
        });
      },
    );

    req.on('error', (err) => settle({ responseMs: Date.now() - startedAt, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      settle({ responseMs: Date.now() - startedAt, error: 'Request timed out' });
    });
    req.on('close', () => {
      if (!settled) settle({ responseMs: Date.now() - startedAt, error: 'Request closed unexpectedly' });
    });
    req.end();
  });
}

function fetchModelList(config: AIGatewayModelIndexProviderConfig): Promise<FetchResult> {
  return fetchJson(config.host, config.modelsPath, config.buildHeaders()).then((result) => {
    if (result.error || result.body === undefined) return result;
    const data = config.modelListFormat === 'pydantic' ? result.body : (result.body as AnyModel).data;
    return Array.isArray(data) ? result : { ...result, error: 'Response did not contain a model list' };
  });
}

const PRICING_REQUEST_CONCURRENCY = 8;

function priceUsd(value: unknown): unknown {
  return asModel(asModel(value)?.price)?.USD;
}

function extractConcentratePricing(value: unknown): AIGatewayModelPricing | undefined {
  const pricing = asModel(value);
  if (!pricing) return undefined;

  const result: AnyModel = { ...pricing };
  const tokens = asModel(pricing.tokens);
  const cache = asModel(tokens?.cache);
  const cacheWrite = asModel(cache?.write);
  const tokenPricing: Record<string, unknown> = {
    input: priceUsd(tokens?.input),
    output: priceUsd(tokens?.output),
    cache_read: priceUsd(cache?.read),
    cache_write_5m: priceUsd(cacheWrite?.ephemeral_5m_input_tokens),
    cache_write_1h: priceUsd(cacheWrite?.ephemeral_1h_input_tokens),
  };

  for (const [key, price] of Object.entries(tokenPricing)) {
    if (price !== undefined) result[key] = price;
  }
  return result as AIGatewayModelPricing;
}

function enrichConcentrateModel(
  model: AIGatewayModelIndexEntry,
  body: unknown,
): AIGatewayModelIndexEntry {
  const providers = asModel(asModel(body)?.providers);
  if (!providers) return model;

  const providerPricing = Object.fromEntries(
    Object.entries(providers)
      .map(([provider, value]) => [provider, extractConcentratePricing(asModel(value)?.pricing)])
      .filter((entry): entry is [string, AIGatewayModelPricing] => !!entry[1]),
  );
  const firstPricing = Object.values(providerPricing)[0];
  return {
    ...model,
    pricing: firstPricing ?? model.pricing,
    providerPricing: Object.keys(providerPricing).length > 0 ? providerPricing : model.providerPricing,
  };
}

function enrichNeonModel(
  model: AIGatewayModelIndexEntry,
  catalog: AnyModel,
): AIGatewayModelIndexEntry {
  const catalogModel = asModel(asModel(catalog.neon)?.models)?.[model.id];
  const cost = asModel(asModel(catalogModel)?.cost);
  if (!cost) return model;

  const pricing: AnyModel = { ...cost };
  if (cost.input !== undefined) pricing.input = cost.input;
  if (cost.output !== undefined) pricing.output = cost.output;
  const provider = asModel(catalogModel)?.provider;
  return {
    ...model,
    pricing: pricing as AIGatewayModelPricing,
    providerPricing: typeof provider === 'string'
      ? { [provider]: pricing as AIGatewayModelPricing }
      : model.providerPricing,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function enrichModels(
  config: AIGatewayModelIndexProviderConfig,
  models: AIGatewayModelIndexEntry[],
): Promise<AIGatewayModelIndexEntry[]> {
  const catalog = config.pricingCatalog;
  if (!catalog) return models;

  if (catalog.format === 'neon') {
    const result = await fetchJson(catalog.host, catalog.path, catalog.buildHeaders());
    return result.body ? models.map((model) => enrichNeonModel(model, result.body as AnyModel)) : models;
  }

  return mapWithConcurrency(models, PRICING_REQUEST_CONCURRENCY, async (model) => {
    const requestPath = catalog.pathTemplate.replace('{model}', encodeURIComponent(model.id));
    const result = await fetchJson(catalog.host, requestPath, catalog.buildHeaders());
    return result.body ? enrichConcentrateModel(model, result.body) : model;
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

  const models = await enrichModels(config, normalizeModels(config.modelListFormat, body));
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
