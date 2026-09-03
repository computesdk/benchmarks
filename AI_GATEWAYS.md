# AI Gateway Benchmark

This document describes the **AI gateway benchmark** — a phase-by-phase latency, throughput, and reliability comparison of OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, Pydantic AI Gateway, Concentrate AI, Novita, Ramp Router, Neon AI Gateway, ngrok AI Gateway, and LLM API. It's organized as one **family benchmark per target provider**, all built on the same shared task plumbing (`shared-task.ts`, `phase-probe.ts`, scoring) so every family uses an identical prompt, phase methodology, and scoring formula — only the target provider (and therefore the model and each gateway's routing syntax) changes between them:

- **Anthropic family** (`ai-gateway.bench.ts` + `providers.ts`) — ten gateways (OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, Pydantic AI Gateway, Concentrate AI, Ramp Router, Neon AI Gateway, ngrok AI Gateway, and LLM API, plus anthropic-direct as a direct baseline; Novita excluded — see below) routed to Claude Haiku 4.5, measured against a direct-to-Anthropic baseline. This is the original benchmark and the one with the deepest "confirmed live" verification (see [Every gateway is hit directly](#every-gateway-is-hit-directly--no-gateway-is-proxied-through-another) below).

- **OpenAI family** (`ai-gateway-openai.bench.ts` + `providers-openai.ts`) — ten gateways (OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, Concentrate AI, Pydantic AI Gateway, Ramp Router, Neon AI Gateway, ngrok AI Gateway, and LLM API; Novita excluded — see below) routed to `gpt-5.4-mini` instead, measured against a direct-to-OpenAI baseline. See [OpenAI family benchmark](#openai-family-benchmark).
- **Gemini family** (`ai-gateway-gemini.bench.ts` + `providers-gemini.ts`) — eight gateways (OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, Concentrate AI, Neon AI Gateway, ngrok AI Gateway, and LLM API; Pydantic, Novita, and Ramp Router excluded — see below) routed to `gemini-3.6-flash`, measured against a direct-to-Gemini baseline. See [Gemini family benchmark](#gemini-family-benchmark).
- **Kimi family** (`ai-gateway-kimi.bench.ts` + `providers-kimi.ts`) — ten gateways (OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, Concentrate AI, Novita, Ramp Router, Neon AI Gateway, ngrok AI Gateway, and LLM API; Pydantic excluded — see below) routed to `kimi-k3`, measured against a direct-to-Moonshot baseline. See [Kimi family benchmark](#kimi-family-benchmark).

A result from one family is **not** directly comparable to the same gateway's result in another family — different target provider means a different underlying model and (for some gateways) a different routing path, so a difference in numbers can't be attributed to the gateway alone the way it can within a single family.

> **Where this runs**: scheduled and dispatched runs execute in GitHub Actions on [Namespace](https://namespace.so) runners (`namespace-profile-default`), physically placed in **Northern Virginia, US**. This is a single fixed vantage point, not a global or multi-region measurement — every number in this benchmark reflects network conditions from that one location. Confirmed two ways: Namespace's own runner-instance panel reports "Placement: Northern Virginia, US" for this profile, and independently, `cf-ray` receipts captured in real runs include `IAD` — the airport code Cloudflare uses for its Ashburn/Northern Virginia edge datacenter, exactly consistent with a client physically nearby. See [Vantage-point dependent](#limitations) in Limitations for what this does and doesn't mean for the results.

## Why this benchmark exists

Gateway latency discussions online routinely conflate metrics that behave very differently: connection-setup overhead (DNS, TCP, TLS) vs. actual routing/model-dispatch overhead, and a fresh connection's cost vs. an already-open connection's cost. A single aggregate "latency" number hides which of those is actually responsible for a gateway feeling fast or slow. This benchmark separates them explicitly, so a claim like "Gateway X is slower" can be traced to a specific phase rather than taken on faith.

The phase-separation methodology (cold vs. warm, DNS/TCP/TLS/TTFB/TTFT, round-robin execution, no-session-resumption cold connections) is adapted from [rbadillap/ai-gateways-benchmark](https://github.com/rbadillap/ai-gateways-benchmark), an independent open-source benchmark using the same approach. We reimplemented it in TypeScript on top of Node's `https` module rather than raw sockets, added a direct-to-Anthropic baseline and a fourth gateway routed without any intermediary hop, and extended it with tokens/sec and a composite score — see [Comparison to the reference implementation](#comparison-to-the-reference-implementation) for the full list of what matches and what's deliberately different.

## What gets measured

For each gateway, every probe request is one of two kinds:

- **Cold** — a brand-new TCP+TLS connection, opened from scratch for this single request. We time each connection phase individually (see below), plus the request itself.
- **Warm** — one throwaway request completes and is discarded on a freshly-opened keep-alive connection, then a **second** request is sent and measured on that same still-open socket. This isolates the connection-pool case: no DNS, no TCP, no TLS, just the request/response over a connection that's already up.

Every probe (cold or warm) also records:

- **Output tokens generated** and **tokens/sec** (output tokens divided by the full wall-clock time from request start to stream end, so buffering/batching cannot inflate the rate)
- **Success/error** — any non-2xx response, a timeout, or a completed stream with zero content tokens observed counts as a failure for that iteration. A request can return HTTP 200 and a validly-terminated stream while still failing server-side, with the real reason buried in an `event: error`/`response.failed` SSE payload rather than the HTTP status — `phase-probe.ts` scans the buffer for that error message on failure and includes it in the logged/stored error rather than only the generic "no content token observed," so a failure like that is diagnosable from the log line itself.
- **Receipt headers** (`x-vercel-id`, `cf-ray`, `x-request-id`, `anthropic-request-id`, etc.) captured from the response, for tracing a specific measured request back to the provider's own logs if a number is disputed

### Cold-phase breakdown

| Metric | Definition |
|---|---|
| `dnsMs` | Hostname resolution (`lookup` event on the request's socket) |
| `tcpMs` | TCP connect, measured from end of DNS to `connect` event |
| `tlsMs` | TLS handshake, measured from end of TCP connect to `secureConnect` event |
| `ttfbMs` | Request fully sent → first response byte |
| `ttftMs` | Request fully sent → first content token observed in the SSE stream |
| `coldE2eMs` | `dnsMs + tcpMs + tlsMs + ttftMs` — what a short-lived process (a serverless function, a CLI tool, an edge function) actually pays end to end for one request |

These are real socket timestamps, not estimates: Node's `https.request` exposes `lookup`/`connect`/`secureConnect` events directly on the underlying `TLSSocket` (`benchmarks/ai-gateway/phase-probe.ts`), so DNS/TCP/TLS are each timed from the actual connection lifecycle rather than inferred.

### Warm-phase metrics

Only `ttfbMs` and `ttftMs` apply — there is no `dnsMs`/`tcpMs`/`tlsMs`/`coldE2eMs` for a warm probe, since no new connection was opened for the measured request.

**Important distinction, stated explicitly because it's easy to misread:** "cold" here describes *our connection state to the gateway's edge*, not a provider-side model cold start. Every gateway and Anthropic's own API are effectively always warm from the provider's perspective — "cold" only means the benchmark process itself had no existing socket to reuse for that request.

## Request configuration (identical across every gateway)

- **Model**: Claude Haiku 4.5 for the ten Anthropic-family gateway-overhead participants — `anthropic/claude-haiku-4.5` via OpenRouter's and Vercel AI Gateway's catalog alias, `anthropic/claude-haiku-4-5` via LLM Gateway's provider-pinned catalog naming, `anthropic/claude-haiku-4-5-20251001` via Concentrate AI's provider-prefixed naming, `claude-haiku-4-5-20251001` via Cloudflare's, Anthropic's own, Pydantic AI Gateway's, and `anthropic/claude-haiku-4-5-20251001` via LLM API (`/v1/messages`, provider-prefixed with `X-No-Fallback: true`), `claude-haiku-4-5` via Neon AI Gateway (Pydantic proxies Anthropic's native API as-is, no gateway-specific model prefix), and `claude-haiku-4-5` via ngrok AI Gateway (`/v1/messages`). Ramp Router uses the account-specific catalog id `claude-haiku-4-5` via `/v1/responses`. Same underlying model, addressed the way each API expects it to be addressed. The OpenAI family uses `gpt-5.4-mini` instead — see [OpenAI family benchmark](#openai-family-benchmark); the Gemini family uses `gemini-3.6-flash` — see [Gemini family benchmark](#gemini-family-benchmark); the Kimi family uses `kimi-k3` — see [Kimi family benchmark](#kimi-family-benchmark).
- **Prompt**: `"Write a two-sentence description of how distributed systems handle partial failures."` — identical for every request, cold or warm, every participant in every family.
- **`max_tokens`**: 200. **`temperature`**: 0. Identical across all three families. **`stream`**: true (required for TTFT; also used for token-count extraction via `stream_options.include_usage` on the OpenAI-compatible path).
- **Timeout**: 45 seconds per request.

Four wire formats are in play, handled explicitly per participant (`AIGatewayProviderConfig.wireFormat` in `benchmarks/ai-gateway/types.ts`):

- **`openai`** (OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, Concentrate AI, Novita, Neon, ngrok AI Gateway, and LLM API in the Kimi family; OpenRouter, Vercel AI Gateway, LLM Gateway, Concentrate AI, ngrok AI Gateway, and LLM API in the Gemini family; OpenRouter in the Anthropic family) — OpenAI-compatible `/chat/completions` shape, `Authorization: Bearer <key>`. Kimi's own API is itself natively OpenAI-Chat-Completions-shaped (Moonshot's own design, not a third-party compatibility shim), so this format is a no-translation-layer native route for the Kimi participants that use it. For the Gemini family's six participants using this format, it genuinely is a translation layer — see [Gemini family benchmark](#gemini-family-benchmark) for why no native alternative was available. Ramp Router uses `responses` for Kimi because it has no `/chat/completions` route.
- **`anthropic`** (Cloudflare AI Gateway, Anthropic direct, Pydantic AI Gateway, Vercel AI Gateway, LLM Gateway, Neon AI Gateway, ngrok AI Gateway, and LLM API) — Anthropic's native `/v1/messages` shape. Auth header varies within this group: Cloudflare, Anthropic direct, and ngrok AI Gateway use `x-api-key` + `anthropic-version`; Pydantic AI Gateway, Vercel AI Gateway, LLM Gateway, and Neon AI Gateway use `Authorization: Bearer <key>` + `anthropic-version` instead — for Pydantic this was confirmed directly against a real request (its own auth failures return a same-shaped 401 regardless of which of the two header styles is wrong, so this took a few rounds of live testing to pin down precisely). Concentrate AI's `/v1/messages/` endpoint is documented as an "Anthropic Messages API compatibility endpoint" in its published OpenAPI spec (`concentrate.ai/docs/api-reference/openapi.json`), but has **not** been confirmed against a real successful response — see the note in `providers.ts` and in Limitations below.
- **`responses`** (Concentrate AI and Ramp Router in the Anthropic family; every participant in the OpenAI family; Ramp Router in the Kimi family — see [OpenAI family benchmark](#openai-family-benchmark)) — OpenAI's Responses API shape: flat `input` string instead of a `messages` array, `max_output_tokens` instead of `max_tokens`. For `openai-direct` this is the format's origin, called directly — OpenAI's current flagship endpoint (rather than the older Chat Completions surface). All OpenAI-family participants use it because they have a Responses passthrough.
- **`gemini`** (Gemini direct, Cloudflare AI Gateway, and Neon AI Gateway in the Gemini family) — Google's native `streamGenerateContent` shape: `contents[].parts[].text` instead of `messages`, `generationConfig.maxOutputTokens` instead of `max_tokens`, model id baked into the URL path rather than the request body, streaming selected by the `:streamGenerateContent` path segment (not a body flag), token counts read from `usageMetadata.candidatesTokenCount`.

TTFT detection is **per-wire-format**, not one shared pattern (`contentRegexFor` in `phase-probe.ts`): `openai` matches only `delta.content`, `anthropic` and `gemini` match `text` (`content_block_delta`'s `delta.text` and `parts[].text` respectively), `responses` matches the flat `delta` string. A single shared regex matching all of `content`/`text`/`delta` was used here previously, on the reasoning that no format's real content field shares a name with another format's — that held until Kimi K3 via OpenRouter and Vercel, confirmed live: both stream a `reasoning_details` array alongside the real answer, and each entry looks like `{"type":"reasoning.text","text":"…"}` — a genuine `"text":"…"` match, just on invisible reasoning, not the answer. The shared regex fired on that first reasoning token, so OpenRouter and Vercel's Kimi-family TTFT briefly measured "time to first reasoning token" (reported as low as 1.8s) while every other participant in that family correctly measured "time to first visible token" (20-40s) — a real correctness bug, caught by how anomalous the numbers looked next to a model with reasoning locked "always on." Restricting each format to only its genuine content field name removes the collision entirely, not just for Kimi — for any `openai`-format participant that might stream a similarly-shaped reasoning trace in the future.

That fix's default is "first visible token." A participant can deliberately opt back into "first reasoning token" via `AIGatewayProviderConfig.reasoningCountsAsFirstToken` — every `openai`-format entry in the Kimi family does, since `kimi-k3` runs with reasoning locked "always on," and "time to first visible token" for a model like that measures however long it chooses to deliberate rather than gateway/network responsiveness; "time to first reasoning token" is the closer proxy, and it's what every non-reasoning participant's TTFT already amounts to (reasoning and visible content start at the same moment when there's no separate reasoning phase). Confirmed live across all `openai`-format Kimi-family participants: exactly two reasoning-field conventions exist — `reasoning_content` (Moonshot direct, Cloudflare) and `reasoning` (OpenRouter, Vercel, LLM Gateway, Concentrate, Novita, Neon, and ngrok) — both handled explicitly rather than assumed to match. Ramp Router uses `responses` and does not expose reasoning tokens to this flag. One side effect worth knowing: `outputTokensPerSec` is computed over the time *after* `ttftMs`, so with `ttftMs` now marking the start of generation instead of a point deep into it, the Kimi family's tokens/sec reflects throughput across the whole reasoning-plus-answer stream, not just the visible portion the other families measure — not comparable across families for that reason, on top of the model differences already noted throughout this document. Token counts are extracted the same lightweight way (regex over the raw buffer, not a full SSE/JSON parser) — see Limitations.

Knowing when the stream has fully ended (needed for `ttfbMs`/`totalMs` and to safely reuse a warm connection) is handled by Node's own HTTP parser (`res.on('end')`), which understands `Content-Length` and chunked-transfer framing generically for any spec-compliant response. This differs from the reference implementation, which reads raw socket bytes and has to recognize completion itself via hand-matched byte sequences (`data: [DONE]`, `"type":"message_stop"`, the chunked terminator `\r\n0\r\n\r\n`) — a reasonable approach when working with raw sockets in Python, but one that has to be kept in sync with each gateway's exact stream-termination convention. Delegating that to Node's HTTP parser avoids needing to enumerate termination formats per gateway at all.

### Every gateway is hit directly — no gateway is proxied through another

This is the single most important fairness property of this benchmark, worth stating plainly: **Cloudflare AI Gateway is called via its own direct-to-Anthropic passthrough route** (`/v1/{account}/{gateway}/anthropic/v1/messages`), not routed through OpenRouter or any other intermediary. **OpenRouter and Vercel AI Gateway both route a catalog alias like `anthropic/claude-haiku-4.5` dynamically** — by default each picks the upstream provider (Anthropic, Bedrock, Vertex, or a reseller) per request based on its own price/uptime/latency policy, which would otherwise let a gateway's cold/warm numbers reflect a different provider's infra from one iteration to the next. Both set Anthropic as the preferred provider in the request body (`providers.ts`): OpenRouter via `provider: { order: ['anthropic'] }` ([docs](https://openrouter.ai/docs/features/provider-routing)), Vercel AI Gateway via `providerOptions: { gateway: { order: ['anthropic'] } }` on its REST/OpenAI-compatible path ([docs](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)) — a preference, not a hard restriction: if Anthropic itself is unavailable, the gateway automatically falls back to another upstream rather than failing the iteration. To keep that fallback from blending silently into a gateway's numbers, both gateways' actually-serving provider is captured per iteration as `resolvedProvider` (confirmed live against real requests: OpenRouter carries a top-level `"provider":"Anthropic"` on every SSE chunk; Vercel carries `resolvedProvider` inside `provider_metadata.gateway.routing` on its final chunk) — a run where either gateway had to fall back off Anthropic is visible and filterable in the results JSON and in the live run log (`⚠ fell back to <provider>`), rather than silently mixing another provider's latency into that gateway's stats. **LLM Gateway**'s model id is provider-pinned by naming convention (`anthropic/claude-haiku-4-5`) so its requests route to Anthropic itself rather than to a different host of the same model; this was confirmed directly against a real request, whose response `metadata` block explicitly reports `used_provider: "anthropic"`, `used_model: "claude-haiku-4-5"`. **Pydantic AI Gateway proxies Anthropic's native API directly** (`/proxy/anthropic/v1/messages`, native model ID `claude-haiku-4-5-20251001`, no gateway-specific routing prefix) — confirmed with a real request returning a genuine Anthropic response (`"model":"claude-haiku-4-5-20251001"`, real `usage`/`cost_estimate` fields from Pydantic's own accounting). **Concentrate AI** is called via its own `/v1/messages/` endpoint with the model provider-pinned (`anthropic/claude-haiku-4-5-20251001`, its provider-prefix syntax) so the request routes to Anthropic itself rather than to Azure or Bedrock — both of which its "model fortress" catalog also lists as routing options for this same model (`anthropic/claude-haiku-4-5`, `azure/claude-haiku-4-5`, `bedrock/claude-haiku-4-5`). **LLM API** is provider-pinned by naming convention (`anthropic/claude-haiku-4-5-20251001`) and sends `X-No-Fallback: true` so requests stay on Anthropic; `extractResolvedProvider` logs the upstream provider from the response if exposed (`provider`, `resolvedProvider`) or derives it from the `model` prefix. `anthropic-direct` calls Anthropic's API with no gateway at all, as the no-gateway control — it isolates how much latency each gateway adds on top of the underlying provider.

A gateway that's itself proxied through a second gateway would have that second hop's latency baked into its numbers, misattributed to the outer gateway. That's not happening here — every participant's number reflects that gateway's own overhead only.

## OpenAI family benchmark

`ai-gateway-openai.bench.ts` + `providers-openai.ts` run the same harness (same task, phases, prompt, scoring, request configuration — see `shared-task.ts`) with every participant routed to OpenAI's `gpt-5.4-mini` instead of Anthropic's Claude Haiku 4.5. It has its own no-gateway `openai-direct` control (OpenAI's own Responses API, `/v1/responses`) and its own results directory (`results/ai-gateway-latency/openai/`) — see [Running it](#running-it).

**Every participant in this family uses the OpenAI Responses API.** The policy remains: use a gateway's Responses passthrough if it has one (Responses is OpenAI's own format, so proxying it natively adds no translation layer — the same reasoning that picked `/v1/messages` over the OpenAI-compatible route for the Anthropic family's Cloudflare/Pydantic/LLM Gateway/Vercel entries), fall back to Chat Completions only where no Responses route is documented. **Novita is excluded from this family** — its catalog does not list OpenAI models, so it would fail at runtime.

An earlier pass of this file got Cloudflare's path wrong by extrapolating its Anthropic convention onto its OpenAI docs instead of checking each route individually (Cloudflare's path turned out to drop the `v1` segment its Anthropic route keeps). Every route below was re-verified directly against that gateway's own OpenAI-specific docs, and a follow-up pass specifically re-checked **streaming support** on each Responses passthrough — path correctness and streaming correctness are separate claims, and confirming one doesn't confirm the other:

| Gateway | Model / routing | Path confidence | Streaming confidence |
|---|---|---|---|
| OpenRouter | `openai/gpt-5.4-mini` via `/api/v1/responses`, `provider: { order: ['openai'] }` | High — confirmed directly (openrouter.ai/docs/api_reference/responses/overview) | High — OpenRouter's own docs state streaming uses "native SSE passthrough (same event format as OpenAI)" for this endpoint specifically |
| Vercel AI Gateway | `openai/gpt-5.4-mini` via `/v1/responses` | High — confirmed via Vercel's own changelog | High — same changelog explicitly lists streaming as supported |
| Cloudflare AI Gateway | `gpt-5.4-mini` via `/v1/{account}/{gateway}/openai/responses` | High — confirmed directly against Cloudflare's own OpenAI provider docs, listed explicitly alongside the chat/completions path. Does **not** keep the `v1` segment the Anthropic path does — Cloudflare's framing is "replace `https://api.openai.com/v1` with the gateway prefix" wholesale, not uniform across providers | Unconfirmed for this specific endpoint — Cloudflare's own example requests for `/responses` only show non-streaming bodies (`model`+`input`, no `stream`); a general "AI Gateway supports streaming" statement exists platform-wide but isn't `/responses`-specific |
| LLM Gateway | `openai/gpt-5.4-mini` via `/v1/responses` | High — LLM Gateway's own Codex CLI guide states outright "Codex CLI uses the OpenAI Responses API (`/v1/responses`)" against base URL `api.llmgateway.io/v1` | Unconfirmed — not mentioned in their Codex guide either way. **Separately**: that same guide documents a hard failure mode, `"The Responses API requires data retention to be enabled"`, unless the backing OpenAI org has "Retain All Data" turned on — mitigated by sending `store: false` on every Responses request (see `phase-probe.ts`), but if the failure persists it means this specific gateway forces its own `store` value regardless of what we send |
| Concentrate AI | `openai/gpt-5.4-mini` via `/v1/responses/` | High for the model syntax (confirmed on Concentrate's own model catalog) | Carries the same unconfirmed-against-a-real-response caveat this endpoint already has for the Anthropic entry (see `providers.ts`) |
| Pydantic AI Gateway | `gpt-5.4-mini` via `/proxy/openai-responses/responses` | High — Pydantic's own docs list both `/proxy/chat/` and `/proxy/openai-responses` for its gateway; path derived from Codex `base_url` example | Unconfirmed on the OpenAI Responses path specifically, but same proxy code as the Anthropic path confirmed live |
| Ramp Router | `gpt-5.4-mini` via `/v1/responses` | High — Ramp Router exposes one OpenAI Responses-compatible endpoint at `https://router-api.ramp.com/v1` (router.ramp.com/docs) | High — Responses streaming is documented as supported across providers |
| Neon AI Gateway | `gpt-5-4-mini` via `/openai/v1/responses` | High — confirmed directly in Neon's OpenAI Responses docs (neon.com/docs/ai-gateway/openai-responses) | High — docs include a streaming example with `stream: true` |
| ngrok AI Gateway | `gpt-5.4-mini` via `/v1/responses` | Medium — ngrok's OpenAI provider page only documents `/v1/chat/completions`, but the SDKs feature table lists Responses API support. Following the OpenAI-family convention of `/v1/responses`; it will fail at runtime if that passthrough is not actually available. | Unconfirmed — no streaming documentation for the Responses path specifically. |
| LLM API | `openai/gpt-5.4-mini` via `/v1/responses`, `X-No-Fallback: true` | Medium — the `/v1/responses` endpoint is present on `api.llmapi.ai`, and the `provider/model` prefix pinning is documented at https://docs.llmapi.ai/features/routing; `store: false` is sent by `phase-probe.ts` like every other Responses request | Unconfirmed — no public documentation specifically covers the Responses API streaming path on LLM API, so provider-pinning behavior on this endpoint is assumed to carry over from the documented `/v1/chat/completions` surface |

**Every Responses API request in this repo sets `store: false`** (`phase-probe.ts`) — these are one-shot probes with no need for OpenAI's default 30-day response retention, and it's the documented way to opt out of the data-retention requirement noted for LLM Gateway above rather than depend on an org-level setting this benchmark doesn't control.

Full rationale for each entry lives in `providers-openai.ts`'s per-provider comments, matching the style already used in `providers.ts`.

## Gemini family benchmark

`ai-gateway-gemini.bench.ts` + `providers-gemini.ts` run the same harness (same task, phases, prompt, scoring, request configuration — see `shared-task.ts`) with participants routed to Google's `gemini-3.6-flash` instead of Anthropic's Claude Haiku 4.5. It has its own no-gateway `gemini-direct` control (Google's native `streamGenerateContent` endpoint) and its own results directory (`results/ai-gateway-latency/gemini/`) — see [Running it](#running-it).

**Two gateways get the native `wireFormat: 'gemini'` treatment: Cloudflare AI Gateway and Neon AI Gateway.** Unlike the OpenAI family, where most gateways turned out to have a native Responses passthrough, OpenRouter, Vercel AI Gateway, LLM Gateway, Concentrate AI, ngrok AI Gateway, and LLM API show no documented native Gemini passthrough (in contrast to their confirmed native Anthropic Messages / OpenAI Responses routes used elsewhere in this repo) — each is built around one normalized endpoint across its whole catalog instead. Those six route through that OpenAI-compatible `/chat/completions` surface with the family target model, translating where the gateway can or failing at runtime if it cannot.

**Pydantic AI Gateway, Novita, and Ramp Router are excluded from this family.** Pydantic's own docs state its `gateway` provider mode for Google routes to **Vertex AI**, not the native Gemini API — a different serving stack than every other participant here (and than `gemini-direct` itself). Novita's catalog doesn't list Gemini models, and Ramp Router has no Gemini provider. Including any of them would either measure a different backend or fail at runtime, so they're left out entirely rather than included with an asterisk.

| Gateway | Model / routing | Confidence |
|---|---|---|
| OpenRouter | `google/gemini-3.6-flash` via `/api/v1/chat/completions`, `provider: { order: ['google'] }` | High — OpenRouter's provider/model catalog convention, same provider-order pinning mechanism confirmed for the Anthropic and OpenAI families |
| Vercel AI Gateway | `google/gemini-3.6-flash` via `/v1/chat/completions` | High — confirmed `creator/model-name` convention; no native passthrough documented for Gemini specifically, unlike Vercel's confirmed Anthropic/OpenAI native routes |
| Cloudflare AI Gateway | `gemini-3.6-flash` via `/v1/{account}/{gateway}/google-ai-studio/v1/models/gemini-3.6-flash:streamGenerateContent?alt=sse` | High — confirmed directly against Cloudflare's own `google-ai-studio` provider docs, which describe substituting the REST resource name (`generateContent`/`streamGenerateContent`) after the model id, same pattern as calling Google directly |
| LLM Gateway | `google-ai-studio/gemini-3.6-flash` via `/v1/chat/completions` | Medium — provider-prefix convention inferred from LLM Gateway's own catalog URL structure (`llmgateway.io/models/gemini-3.6-flash/google-ai-studio`), not independently confirmed as the literal request-body pin string |
| Concentrate AI | `google/gemini-3.6-flash` via `/v1/chat/completions/` | Lower — Concentrate's routing is litellm-based, and litellm's own convention for Google's API-key route is the abbreviation `gemini/` rather than `google/` (unprefixed ids default to Vertex AI per litellm's docs); Concentrate may or may not preserve that exact abbreviation for its own API. Worth confirming with a live request before trusting this entry specifically |
| Neon AI Gateway | `gemini-3-6-flash` via `/gemini/v1beta/models/gemini-3-6-flash:streamGenerateContent?alt=sse` | High — confirmed directly in Neon's Gemini API docs (neon.com/docs/ai-gateway/gemini) |
| ngrok AI Gateway | `gemini-3.6-flash` via `/v1/chat/completions` | High — ngrok's Google-provider docs explicitly say to call `/v1/chat/completions` with an OpenAI client and change only the model name; they note the native Gemini `generateContent` API and OpenAI Responses API do not reach Google models |
| LLM API | `google-ai-studio/gemini-3.6-flash` via `/v1/chat/completions`, `X-No-Fallback: true` | Medium — the `provider/model` prefix is documented at https://docs.llmapi.ai/features/routing and matches the `google-ai-studio` provider in the `/v1/models` catalog; streaming behavior on this OpenAI-compatible route has not been confirmed live |

Confirmed live (with real credentials): `gemini-direct`'s request reached Google's API successfully — the response was a 429 on exhausted prepayment credits, not a validation error, meaning the request shape (path, model id, body) was accepted as well-formed. Full content streaming wasn't verified beyond that point; re-run once the backing account has credits.

Full rationale for each entry lives in `providers-gemini.ts`'s per-provider comments, matching the style already used in `providers.ts` and `providers-openai.ts`.

## Kimi family benchmark

`ai-gateway-kimi.bench.ts` + `providers-kimi.ts` run the same task, phases, and scoring as the other families, with participants routed to Moonshot's `kimi-k3` instead of Anthropic's Claude Haiku 4.5. It has its own no-gateway `kimi-direct` control and its own results directory (`results/ai-gateway-latency/kimi/`) — see [Running it](#running-it). `kimi-k3` is Moonshot's only current flagship model (no fast/lite tier as of this writing) and runs with reasoning locked to "always on," which — confirmed live — forces real request-configuration and measurement exceptions on top of the model swap:

- **`temperature` is omitted entirely**, not set to 0: `kimi-k3` rejects any value except 1 outright (`"invalid temperature: only 1 is allowed for this model"`), confirmed against Moonshot's own API directly.
- **`max_tokens: 2000`, not 200**: reasoning tokens count against this budget. One live test consumed 688 of 802 total completion tokens on reasoning alone; at 200, the entire budget was exhausted by reasoning with zero visible output (`finish_reason: "length"`, no content deltas at all).
- **`timeoutMs: 90_000`, not 45s**: reasoning also costs wall-clock time before any visible content appears, independent of the token budget. One live warm-phase probe measured `ttft=21395ms`; a cold probe (DNS/TCP/TLS plus that same reasoning delay) timed out entirely at the default 45s. This is about total request completion time, not first-token time, so it stays necessary even after the next point.
- **`reasoningCountsAsFirstToken: true` on every `openai`-format participant**: `ttftMs` measures time to the first *reasoning* token, not the first *visible* one — deliberately, not a bug this time (see [Request configuration](#request-configuration-identical-across-every-gateway) for the false-positive bug this same field distinction caught earlier, which is a different thing). "Time to first visible token" for an always-reasoning model measures however long it chooses to deliberate, not gateway/network responsiveness; "time to first reasoning token" is the closer proxy, and it's what every non-reasoning participant's TTFT already amounts to. Ramp Router uses the Responses API, which doesn't expose reasoning tokens to this flag.

Unlike the OpenAI family's GPT-5-mini situation, there's no non-reasoning Kimi tier to switch to instead, so all of these are permanent for this family, not temporary workarounds — see `AIGatewayProviderConfig.reasoningCountsAsFirstToken` in `types.ts`. None of this is a fairness problem: every participant in the family gets the identical exceptions, so a difference between two Kimi-family participants is still attributable to that gateway's own overhead. It does mean the Kimi family's `ttftMs` and `outputTokensPerSec` aren't directly comparable to the other three families' — see [Request configuration](#request-configuration-identical-across-every-gateway) for why.

**Almost every participant uses `wireFormat: 'openai'`, and unlike the Gemini family, that's not a translation layer here.** Kimi's own native API is itself OpenAI-Chat-Completions-shaped (Moonshot's own design, not a third-party compatibility shim — confirmed by `kimi-direct` itself using this same format directly against Moonshot's API), so every gateway below reaches Moonshot without any format conversion. Ramp Router is the exception: it only exposes a Responses API, so it uses `wireFormat: 'responses'` with `/v1/responses`.

**One gateway is excluded**, for the same reason Pydantic was excluded from the Gemini family — a confirmed different backend, not just an unconfirmed one: **Pydantic AI Gateway**'s documented provider list (OpenAI, Anthropic, Vertex, Groq, Bedrock) has no Moonshot entry.

**Cloudflare AI Gateway is included, despite an earlier version of this section excluding it** — that exclusion was based on incomplete research (only `@cf/moonshotai/kimi-k2.7-code`, a genuinely Cloudflare-hosted checkpoint via Workers AI, had been found). Cloudflare's Workers AI catalog also lists `moonshotai/kimi-k3` itself as a "Third-party" model (no `@cf/` prefix), reached through a newer unified endpoint — `api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions`, not `gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...` like every other family's Cloudflare entry. It's still the AI Gateway product, though, not a separate one: confirmed live, a third-party model request with no `cf-aig-gateway-id` header silently auto-routes through an auto-created "default" gateway instead of a named one, invisible in that named gateway's own dashboard/logs — so this entry sends `cf-aig-gateway-id: {CLOUDFLARE_AI_GATEWAY_GATEWAY_ID}` explicitly to land in the same named gateway every other family's Cloudflare entry uses. Cloudflare's own account credentials are the only auth required (no separate `KIMI_API_KEY` gets forwarded). Also confirmed live: a real streamed response, `reasoning_content` field shape matching `kimi-direct`'s own native format. Cloudflare's own docs don't clarify whether this reaches Moonshot's infrastructure directly or a reseller behind the scenes — the confirmed-live response shape is consistent with genuine Moonshot output, but that's the ceiling of what's actually verified.

**Provider-order pinning matters more here than for any other family.** Kimi K3 is open-weight, so — unlike Anthropic's or OpenAI's closed models — multiple third-party infrastructure providers can serve it. Confirmed live evidence: Vercel's own changelog states K3 is served "from US-based providers... including Baseten and Fireworks," and LLM Gateway's catalog page lists six separate providers for this model. Every gateway below that supports pinning uses it.

| Gateway | Model / routing | Confidence |
|---|---|---|
| OpenRouter | `moonshotai/kimi-k3` via `/api/v1/chat/completions`, `provider: { order: ['moonshotai'] }` | **Confirmed live** — also the gateway that surfaced a real TTFT-detection bug (see below): its Kimi responses stream `reasoning_details[].text` alongside the answer, which briefly false-triggered this benchmark's content-detection regex on the first reasoning token instead of the first visible one. Fixed in `phase-probe.ts`; re-verified live afterward |
| Vercel AI Gateway | `moonshotai/kimi-k3` via `/v1/chat/completions`, `providerOptions.gateway.order: ['moonshotai']` | **Confirmed live** — hit the identical `reasoning_details[].text` false-positive as OpenRouter (confirmed live to have the exact same response shape); same fix, same re-verification |
| Cloudflare AI Gateway | `moonshotai/kimi-k3` via `api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions` | **Confirmed live** — a real streamed response |
| LLM Gateway | `moonshot/kimi-k3` via `/v1/chat/completions` | High — confirmed directly on LLM Gateway's own model page. Note the provider slug is `moonshot`, not `moonshotai` as on OpenRouter/Vercel/Cloudflare — a real cross-gateway naming inconsistency, each verified independently rather than assumed to match |
| Concentrate AI | `moonshot/kimi-k3` via `/v1/chat/completions/` | Lower — `kimi-k3` confirmed present in Concentrate's catalog, but the exact provider-prefixed pin string wasn't shown there; inferred from this gateway's established creator-prefix convention and litellm's canonical Moonshot slug (Concentrate's routing is litellm-based). Worth confirming with a live request before trusting this entry |
| Novita | `moonshotai/kimi-k3` via `/openai/v1/chat/completions` | Medium — Novita's model catalog lists `moonshotai/kimi-k3`; the `/openai/v1/chat/completions` path follows Novita's OpenAI-compatible API documented at novita.ai/docs |
| Ramp Router | `accounts/fireworks/models/kimi-k3` via `/v1/responses` | Medium — `accounts/fireworks/models/kimi-k3` is the bare `id` from GET /v1/models; the `provider:provider-model` form is only for the `models` fallback array (see router.ramp.com/docs/guides/choose-a-model) |
| Neon AI Gateway | `kimi-k3` via `/v1/chat/completions` | High — confirmed directly in Neon's chat-completions docs (neon.com/docs/ai-gateway/chat-completions) |
| ngrok AI Gateway | `kimi-k3` via `/v1/chat/completions` | Medium — ngrok's model catalog lists Moonshot AI and the `/v1/chat/completions` route is its documented OpenAI-compatible passthrough; not yet confirmed live |
| LLM API | `moonshot/kimi-k3` via `/v1/chat/completions`, `X-No-Fallback: true` | Medium — `moonshot/kimi-k3` is the provider-prefixed model id in LLM API's `/v1/models` catalog (provider `moonshot`); uses the same `temperature: undefined` and `reasoningCountsAsFirstToken: true` overrides as the other Kimi-family `openai`-format entries; `extractResolvedProvider` logs the upstream provider from the response |

`kimi-direct`, Cloudflare, OpenRouter, and Vercel are all confirmed live; LLM Gateway and Concentrate are docs-confirmed only — worth a smoke test across those two before trusting results. See [Request configuration](#request-configuration-identical-across-every-gateway) for the TTFT-detection bug OpenRouter and Vercel surfaced and how it was fixed.

Full rationale for each entry lives in `providers-kimi.ts`'s per-provider comments, matching the style already used in `providers.ts`, `providers-openai.ts`, and `providers-gemini.ts`.

## How the runner behaves

### Round-robin across gateways — and what that does and doesn't mean

Iterations run **round-robin across every active participant**, not sequentially per participant (`groupBy: 'round'`, set in each family's own `defineBenchmarkConfig` call, identical across every family benchmark):

```
round 1: openrouter → vercel-ai-gateway → cloudflare-ai-gateway → llmgateway → pydantic-ai-gateway → concentrate-ai-gateway → novita → ramp → neon → ngrok → llmapi → anthropic-direct
round 2: openrouter → vercel-ai-gateway → cloudflare-ai-gateway → llmgateway → pydantic-ai-gateway → concentrate-ai-gateway → novita → ramp → neon → ngrok → llmapi → anthropic-direct
...
```

This is purely about **execution order in time**. Instead of running all of one gateway's iterations back-to-back and then moving to the next gateway (where the last gateway tested could be unfairly affected by, say, a network blip or a provider's load spike five minutes into the run), every gateway gets its Nth iteration at roughly the same point in time as every other gateway's Nth iteration. No gateway's numbers are systematically favored by running earlier, later, or during a different network condition than the others.

Within each round the gateways run concurrently up to `concurrency: providers.length`, while the rounds themselves stay sequential. This keeps the per-round fairness intact but removes the multiplicative runtime cost of the number of gateways, so iteration counts can be raised for better statistics without a proportional wall-clock increase.

Round-robin only interleaves *which gateway's turn it is next*; it never affects what "warm" means for any individual gateway.

### What one warm iteration actually does

Each warm iteration is fully self-contained: open a fresh keep-alive connection → send a throwaway request and let it complete (discarded) → send and measure a second request on that same socket → close the connection. This repeats independently for every warm iteration, for every gateway. It is **not** one connection held open across the entire warm phase or across rounds — each warm iteration re-establishes its own connection, then proves the reuse benefit once, then tears it down. This matches the "connection-pool case" the benchmark is trying to isolate: the saving from *not* paying DNS/TCP/TLS on a repeat request, sampled repeatedly and independently rather than measured once over a long-lived session.

## Scoring

A composite score (0–100, higher is better) combines the two latency axes that matter most in practice with throughput and reliability (`benchmarks/ai-gateway/scoring.ts`):

```
score = (
    0.30 × score(coldE2eMs.median)
  + 0.15 × score(coldE2eMs.p95)
  + 0.30 × score(warmTtftMs.median)
  + 0.15 × score(warmTtftMs.p95)
  + 0.10 × score(outputTokensPerSec.median)
) × successRate
```

- `score(latencyMs)` — 0ms → 100, 20,000ms → 0, linear, clamped to 0.
- `score(tokensPerSec)` — ≤5 tok/s → 0, ≥200 tok/s → 100, linear between.
- `successRate` — fraction of iterations that completed without error. A gateway that's fast but flaky is penalized multiplicatively, same as every other benchmark category in this repo.

Cold E2E and warm TTFT are weighted equally (30% median + 15% p95 each) because both the short-lived-process case and the steady-state case are real, common usage patterns — this benchmark doesn't privilege one over the other.

## Running it

```bash
# Anthropic family — all eleven participants (ten gateway-overhead + anthropic-direct),
# default 10 cold + 10 warm iterations each
pnpm run bench:ai-gateway

# One participant
pnpm run bench:ai-gateway:openrouter
pnpm run bench:ai-gateway:vercel
pnpm run bench:ai-gateway:cloudflare
pnpm run bench:ai-gateway:llmgateway
pnpm run bench:ai-gateway:pydantic
pnpm run bench:ai-gateway:concentrate
pnpm run bench:ai-gateway:novita
pnpm run bench:ai-gateway:ramp
pnpm run bench:ai-gateway:neon
pnpm run bench:ai-gateway:ngrok
pnpm run bench:ai-gateway:llmapi
pnpm run bench:ai-gateway:anthropic

# OpenAI family — ten gateways + openai-direct, routed to gpt-5.4-mini instead
pnpm run bench:ai-gateway-openai
pnpm run bench:ai-gateway-openai:openrouter
pnpm run bench:ai-gateway-openai:vercel
pnpm run bench:ai-gateway-openai:cloudflare
pnpm run bench:ai-gateway-openai:llmgateway
pnpm run bench:ai-gateway-openai:concentrate
pnpm run bench:ai-gateway-openai:pydantic
pnpm run bench:ai-gateway-openai:ramp
pnpm run bench:ai-gateway-openai:neon
pnpm run bench:ai-gateway-openai:ngrok
pnpm run bench:ai-gateway-openai:llmapi
pnpm run bench:ai-gateway-openai:direct

# Gemini family — eight gateways (Pydantic, Novita, and Ramp Router excluded — see Gemini family benchmark above)
# + gemini-direct, routed to gemini-3.6-flash
pnpm run bench:ai-gateway-gemini
pnpm run bench:ai-gateway-gemini:openrouter
pnpm run bench:ai-gateway-gemini:vercel
pnpm run bench:ai-gateway-gemini:cloudflare
pnpm run bench:ai-gateway-gemini:llmgateway
pnpm run bench:ai-gateway-gemini:concentrate
pnpm run bench:ai-gateway-gemini:neon
pnpm run bench:ai-gateway-gemini:ngrok
pnpm run bench:ai-gateway-gemini:llmapi
pnpm run bench:ai-gateway-gemini:direct

# Kimi family — ten gateways (no Pydantic — see Kimi family benchmark above)
# + kimi-direct, routed to kimi-k3
pnpm run bench:ai-gateway-kimi
pnpm run bench:ai-gateway-kimi:openrouter
pnpm run bench:ai-gateway-kimi:vercel
pnpm run bench:ai-gateway-kimi:cloudflare
pnpm run bench:ai-gateway-kimi:llmgateway
pnpm run bench:ai-gateway-kimi:concentrate
pnpm run bench:ai-gateway-kimi:novita
pnpm run bench:ai-gateway-kimi:ramp
pnpm run bench:ai-gateway-kimi:neon
pnpm run bench:ai-gateway-kimi:ngrok
pnpm run bench:ai-gateway-kimi:llmapi
pnpm run bench:ai-gateway-kimi:direct

# Custom iteration count (applies to both cold and warm) — works the same way for every family
pnpm run bench:ai-gateway -- --iterations 20
pnpm run bench:ai-gateway-openai -- --iterations 20
pnpm run bench:ai-gateway-gemini -- --iterations 20
pnpm run bench:ai-gateway-kimi -- --iterations 20

# Asymmetric cold/warm split, or isolating one phase entirely
# (a phase with 0 iterations is skipped)
npx tsx benchmarks/ai-gateway/ai-gateway.bench.ts --ai-gateway-iterations-cold 20 --ai-gateway-iterations-warm 0
npx tsx benchmarks/ai-gateway/ai-gateway-openai.bench.ts --ai-gateway-iterations-cold 20 --ai-gateway-iterations-warm 0
```

Required environment variables (`benchmarks/.env.example`): `OPENROUTER_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `LLM_GATEWAY_API_KEY`, `CONCENTRATE_AI_GATEWAY_API_KEY` are shared across all four families (same gateway accounts, just routed to a different target model each time). `CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_GATEWAY_ID`, and `CLOUDFLARE_AI_GATEWAY_TOKEN` are all **required** by every family's Cloudflare entry (the Kimi family's entry uses a different Cloudflare endpoint than the other three, and is the only one where the token is the *sole* auth — no separate per-family key is forwarded there — but all four now require Authenticated Gateway mode, not just Kimi). `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN` are used across all four families. `NGROK_AI_GATEWAY_API_KEY` is used by all four families (Anthropic, OpenAI, Gemini, and Kimi). `LLMAPI_API_KEY` is used by all four families (Anthropic, OpenAI, Gemini, and Kimi). `PYDANTIC_AI_GATEWAY_API_KEY` is used by the Anthropic and OpenAI families — the Gemini and Kimi families exclude Pydantic. `NOVITA_API_KEY` is used by the Anthropic and Kimi families — OpenAI and Gemini exclude Novita. `RAMP_ROUTER_API_KEY` is used by the Anthropic, OpenAI, and Kimi families — Gemini excludes Ramp Router. `ANTHROPIC_API_KEY` is used by the Anthropic family (Cloudflare's passthrough + `anthropic-direct`); `OPENAI_API_KEY` by the OpenAI family (Cloudflare's passthrough + `openai-direct`); `GEMINI_API_KEY` by the Gemini family (Cloudflare's passthrough + `gemini-direct`); `KIMI_API_KEY` by the Kimi family (`kimi-direct` only — Cloudflare's Kimi entry doesn't need it). Missing credentials cause that participant to be reported as `SKIPPED` rather than failing the run.

## Output

Each family writes to its own results directory under `results/ai-gateway-latency/`: the Anthropic family to `results/ai-gateway-latency/anthropic/YYYY-MM-DD.json` (copied to `results/ai-gateway-latency/anthropic/latest.json`), the OpenAI family to `results/ai-gateway-latency/openai/...`, the Gemini family to `results/ai-gateway-latency/gemini/...`, the Kimi family to `results/ai-gateway-latency/kimi/...`. Every iteration's phase timings, token counts, resolved provider (for OpenRouter/Vercel AI Gateway, see above), and receipt headers are preserved in full — enough to trace any specific measured request back to its provider-side request ID.

```bash
pnpm run generate-ai-gateway-svg          # Anthropic family -> ai-gateway.svg
pnpm run generate-ai-gateway-openai-svg   # OpenAI family -> ai-gateway-openai.svg
pnpm run generate-ai-gateway-gemini-svg   # Gemini family -> ai-gateway-gemini.svg
pnpm run generate-ai-gateway-kimi-svg     # Kimi family -> ai-gateway-kimi.svg
```
Each produces a ranked comparison table (score, cold E2E, warm TTFT, tokens/sec, success rate) for its own family only — families are never combined into one table, consistent with results from different families not being directly comparable (see the top of this document).

## Comparison to the reference implementation

Since the core methodology is adapted from [rbadillap/ai-gateways-benchmark](https://github.com/rbadillap/ai-gateways-benchmark), here's exactly where this implementation matches it and where it deliberately diverges, so the divergences read as intentional decisions rather than gaps.

**Matches exactly:**

- The phase model: DNS → TCP → TLS → TTFB → TTFT → cold E2E, with the same `dns + tcp + tls + ttft` formula (not double-counting TTFB, since TTFT already occurs after it).
- Warm methodology: a throwaway request discarded, then a second request measured on the same reused socket.
- Round-robin execution: interleave every gateway per round rather than finishing one gateway before starting the next.
- The TTFT-detection regex (`"(?:content|text)"\s*:\s*"[^"]`), which matches both OpenAI's and Anthropic's streaming delta fields — used as-is from the reference.
- The "cold ≠ provider-side cold start" distinction, stated in both.
- Receipt-header capture (`x-vercel-id`, `cf-ray`, `x-request-id`, etc.) for tracing a specific measured request.
- No TLS session resumption between cold connections. The reference guarantees this with a fresh `SSLContext` per connection; we use a fresh `https.Agent` per cold call instead. We verified this empirically rather than assuming it: six consecutive cold connections to the same host held steady at ~43–46ms TLS handshake time with no drop after the first call — a resumed handshake would show a sharp drop after connection 1, since it skips certificate verification and asymmetric key exchange.

**Deliberately different** (all decided earlier in this benchmark's design, not accidental):

| | Reference | This implementation | Why |
|---|---|---|---|
| Default sample size | 5 cold + 5 warm iterations | 10 cold + 10 warm iterations | Tighter medians at the cost of a longer run and more paid API calls per run |
| Cloudflare routing | Proxied through OpenRouter | Direct Anthropic passthrough, no intermediary | Isolates each gateway's own overhead in isolation, at the cost of not showing the chained-gateway scenario |
| Participants | 3 gateways, no baseline | 3 gateways + a direct-to-Anthropic control | Measures how much latency each gateway adds on top of the underlying provider |
| Prompt / `max_tokens` | `"Reply with: pong"`, 16 tokens | Longer prompt, 200 tokens | Needed a real generation to measure tokens/sec |
| Tokens/sec | Not measured | Measured | Extends the reference's latency-only scope |
| Ranking | None — a medians table only | 0–100 composite score | Matches this repo's convention for every other benchmark category; full raw stats are still preserved so anyone can compute their own ranking from the JSON |
| Harness | Raw sockets (no higher-level DNS/TCP/TLS timing API in Python) | Node's `https.request`, listening on the socket's `lookup`/`connect`/`secureConnect` events | Equivalent timestamps without hand-rolling socket/TLS handling |
| Stream-end detection | Hand-matched byte markers per gateway (`data: [DONE]`, `"type":"message_stop"`, chunked terminator) | Node's HTTP parser (`res.on('end')`) | Framing-generic — doesn't need to enumerate each gateway's termination convention |

## Limitations

- **Vantage-point dependent.** Results are a property of wherever the benchmark process runs — its network, region, and ISP — not a global ranking. Scheduled/dispatched runs execute from a single fixed location, Namespace's `namespace-profile-default` runners in **Northern Virginia, US** (see the callout at the top of this document) — not a distributed or multi-region measurement. A gateway with infrastructure closer to Northern Virginia has a structural advantage in every cold-connection and DNS/TCP/TLS number here; the same benchmark run from, say, Frankfurt or Singapore could plausibly reorder the ranking. We do not pin to any gateway's region or give any participant a network advantage relative to the others *at this vantage point* — every gateway is called with the same code, from the same machine, in the same run — but the vantage point itself is not neutral with respect to gateways whose infrastructure is regionally concentrated.
- **"Cold" is about our connection, not the provider's infrastructure.** See the explicit distinction above — this benchmark does not and cannot measure a provider-side model cold start.
- **A gateway may route a given model request to different upstream regions or replicas across requests.** Per-request TTFT reflects whichever upstream instance actually served that specific request, which can vary independent of the gateway's own routing overhead. Repeated iterations (and the p95 metric specifically) exist to surface that variance rather than hide it.
- **Token counts are extracted via a lightweight regex over the raw SSE buffer**, not a full spec-compliant SSE/JSON parser — a deliberate choice to keep the measurement hot path cheap and avoid adding parsing latency to the very timings being measured. If a gateway's streaming JSON format ever falls outside what the regex expects, the affected iteration's token count (and only the token count — never TTFB/TTFT/connection timings, which are captured independently) comes back as `undefined` and is excluded from the tokens/sec summary rather than reported as an incorrect number.
- **No retries.** A failed request counts against that gateway's success rate for that iteration; we do not retry and then report the retry's timing.
- **`dnsMs` reflects the OS resolver's cache, not a fresh lookup, for most cold iterations.** Node's `dns.lookup()` goes through the OS resolver (macOS's mDNSResponder, systemd-resolved, etc.), which caches answers for their TTL — outside our process's control, and true of any HTTP client on any platform (the reference implementation's raw `getaddrinfo()` call is equally subject to it). In a real run we observed exactly this: one gateway showed `dnsMs` of 35.77ms on iteration 1 and ~1ms on the other 19; another showed three elevated values scattered through the run (consistent with a shorter DNS TTL expiring and re-resolving mid-run). Since most cold iterations hit a warm cache, the reported `dnsMs.median` reflects OS-cached lookup time, not genuinely cold DNS resolution — only the rare cache-miss iterations show the real cost. `coldE2eMs` is unaffected in aggregate (it always sums that iteration's actual `dnsMs`, whatever it was), but the `dnsMs` column specifically should be read as "cached lookup, occasionally a real one" rather than "cold DNS, every time."