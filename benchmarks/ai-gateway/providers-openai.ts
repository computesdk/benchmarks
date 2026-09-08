import { BENCHSDK_RUNNER_VERSION } from '@benchsdk/runner';
import type { AIGatewayProviderConfig } from './types.js';
import { resolveNeonHost } from './neon-host.js';

/**
 * AI gateway benchmark configurations — OpenAI family.
 *
 * Same fairness methodology as `providers.ts` (the Anthropic family): every
 * gateway is hit directly with the same model — `gpt-5.4-mini` — so the
 * comparison is apples-to-apples, and `openai-direct` is the no-gateway
 * control. What differs is the target provider: every request here routes to
 * OpenAI instead of Anthropic, so this measures each gateway's overhead when
 * proxying to a *different* upstream than the original benchmark exercises.
 * Request configuration (`temperature: 0`, `max_tokens: 200`, no `reasoning`
 * field) is identical to the Anthropic family's — see `phase-probe.ts`.
 *
 * Every route below was checked directly against that gateway's own
 * OpenAI-specific docs, not assumed by analogy with its Anthropic route or
 * with another gateway — an earlier pass of this file got Cloudflare's path
 * wrong by doing exactly that (it turned out to drop the `v1` segment its
 * Anthropic route keeps). Policy for this file: **use each gateway's OpenAI
 * Responses API passthrough if it has one, since that's the least-translated
 * route (Responses is OpenAI's own format, so a gateway proxying it natively
 * adds no translation layer); fall back to `/chat/completions` only where no
 * Responses passthrough is documented.** Every gateway below uses one.
 *
 * Still worth a 1-iteration smoke test against real credentials before
 * fully trusting any of these — "confirmed against docs" isn't the same bar
 * as "confirmed against a real response," which is what the Anthropic
 * family's entries in `providers.ts` were held to.
 */
export const providers: AIGatewayProviderConfig[] = [
  {
    // Confirmed: OpenRouter's Responses API passthrough exists at
    // `/api/v1/responses` (openrouter.ai/docs/api_reference/responses/overview),
    // OpenAI-Responses-compatible. Same provider-order pinning mechanism as
    // the Anthropic entry (`provider: { order: [...] }`) — OpenRouter lists
    // Azure as an alternate upstream for some OpenAI catalog models, so the
    // same fallback-visibility rationale applies. NOT independently
    // confirmed for this specific endpoint: whether `provider.order` and the
    // top-level `"provider":"..."` response field carry over from Chat
    // Completions to the Responses endpoint unchanged — OpenRouter's docs
    // didn't cover that, so this is assumed to hold since it's the same
    // underlying routing engine, just a different response shape.
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY'],
    wireFormat: 'responses',
    model: 'openai/gpt-5.4-mini',
    host: 'openrouter.ai',
    path: '/api/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
    extraBody: {
      provider: { order: ['openai'] },
    },
    extractResolvedProvider: (buf) => buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // Vercel AI Gateway exposes a native OpenAI Responses API passthrough at
    // `/v1/responses` (confirmed: vercel.com/changelog/ai-gateway-supports-
    // openais-responses-api), same idea as its native Anthropic Messages
    // passthrough used in the Anthropic family. Provider-order pinning and
    // `resolvedProvider` extraction reuse the same mechanism as the
    // Anthropic entry.
    name: 'vercel-ai-gateway',
    requiredEnvVars: ['VERCEL_AI_GATEWAY_API_KEY'],
    wireFormat: 'responses',
    model: 'openai/gpt-5.4-mini',
    host: 'ai-gateway.vercel.sh',
    path: '/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      providerOptions: { gateway: { order: ['openai'] } },
    },
    extractResolvedProvider: (buf) => buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // Confirmed via Cloudflare's own OpenAI provider docs
    // (developers.cloudflare.com/ai-gateway/providers/openai/), which list
    // BOTH a chat/completions path and this responses path as alternatives.
    // Neither keeps a `v1` segment after the provider name — Cloudflare's
    // own framing is "replace `https://api.openai.com/v1` with the gateway
    // prefix" wholesale, so `v1` is absorbed into the prefix rather than
    // carried through verbatim the way it is for Anthropic's `/v1/messages`.
    // Each provider's passthrough convention has to be checked individually;
    // it isn't uniform across them.
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: [
      'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID',
      'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID',
      'CLOUDFLARE_AI_GATEWAY_TOKEN',
      'OPENAI_API_KEY',
    ],
    wireFormat: 'responses',
    model: 'gpt-5.4-mini',
    host: 'gateway.ai.cloudflare.com',
    path: `/v1/${process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID}/openai/responses`,
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` } : {}),
    }),
  },
  {
    // Confirmed via LLM Gateway's own Codex CLI integration guide
    // (llmgateway.io/guides/codex-cli), which states outright: "Codex CLI
    // uses the OpenAI Responses API (`/v1/responses`)" against a base URL of
    // `https://api.llmgateway.io/v1`. `openai/gpt-5.4-mini` follows LLM
    // Gateway's confirmed provider-pinning syntax (docs.llmgateway.io —
    // provider-prefix routing), demonstrated there for Chat Completions; NOT
    // independently re-confirmed for the Responses endpoint specifically,
    // but assumed to carry over since it's the same routing engine.
    name: 'llmgateway',
    requiredEnvVars: ['LLM_GATEWAY_API_KEY'],
    wireFormat: 'responses',
    model: 'openai/gpt-5.4-mini',
    host: 'api.llmgateway.io',
    path: '/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
    }),
  },
  {
    // `openai/gpt-5.4-mini` follows Concentrate's confirmed provider-prefix
    // syntax (concentrate.ai/models — "openai/gpt-5.4" shown as the
    // provider-pinned form). Uses the same `/v1/responses/` endpoint as the
    // Anthropic entry; for OpenAI this is even less of a translation layer
    // than it is for Anthropic, since Concentrate's `/v1/responses/`
    // implements OpenAI's own spec directly. Carries the same unconfirmed-
    // against-a-real-response caveat as the Anthropic entry (see
    // providers.ts).
    name: 'concentrate-ai-gateway',
    requiredEnvVars: ['CONCENTRATE_AI_GATEWAY_API_KEY'],
    wireFormat: 'responses',
    model: 'openai/gpt-5.4-mini',
    host: 'api.concentrate.ai',
    path: '/v1/responses/',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.CONCENTRATE_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    // Pydantic AI Gateway exposes two purpose-built proxy routes
    // (pydantic.dev/docs/ai/overview/gateway): `/proxy/chat/` for Chat
    // Completions and `/proxy/openai-responses` for the Responses API.
    // We use the Responses route here to stay consistent with the rest of
    // this file (every other entry uses Responses where available), and
    // because it's OpenAI's own wire format — no translation layer.
    //
    // Path derivation: Pydantic's Codex config example sets
    //   base_url = "https://gateway-us.pydantic.dev/proxy/openai-responses"
    //   wire_api = "responses"
    // and Codex appends `/responses` to that base URL, giving the full
    // path `/proxy/openai-responses/responses`. (Not `/proxy/openai` —
    // that path appears in Pydantic's docs but only as an unconfirmed
    // Vercel-AI-SDK integration point with no documented full path.)
    //
    // Model id is unprefixed (`gpt-5.4-mini`, not `openai/gpt-5.4-mini`):
    // Pydantic's proxy doesn't use the provider-prefix routing that LLM
    // Gateway and Concentrate do — same as the Anthropic entry's
    // unprefixed `claude-haiku-4-5-20251001` in providers.ts.
    //
    // Auth: `Authorization: Bearer <gateway key>` — confirmed live against
    // the Anthropic route (see providers.ts). Not a provider-specific
    // header. The org must have the Gateway activated in its Logfire
    // settings first, or the key returns a 401 "Key not found".
    name: 'pydantic-ai-gateway',
    requiredEnvVars: ['PYDANTIC_AI_GATEWAY_API_KEY'],
    wireFormat: 'responses',
    model: 'gpt-5.4-mini',
    host: 'gateway-us.pydantic.dev',
    path: '/proxy/openai-responses/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.PYDANTIC_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    name: 'ramp',
    requiredEnvVars: ['RAMP_ROUTER_API_KEY'],
    wireFormat: 'responses',
    // Ramp's `model` field takes a bare `id` from GET /v1/models, not the
    // `provider:provider-model` form used for the `models` fallback array
    // (see router.ramp.com/docs/guides/choose-a-model).
    model: 'gpt-5.4-mini',
    host: 'router-api.ramp.com',
    path: '/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.RAMP_ROUTER_API_KEY}`,
    }),
  },
  {
    name: 'neon',
    requiredEnvVars: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
    wireFormat: 'responses',
    model: 'gpt-5-4-mini',
    host: resolveNeonHost().host,
    path: `${resolveNeonHost().basePath}/openai/v1/responses`,
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`,
    }),
  },
  {
    // ngrok AI Gateway's Responses API passthrough. The SDKs page lists the
    // Responses API as supported, so we keep the OpenAI-family convention of
    // `/v1/responses` rather than falling back to `/v1/chat/completions`.
    name: 'ngrok',
    requiredEnvVars: ['NGROK_AI_GATEWAY_API_KEY'],
    wireFormat: 'responses',
    model: 'gpt-5.4-mini',
    host: 'gateway.ngrok.ai',
    path: '/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NGROK_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    // LLM API's unified gateway exposes the OpenAI Responses API at
    // `/v1/responses` on `api.llmapi.ai`, with the same model id and auth
    // (`Authorization: Bearer`) as its OpenAI-compatible chat-completions surface.
    // Provider pinning uses the `provider/model` prefix documented at
    // https://docs.llmapi.ai/features/routing (`openai/gpt-5.4-mini`);
    // `X-No-Fallback: true` disables the automatic low-uptime fallback so the
    // request stays on OpenAI. `extractResolvedProvider` reads the upstream
    // provider from the response if LLM API exposes it (`provider`,
    // `resolvedProvider`) or derives it from the `model` prefix.
    name: 'llmapi',
    requiredEnvVars: ['LLMAPI_API_KEY'],
    wireFormat: 'responses',
    model: 'openai/gpt-5.4-mini',
    host: 'api.llmapi.ai',
    path: '/v1/responses',
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
    name: 'github-copilot',
    requiredEnvVars: ['GITHUB_COPILOT_API_KEY'],
    wireFormat: 'responses',
    model: 'gpt-5.4-mini',
    host: 'api.githubcopilot.com',
    path: '/responses',
    buildHeaders: () => ({
      'X-GitHub-Api-Version': '2025-10-01',
      'User-Agent': `benchsdk-runner/${BENCHSDK_RUNNER_VERSION}`,
      Authorization: `Bearer ${process.env.GITHUB_COPILOT_API_KEY || ''}`,
    }),
  },
  {
    // No-gateway baseline/control. OpenAI's own Responses API — its current
    // flagship endpoint (vs. the older Chat Completions surface) — is the
    // most direct route into OpenAI's own infrastructure.
    name: 'openai-direct',
    requiredEnvVars: ['OPENAI_API_KEY'],
    wireFormat: 'responses',
    model: 'gpt-5.4-mini',
    host: 'api.openai.com',
    path: '/v1/responses',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    }),
  },
];
