import type { AIGatewayProviderConfig } from './types.js';
import { resolveNeonHost } from './neon-host.js';

/**
 * AI gateway benchmark configurations — Gemini family.
 *
 * Same fairness methodology as `providers.ts` (the Anthropic family) and
 * `providers-openai.ts` (the OpenAI family): every gateway is hit directly
 * with the same model — `gemini-3.6-flash` — so the comparison is
 * apples-to-apples, and `gemini-direct` is the no-gateway control.
 *
 * Unlike the OpenAI family, only two gateways here get the native
 * `wireFormat: 'gemini'` treatment: Cloudflare AI Gateway and Neon AI Gateway,
 * confirmed via their own `google-ai-studio` provider docs (Cloudflare) and
 * Neon AI Gateway docs to proxy Google's real `generateContent`/
 * `streamGenerateContent` shape directly. The other gateways (OpenRouter,
 * Vercel AI Gateway, LLM Gateway, and Concentrate AI) show no evidence of a
 * genuine native Gemini passthrough — unlike their confirmed native Anthropic
 * Messages / OpenAI Responses passthroughs used elsewhere in this repo — so
 * they route through their own OpenAI-compatible `/chat/completions` surface
 * instead, translating Gemini's real response where they can or failing at
 * runtime if they cannot. ngrok AI Gateway is included here because its
 * Google-provider docs explicitly say to call `/v1/chat/completions` with an
 * OpenAI client and only change the model name.
 *
 * Pydantic AI Gateway, Novita, and Ramp Router are deliberately excluded:
 * Pydantic's own docs state that its `gateway` provider mode for Google routes
 * to **Vertex AI**, not the native Gemini API, while Novita's catalog doesn't
 * list Gemini models and Ramp Router has no Gemini provider. Including any of
 * them would either compare a different backend or fail at runtime, so they're
 * left out entirely rather than included just to error out.
 *
 * Still worth a 1-iteration smoke test against real credentials before
 * fully trusting any of these — "confirmed against docs" isn't the same bar
 * as "confirmed against a real response," which is what the Anthropic
 * family's entries in `providers.ts` were held to.
 */
export const providers: AIGatewayProviderConfig[] = [
  {
    // No native Gemini passthrough documented for OpenRouter — its whole
    // platform is built around one normalized, OpenAI-Chat-Completions-
    // shaped endpoint across its entire catalog, not per-provider native
    // passthroughs. `google/gemini-3.6-flash` is OpenRouter's confirmed
    // provider/model catalog convention. Same provider-order pinning
    // mechanism as the Anthropic and OpenAI family entries.
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY'],
    wireFormat: 'openai',
    model: 'google/gemini-3.6-flash',
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
    extraBody: {
      provider: { order: ['google'] },
    },
    extractResolvedProvider: (buf) => buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // No native Gemini passthrough confirmed for Vercel AI Gateway either
    // (unlike its confirmed native Anthropic Messages and OpenAI Responses
    // passthroughs) — its docs describe one unified endpoint across
    // providers via the `creator/model-name` convention, with no
    // Gemini-specific route documented. `google/gemini-3.6-flash` follows
    // that confirmed convention. Provider-order pinning and
    // `resolvedProvider` extraction reuse the same mechanism as the other
    // families' Vercel entries.
    name: 'vercel-ai-gateway',
    requiredEnvVars: ['VERCEL_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'google/gemini-3.6-flash',
    host: 'ai-gateway.vercel.sh',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      providerOptions: { gateway: { order: ['google'] } },
    },
    extractResolvedProvider: (buf) => buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // Confirmed via Cloudflare's own google-ai-studio provider docs
    // (developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio):
    // a genuine native passthrough, `.../google-ai-studio/v1/models/
    // {model}:{generative_ai_rest_resource}` — substitute
    // `streamGenerateContent` for the resource, same as calling Google
    // directly. `?alt=sse` matches the convention already used by
    // `gemini-direct` for real SSE framing rather than a buffered JSON
    // array. Request body shape and auth (`x-goog-api-key`, optionally
    // alongside `cf-aig-authorization`) both confirmed in the same docs.
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: [
      'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID',
      'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID',
      'CLOUDFLARE_AI_GATEWAY_TOKEN',
      'GEMINI_API_KEY',
    ],
    wireFormat: 'gemini',
    model: 'gemini-3.6-flash',
    host: 'gateway.ai.cloudflare.com',
    path: `/v1/${process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID}/google-ai-studio/v1/models/gemini-3.6-flash:streamGenerateContent?alt=sse`,
    buildHeaders: () => ({
      'x-goog-api-key': process.env.GEMINI_API_KEY || '',
      ...(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` } : {}),
    }),
  },
  {
    // No native Gemini passthrough documented for LLM Gateway — same
    // situation as OpenRouter/Vercel, one unified OpenAI-compatible surface
    // across its catalog. `google-ai-studio/gemini-3.6-flash` follows the
    // same provider-prefix convention confirmed for this gateway's OpenAI
    // and Kimi entries elsewhere in this repo, matching the provider-name
    // segment shown in LLM Gateway's own catalog URLs
    // (llmgateway.io/models/gemini-3.6-flash/google-ai-studio) — NOT
    // independently re-confirmed as the exact request-body pin string,
    // since that catalog URL demonstrates the model listing, not a
    // request example.
    name: 'llmgateway',
    requiredEnvVars: ['LLM_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'google-ai-studio/gemini-3.6-flash',
    host: 'api.llmgateway.io',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
    }),
  },
  {
    // No native Gemini passthrough documented for Concentrate AI either.
    // `google/gemini-3.6-flash` follows the same creator-name provider-
    // prefix convention confirmed for this gateway's Anthropic and OpenAI
    // entries elsewhere in this repo (`anthropic/...`, `openai/...`) — NOT
    // independently confirmed for Google specifically: Concentrate's
    // underlying routing is litellm-based, and litellm's own convention for
    // Google's API-key-authenticated route is the abbreviation `gemini/`
    // rather than `google/` (with unprefixed model ids defaulting to
    // Vertex AI, per litellm's docs) — Concentrate may or may not preserve
    // that exact abbreviation for its own API consumers. Lower confidence
    // than this file's other model-id claims; worth confirming with a live
    // request before trusting this specific entry.
    name: 'concentrate-ai-gateway',
    requiredEnvVars: ['CONCENTRATE_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'google/gemini-3.6-flash',
    host: 'api.concentrate.ai',
    path: '/v1/chat/completions/',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.CONCENTRATE_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    name: 'neon',
    requiredEnvVars: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
    wireFormat: 'gemini',
    model: 'gemini-3-6-flash',
    host: resolveNeonHost().host,
    path: `${resolveNeonHost().basePath}/gemini/v1beta/models/gemini-3-6-flash:streamGenerateContent?alt=sse`,
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`,
    }),
  },
  {
    // ngrok AI Gateway's Google provider is explicitly OpenAI-Chat-Completions
    // shaped. Docs warn that the native Gemini `generateContent` API and the
    // OpenAI Responses API (`/v1/responses`) do not reach Google models, so
    // this entry uses `wireFormat: 'openai'` against `/v1/chat/completions`.
    name: 'ngrok',
    requiredEnvVars: ['NGROK_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'gemini-3.6-flash',
    host: 'gateway.ngrok.ai',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NGROK_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    // LLM API routes Gemini through its unified OpenAI-compatible
    // `/v1/chat/completions` surface (`api.llmapi.ai/v1/chat/completions`);
    // the `/v1/models` catalog lists `gemini-3.6-flash` as the public model id
    // backed by Google AI Studio. Provider pinning uses the `provider/model`
    // prefix documented at https://docs.llmapi.ai/features/routing
    // (`google-ai-studio/gemini-3.6-flash`, matching the `google-ai-studio`
    // provider in the `/v1/models` catalog); `X-No-Fallback: true` disables the
    // automatic low-uptime fallback so the request stays on Google AI Studio.
    // `extractResolvedProvider` reads the upstream provider from the response
    // if LLM API exposes it (`provider`, `resolvedProvider`) or derives it from
    // the `model` prefix.
    name: 'llmapi',
    requiredEnvVars: ['LLMAPI_API_KEY'],
    wireFormat: 'openai',
    model: 'google-ai-studio/gemini-3.6-flash',
    host: 'api.llmapi.ai',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLMAPI_API_KEY}`,
      'X-No-Fallback': 'true',
    }),
    extractResolvedProvider: (buf) =>
      buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"model"\s*:\s*"([^"/]+)\/[^"]*"/)?.[1],
  },
  {
    // BlazeRail: OpenAI-compatible /v1/chat/completions surface, same shape
    // as the llmgateway entry. google/gemini-3.6-flash is served by exactly
    // one upstream on BlazeRail (Google AI Studio direct), so the route is
    // deterministic without a provider-order pin.
    name: 'blazerail',
    requiredEnvVars: ['BLAZERAIL_API_KEY'],
    wireFormat: 'openai',
    model: 'google/gemini-3.6-flash',
    host: 'api.blazerail.com',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.BLAZERAIL_API_KEY}`,
    }),
  },
  {
    // No-gateway baseline/control. Gemini's native `streamGenerateContent`
    // endpoint (not the OpenAI-compatibility shim Google also exposes) —
    // `contents`/`parts` request shape, `usageMetadata.candidatesTokenCount`
    // for token counts (see `wireFormat: 'gemini'` in phase-probe.ts). Auth
    // via `x-goog-api-key` header (avoids putting the key in the URL as a
    // `?key=` query param).
    name: 'gemini-direct',
    requiredEnvVars: ['GEMINI_API_KEY'],
    wireFormat: 'gemini',
    model: 'gemini-3.6-flash',
    host: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
    buildHeaders: () => ({
      'x-goog-api-key': process.env.GEMINI_API_KEY || '',
    }),
  },
];
