import type { AIGatewayProviderConfig } from './types.js';
import { resolveNeonHost } from './neon-host.js';

/**
 * AI gateway benchmark configurations.
 *
 * Every gateway is hit directly (no gateway proxies through another) with the
 * same model — Claude Haiku 4.5 — so the comparison is apples-to-apples.
 * `anthropic-direct` is the no-gateway control, used to measure how much
 * latency each gateway adds on top of the underlying provider.
 */
export const providers: AIGatewayProviderConfig[] = [
  {
    // `anthropic/claude-haiku-4.5` is a catalog alias that OpenRouter can
    // serve from more than one upstream (Anthropic direct, Bedrock, Vertex,
    // or a reseller), chosen dynamically by OpenRouter's own price/uptime
    // routing unless pinned. `provider.order: ['anthropic']` sets Anthropic
    // as first choice but still allows automatic fallback if Anthropic
    // itself is unavailable (`allow_fallbacks` defaults to true) — rather
    // than failing the iteration outright. Every response (confirmed live,
    // both non-streaming and each SSE chunk) carries a top-level
    // `"provider":"Anthropic"` field, extracted below into
    // `resolvedProvider` so a fallback iteration is visible/filterable in
    // the results instead of silently blending into this gateway's numbers.
    // See https://openrouter.ai/docs/features/provider-routing.
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY'],
    wireFormat: 'openai',
    model: 'anthropic/claude-haiku-4.5',
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
    extraBody: {
      provider: { order: ['anthropic'] },
    },
    extractResolvedProvider: (buf) => buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // Same ambiguity as OpenRouter above: Vercel AI Gateway "dynamically
    // chooses providers based on recent uptime and latency" by default for
    // a catalog alias like `anthropic/claude-haiku-4.5`, which it can also
    // serve via Bedrock/Vertex/its own "claudeaws" credential. `providerOptions
    // .gateway.order: ['anthropic']` sets Anthropic as first choice while
    // still allowing fallback to those other providers if Anthropic itself
    // fails. Unlike OpenRouter, Vercel also exposes a genuine native Anthropic
    // Messages API passthrough (`/v1/messages`, spec-identical per Vercel's
    // own docs) — confirmed live to still honor `providerOptions.gateway.order`
    // on this path, so we use it instead of the OpenAI-compatible
    // `/v1/chat/completions` to avoid the request/response translation that
    // path implies (same rationale as Cloudflare/Pydantic below). Confirmed
    // live: a streamed response carries `resolvedProvider` inside the final
    // `message_delta` event's `provider_metadata.gateway.routing` (alongside
    // usage) — extracted below into `resolvedProvider` for the same
    // visibility-over-silence reason as OpenRouter above. See
    // https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api
    // and https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering.
    name: 'vercel-ai-gateway',
    requiredEnvVars: ['VERCEL_AI_GATEWAY_API_KEY'],
    wireFormat: 'anthropic',
    model: 'anthropic/claude-haiku-4.5',
    host: 'ai-gateway.vercel.sh',
    path: '/v1/messages',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      providerOptions: { gateway: { order: ['anthropic'] } },
    },
    extractResolvedProvider: (buf) => buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // Direct Anthropic passthrough (not routed through another gateway), so
    // this measures Cloudflare's own overhead in isolation.
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: [
      'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID',
      'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID',
      'CLOUDFLARE_AI_GATEWAY_TOKEN',
      'ANTHROPIC_API_KEY',
    ],
    wireFormat: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    host: 'gateway.ai.cloudflare.com',
    path: `/v1/${process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID}/anthropic/v1/messages`,
    buildHeaders: () => ({
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
      ...(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` } : {}),
    }),
  },
  {
    // BlazeRail: OpenAI-compatible /v1/chat/completions; the gateway translates
    // Anthropic-'s native SSE to OpenAI chunks internally. anthropic/claude-haiku-4.5
    // is BlazeRail-s public id; it is served by Anthropic direct and DeepInfra,
    // routed by measured health/price - the product behavior being benchmarked.
    name: 'blazerail',
    requiredEnvVars: ['BLAZERAIL_API_KEY'],
    wireFormat: 'openai',
    model: 'anthropic/claude-haiku-4.5',
    host: 'api.blazerail.com',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.BLAZERAIL_API_KEY}`,
    }),
    extractResolvedProvider: (buf) =>
      buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"model"\s*:\s*"([^"/]+)\/[^"]*"/)?.[1],
  },
  {
    // `anthropic/` here is LLM Gateway's provider-pinning syntax (provider/model),
    // so requests route to Anthropic itself — the same underlying model and
    // deployment as the other participants, addressed in this gateway's own
    // catalog naming convention. LLM Gateway also exposes a native Anthropic
    // Messages API passthrough (`/v1/messages`, listed alongside
    // `/v1/chat/completions` in their own API reference) — confirmed live
    // with a genuine Anthropic-shaped streamed response, so we use that
    // instead of the OpenAI-compatible route to avoid the translation layer
    // (same rationale as Cloudflare/Pydantic/Vercel).
    name: 'llmgateway',
    requiredEnvVars: ['LLM_GATEWAY_API_KEY'],
    wireFormat: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
    host: 'api.llmgateway.io',
    path: '/v1/messages',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
      'anthropic-version': '2023-06-01',
    }),
  },
  {
    // US endpoint specifically, matching this benchmark's fixed Northern
    // Virginia vantage point (see AI_GATEWAYS.md) — the EU endpoint would add
    // an unrelated cross-Atlantic latency penalty that has nothing to do with
    // the gateway's own overhead. Native Anthropic wire format, proxied
    // as-is (no `gateway/<provider>:` prefix on the model — that syntax is
    // specific to Pydantic AI's own Python framework shorthand, not the raw
    // proxy). Auth is `Authorization: Bearer <key>`, not `x-api-key` as used
    // by Cloudflare/Anthropic-direct above — confirmed directly against a
    // real request. Requires the Gateway to be activated in the org's
    // Logfire settings first; a key from an unactivated org returns a
    // same-shaped 401 "Key not found", which looks identical to a bad key.
    name: 'pydantic-ai-gateway',
    requiredEnvVars: ['PYDANTIC_AI_GATEWAY_API_KEY'],
    wireFormat: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    host: 'gateway-us.pydantic.dev',
    path: '/proxy/anthropic/v1/messages',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.PYDANTIC_AI_GATEWAY_API_KEY}`,
      'anthropic-version': '2023-06-01',
    }),
  },
  {
    // Concentrate AI exposes three endpoints: an Anthropic-Messages-compatible
    // `/v1/messages/`, an OpenAI-Chat-Completions-compatible
    // `/v1/chat/completions/`, and `/v1/responses/` — their own first-party,
    // stable API (titled "Responses API" in their published OpenAPI spec at
    // concentrate.ai/docs/api-reference/openapi.json), implementing OpenAI's
    // Responses API shape. Concentrate has confirmed directly that
    // `/v1/messages/` is a beta compatibility shim, not their production
    // surface — it's also where we found the output_tokens/cost.breakdown
    // field-collision bug (see phase-probe.ts), which reproduces identically
    // on `/v1/responses/` too (same `cost.breakdown[…].output_tokens` dollar
    // field, confirmed live), so this benchmark's usage-scoped token
    // extraction still applies. `anthropic/` is this gateway's provider-prefix
    // syntax (same idea as llmgateway's pinning above) to route to Anthropic
    // itself rather than Azure or Bedrock, which Concentrate's own "model
    // fortress" catalog also lists as routing options for this model
    // (anthropic/claude-haiku-4-5, azure/claude-haiku-4-5,
    // bedrock/claude-haiku-4-5).
    name: 'concentrate-ai-gateway',
    requiredEnvVars: ['CONCENTRATE_AI_GATEWAY_API_KEY'],
    wireFormat: 'responses',
    model: 'anthropic/claude-haiku-4-5-20251001',
    host: 'api.concentrate.ai',
    path: '/v1/responses/',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.CONCENTRATE_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    // Ramp Router exposes an OpenAI Responses-compatible API; the `model`
    // field must be a bare `id` from the account's `GET /v1/models` catalog,
    // not the upstream provider's public model name. For this key the
    // Anthropic Haiku 4.5 entry is `claude-haiku-4-5`.
    name: 'ramp',
    requiredEnvVars: ['RAMP_ROUTER_API_KEY'],
    wireFormat: 'responses',
    model: 'claude-haiku-4-5',
    host: 'router-api.ramp.com',
    path: '/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.RAMP_ROUTER_API_KEY}`,
    }),
  },
  {
    name: 'neon',
    requiredEnvVars: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
    wireFormat: 'anthropic',
    model: 'claude-haiku-4-5',
    host: resolveNeonHost().host,
    path: `${resolveNeonHost().basePath}/anthropic/v1/messages`,
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`,
      'anthropic-version': '2023-06-01',
    }),
  },
  {
    // ngrok AI Gateway proxies Anthropic's native Messages API directly at
    // `/v1/messages` using the upstream's `x-api-key` + `anthropic-version`
    // headers; the access key is the ngrok.ai gateway key itself.
    name: 'ngrok',
    requiredEnvVars: ['NGROK_AI_GATEWAY_API_KEY'],
    wireFormat: 'anthropic',
    model: 'claude-haiku-4-5',
    host: 'gateway.ngrok.ai',
    path: '/v1/messages',
    buildHeaders: () => ({
      'x-api-key': process.env.NGROK_AI_GATEWAY_API_KEY || '',
      'anthropic-version': '2023-06-01',
    }),
  },
  {
    // LLM API exposes an Anthropic-native `/v1/messages` passthrough on
    // `api.llmapi.ai` in addition to its OpenAI-compatible surface. Provider
    // pinning uses the `provider/model` prefix documented at
    // https://docs.llmapi.ai/features/routing (`anthropic/claude-haiku-4-5-20251001`);
    // `X-No-Fallback: true` disables the automatic low-uptime fallback so the
    // request stays on Anthropic. Auth is the single account-wide
    // `Authorization: Bearer` key shown in the LLM API docs.
    // `extractResolvedProvider` reads the upstream provider from the response
    // if LLM API exposes it (`provider`, `resolvedProvider`) or derives it from
    // the `model` prefix, so a fallback off Anthropic is visible in the logs.
    name: 'llmapi',
    requiredEnvVars: ['LLMAPI_API_KEY'],
    wireFormat: 'anthropic',
    model: 'anthropic/claude-haiku-4-5-20251001',
    host: 'api.llmapi.ai',
    path: '/v1/messages',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLMAPI_API_KEY}`,
      'anthropic-version': '2023-06-01',
      'X-No-Fallback': 'true',
    }),
    extractResolvedProvider: (buf) =>
      buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"model"\s*:\s*"([^"/]+)\/[^"]*"/)?.[1],
  },
  {
    // No-gateway baseline/control.
    name: 'anthropic-direct',
    requiredEnvVars: ['ANTHROPIC_API_KEY'],
    wireFormat: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    buildHeaders: () => ({
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    }),
  },
];
