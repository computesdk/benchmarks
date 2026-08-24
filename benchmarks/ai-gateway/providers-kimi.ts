import type { AIGatewayProviderConfig } from './types.js';
import { resolveNeonHost } from './neon-host.js';

/**
 * AI gateway benchmark configurations — Kimi family.
 *
 * Same fairness methodology as `providers.ts`, `providers-openai.ts`, and
 * `providers-gemini.ts`: every gateway is hit directly with the same model —
 * `kimi-k3` — so the comparison is apples-to-apples, and `kimi-direct` is
 * the no-gateway control. This family uses `maxTokens: 2000` instead of the
 * usual 200 (set in `ai-gateway-kimi.bench.ts`) — see the rationale in
 * `AIGatewayFamilyDef.maxTokens` in `task.ts`.
 *
 * Almost every entry uses `wireFormat: 'openai'` — not a translation layer.
 * Kimi's own native API is itself OpenAI-Chat-Completions-shaped (Moonshot's
 * own design, not a third-party compatibility shim, confirmed by
 * `kimi-direct` itself), so proxying it via an OpenAI-compatible surface
 * doesn't lose anything the way it would for Gemini. Ramp Router is the
 * exception: it only exposes a Responses API, so it uses `wireFormat:
 * 'responses'` with `/v1/responses`.
 *
 * Every entry also strips `temperature` via `extraBody: { temperature:
 * undefined }` — confirmed live against Moonshot's own API: `kimi-k3`
 * rejects any value other than 1 outright ("invalid temperature: only 1 is
 * allowed for this model"), and the shared `openai`-wireFormat branch in
 * `phase-probe.ts` hardcodes `temperature: 0` by default for the other
 * families that need it. Omitting the field entirely (not sending `1`
 * explicitly) is what was confirmed working live.
 *
 * One gateway is excluded, for the same reason Pydantic was excluded from
 * the Gemini family — a genuinely different backend, not just an
 * unconfirmed one: **Pydantic AI Gateway**'s documented provider list
 * (OpenAI, Anthropic, Vertex, Groq, Bedrock) has no Moonshot entry at all.
 *
 * Cloudflare AI Gateway was *not* excluded, despite an earlier version of
 * this file excluding it — that exclusion was based on incomplete research.
 * Cloudflare's Workers AI catalog turns out to list `moonshotai/kimi-k3`
 * itself as a "Third-party" model (distinct from its `@cf/`-prefixed,
 * genuinely Cloudflare-hosted `kimi-k2.7-code`/`kimi-k2.6` checkpoints), and
 * this route was confirmed live: a real streamed response, matching
 * `kimi-direct`'s own `reasoning_content` field shape, from a newer unified
 * Cloudflare REST API (`api.cloudflare.com/client/v4/accounts/{account}/ai/
 * v1/chat/completions`) that's a different product surface than the
 * `gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...` pattern
 * every other family's Cloudflare entry uses — no `CLOUDFLARE_AI_GATEWAY_
 * GATEWAY_ID` needed, and Cloudflare's own credentials are the only auth
 * required (no separate Moonshot key gets forwarded). Cloudflare's own docs
 * don't clarify whether this reaches Moonshot's infrastructure directly or
 * a reseller behind the scenes; the confirmed-live response shape is
 * consistent with genuine Moonshot output, but that's the ceiling of what's
 * actually verified.
 *
 * Provider-order pinning matters more here than it did for the Anthropic and
 * OpenAI families: Kimi K3 is **open-weight**, so — unlike Anthropic's or
 * OpenAI's closed models, which only their own company can serve — multiple
 * third-party infrastructure providers can host it. Confirmed live evidence
 * of this: Vercel's own changelog states K3 is served "from US-based
 * providers... including Baseten and Fireworks," and LLM Gateway's own
 * catalog page lists six separate providers for this model (Moonshot AI,
 * NovitaAI, Together AI, Nebius AI, Fireworks AI, CanopyWave). Every gateway
 * below that supports provider-order pinning uses it, to keep the request
 * actually landing on Moonshot's own infrastructure rather than a reseller
 * with different latency characteristics — same rationale, and same
 * `resolvedProvider` visibility-over-silence pattern, as the Anthropic
 * family's OpenRouter/Vercel entries.
 *
 * Every `openai`-format entry also sets `reasoningCountsAsFirstToken:
 * true` (see that flag's doc comment in `types.ts`) — for this family,
 * `ttftMs` measures time to the first *reasoning* token, not the first
 * *visible* one, since `kimi-k3` runs with reasoning locked "always on" and
 * "time to first visible token" would otherwise measure however long the
 * model chooses to deliberate rather than gateway/network responsiveness.
 * Confirmed live across all participants here: exactly two reasoning-field
 * conventions exist — `reasoning_content` (Moonshot direct, Cloudflare) and
 * `reasoning` (OpenRouter, Vercel, LLM Gateway, Concentrate, Novita, Neon, ngrok) —
 * both handled by `contentRegexFor` in `phase-probe.ts`. Ramp Router uses
 * the Responses API, which does not expose reasoning tokens to this flag.
 *
 * Still worth a 1-iteration smoke test against real credentials before
 * fully trusting any of these — "confirmed against docs" isn't the same bar
 * as "confirmed against a real response," which is what the Anthropic
 * family's entries in `providers.ts` were held to (Cloudflare, `kimi-direct`,
 * OpenRouter, and Vercel here are the exceptions — all confirmed live).
 */
export const providers: AIGatewayProviderConfig[] = [
  {
    // `moonshotai/kimi-k3` is OpenRouter's confirmed catalog convention
    // (openrouter.ai/moonshotai). Provider-order pinning to `moonshotai`
    // specifically (not a generic "no fallback" flag) — see the open-weight
    // reseller-ambiguity rationale above.
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY'],
    wireFormat: 'openai',
    model: 'moonshotai/kimi-k3',
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
    extraBody: {
      provider: { order: ['moonshotai'] },
      temperature: undefined,
    },
    extractResolvedProvider: (buf) => buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1],
    reasoningCountsAsFirstToken: true,
  },
  {
    // `moonshotai/kimi-k3` confirmed directly via Vercel's own model page
    // (vercel.com/ai-gateway/models/kimi-k3) — "set model to
    // moonshotai/kimi-k3 in the AI SDK". Same provider-order pinning
    // mechanism as this gateway's other family entries, pinned to
    // `moonshotai` specifically given the confirmed reseller options
    // (Baseten, Fireworks) for this open-weight model.
    name: 'vercel-ai-gateway',
    requiredEnvVars: ['VERCEL_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'moonshotai/kimi-k3',
    host: 'ai-gateway.vercel.sh',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      providerOptions: { gateway: { order: ['moonshotai'] } },
      temperature: undefined,
    },
    extractResolvedProvider: (buf) => buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1],
    reasoningCountsAsFirstToken: true,
  },
  {
    // Confirmed live this pass (see file header): a real streamed response
    // via Cloudflare's newer unified REST API, model id `moonshotai/kimi-k3`
    // (Workers AI's "Third-party" catalog entry, not the `@cf/`-prefixed
    // `kimi-k2.7-code` checkpoint this file previously — incorrectly —
    // treated as Cloudflare's only Kimi access). This endpoint has no
    // gateway id in the URL path the way `gateway.ai.cloudflare.com` does,
    // but it's still the AI Gateway product, not a separate one: per
    // Cloudflare's own docs, third-party model requests without a
    // `cf-aig-gateway-id` header auto-route through an auto-created
    // "default" gateway rather than a named one — invisible in that named
    // gateway's dashboard/logs unless the header is set, confirmed live
    // this pass. Cloudflare's own credentials are the only auth needed; no
    // separate Kimi key is forwarded.
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: ['CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID', 'CLOUDFLARE_AI_GATEWAY_TOKEN'],
    wireFormat: 'openai',
    model: 'moonshotai/kimi-k3',
    host: 'api.cloudflare.com',
    path: `/client/v4/accounts/${process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID}/ai/v1/chat/completions`,
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}`,
      'cf-aig-gateway-id': process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID || '',
    }),
    extraBody: {
      temperature: undefined,
    },
    reasoningCountsAsFirstToken: true,
  },
  {
    // `moonshot/kimi-k3` confirmed directly via LLM Gateway's own model page
    // (llmgateway.io/models/kimi-k3/moonshot: "the page specifies
    // moonshot/kimi-k3 as the identifier"). Note the provider slug is
    // `moonshot` here, not `moonshotai` as on OpenRouter/Vercel — a real
    // cross-gateway naming inconsistency, not a typo; each was verified
    // against that gateway's own docs rather than assumed to match the
    // others. LLM Gateway's provider-pinning mechanism *is* this
    // provider-prefixed model id (confirmed generically elsewhere in this
    // repo) — no separate pinning field needed the way OpenRouter/Vercel
    // require.
    name: 'llmgateway',
    requiredEnvVars: ['LLM_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'moonshot/kimi-k3',
    host: 'api.llmgateway.io',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      temperature: undefined,
    },
    reasoningCountsAsFirstToken: true,
  },
  {
    // Confirmed on Concentrate's own model catalog (concentrate.ai/models,
    // filtered to the moonshot provider) that both `kimi-k3` and
    // `kimi-k2-7-code` are listed — but the exact provider-prefixed pin
    // string wasn't shown there the way "openai/gpt-5.4" was demonstrated
    // elsewhere on the same site. `moonshot/kimi-k3` follows this gateway's
    // established creator-prefix convention (`anthropic/`, `openai/`,
    // `azure/`, `bedrock/`) and litellm's own canonical Moonshot slug (this
    // gateway's routing is litellm-based) — inferred, not independently
    // confirmed as the literal request-body string. Lower confidence than
    // this file's other entries; worth confirming with a live request
    // before trusting it.
    name: 'concentrate-ai-gateway',
    requiredEnvVars: ['CONCENTRATE_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'moonshot/kimi-k3',
    host: 'api.concentrate.ai',
    path: '/v1/chat/completions/',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.CONCENTRATE_AI_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      temperature: undefined,
    },
    reasoningCountsAsFirstToken: true,
  },
  {
    // BlazeRail: OpenAI-compatible /v1/chat/completions. moonshotai/kimi-k3 is
    // BlazeRail-s public id for the model; routing picks among its five live
    // upstreams (CrofAI, DeepInfra, Wafer, Moonshot AI, Modal) by measured
    // latency and price, which is the product behavior being benchmarked -
    // same posture as the other multi-upstream gateways in this family.
    name: 'blazerail',
    requiredEnvVars: ['BLAZERAIL_API_KEY'],
    wireFormat: 'openai',
    model: 'moonshotai/kimi-k3',
    host: 'api.blazerail.com',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.BLAZERAIL_API_KEY}`,
    }),
    extraBody: {
      temperature: undefined,
    },
    extractResolvedProvider: (buf) =>
      buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"model"\s*:\s*"([^"/]+)\/[^"]*"/)?.[1],
    reasoningCountsAsFirstToken: true,
  },
  {
    name: 'novita',
    requiredEnvVars: ['NOVITA_API_KEY'],
    wireFormat: 'openai',
    model: 'moonshotai/kimi-k3',
    host: 'api.novita.ai',
    path: '/openai/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NOVITA_API_KEY}`,
    }),
    extraBody: {
      temperature: undefined,
    },
    reasoningCountsAsFirstToken: true,
  },
  {
    name: 'ramp',
    requiredEnvVars: ['RAMP_ROUTER_API_KEY'],
    wireFormat: 'responses',
    // Ramp's `model` field takes a bare `id` from GET /v1/models, not the
    // `provider:provider-model` form used for the `models` fallback array
    // (see router.ramp.com/docs/guides/choose-a-model).
    model: 'accounts/fireworks/models/kimi-k3',
    host: 'router-api.ramp.com',
    path: '/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.RAMP_ROUTER_API_KEY}`,
    }),
    extraBody: {
      temperature: undefined,
    },
  },
  {
    name: 'neon',
    requiredEnvVars: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
    wireFormat: 'openai',
    model: 'kimi-k3',
    host: resolveNeonHost().host,
    path: `${resolveNeonHost().basePath}/v1/chat/completions`,
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`,
    }),
    extraBody: {
      temperature: undefined,
    },
    reasoningCountsAsFirstToken: true,
  },
  {
    // ngrok AI Gateway's Moonshot provider is listed in the model catalog
    // (provider id `moonshotai`); the OpenAI-compatible `/v1/chat/completions`
    // route is the documented way to reach it, and the catalog model id is
    // `kimi-k3`.
    name: 'ngrok',
    requiredEnvVars: ['NGROK_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'kimi-k3',
    host: 'gateway.ngrok.ai',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NGROK_AI_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      temperature: undefined,
    },
    reasoningCountsAsFirstToken: true,
  },
  {
    // LLM API reaches Moonshot's `kimi-k3` through its unified
    // OpenAI-compatible `/v1/chat/completions` surface on `api.llmapi.ai`;
    // reasoning is locked on for this model, so the same `temperature: undefined`
    // and `reasoningCountsAsFirstToken` overrides as the other Kimi-family
    // `openai`-format entries apply. Provider pinning uses the `provider/model`
    // prefix documented at https://docs.llmapi.ai/features/routing
    // (`moonshot/kimi-k3`, matching the `moonshot` provider in the `/v1/models`
    // catalog); `X-No-Fallback: true` disables the automatic low-uptime fallback
    // so the request stays on Moonshot. `extractResolvedProvider` reads the
    // upstream provider from the response if LLM API exposes it (`provider`,
    // `resolvedProvider`) or derives it from the `model` prefix.
    name: 'llmapi',
    requiredEnvVars: ['LLMAPI_API_KEY'],
    wireFormat: 'openai',
    model: 'moonshot/kimi-k3',
    host: 'api.llmapi.ai',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLMAPI_API_KEY}`,
      'X-No-Fallback': 'true',
    }),
    extraBody: {
      temperature: undefined,
    },
    extractResolvedProvider: (buf) =>
      buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1] ??
      buf.match(/"model"\s*:\s*"([^"/]+)\/[^"]*"/)?.[1],
    reasoningCountsAsFirstToken: true,
  },
  {
    // No-gateway baseline/control. Moonshot AI's Kimi API is itself
    // OpenAI-Chat-Completions-shaped (not a third-party compatibility shim —
    // that's Moonshot's own native API), so this is the most direct route
    // into Moonshot's own infrastructure. Kimi K3 is Moonshot's only current
    // flagship (no fast/lite tier as of this writing) and runs with
    // reasoning locked to "always on" — with `reasoningCountsAsFirstToken`
    // measuring to the first reasoning token rather than the first visible
    // one, TTFT here is closer in kind to the other families' (still
    // expect it to run somewhat higher, since Kimi's reasoning-first
    // response shape and serving stack differ from the non-reasoning
    // participants elsewhere — but not the multi-second reasoning-phase gap
    // this would show without that flag). Confirmed live this pass,
    // including the `temperature` rejection and the reasoning-token-
    // exhaustion behavior that drove this family's `maxTokens: 2000`
    // override — see the file header and `task.ts`.
    name: 'kimi-direct',
    requiredEnvVars: ['KIMI_API_KEY'],
    wireFormat: 'openai',
    model: 'kimi-k3',
    host: 'api.moonshot.ai',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.KIMI_API_KEY}`,
    }),
    extraBody: {
      temperature: undefined,
    },
    reasoningCountsAsFirstToken: true,
  },
];
