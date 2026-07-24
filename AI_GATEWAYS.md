# AI Gateway Benchmark

This document describes the **AI gateway benchmark** — a phase-by-phase latency, throughput, and reliability comparison of OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, and Pydantic AI Gateway, measured against a direct-to-Anthropic baseline.

> **Where this runs**: scheduled and dispatched runs execute in GitHub Actions on [Namespace](https://namespace.so) runners (`namespace-profile-default`), physically placed in **Northern Virginia, US**. This is a single fixed vantage point, not a global or multi-region measurement — every number in this benchmark reflects network conditions from that one location. Confirmed two ways: Namespace's own runner-instance panel reports "Placement: Northern Virginia, US" for this profile, and independently, `cf-ray` receipts captured in real runs include `IAD` — the airport code Cloudflare uses for its Ashburn/Northern Virginia edge datacenter, exactly consistent with a client physically nearby. See [Vantage-point dependent](#limitations) in Limitations for what this does and doesn't mean for the results.

## Why this benchmark exists

Gateway latency discussions online routinely conflate metrics that behave very differently: connection-setup overhead (DNS, TCP, TLS) vs. actual routing/model-dispatch overhead, and a fresh connection's cost vs. an already-open connection's cost. A single aggregate "latency" number hides which of those is actually responsible for a gateway feeling fast or slow. This benchmark separates them explicitly, so a claim like "Gateway X is slower" can be traced to a specific phase rather than taken on faith.

The phase-separation methodology (cold vs. warm, DNS/TCP/TLS/TTFB/TTFT, round-robin execution, no-session-resumption cold connections) is adapted from [rbadillap/ai-gateways-benchmark](https://github.com/rbadillap/ai-gateways-benchmark), an independent open-source benchmark using the same approach. We reimplemented it in TypeScript on top of Node's `https` module rather than raw sockets, added a direct-to-Anthropic baseline and a fourth gateway routed without any intermediary hop, and extended it with tokens/sec and a composite score — see [Comparison to the reference implementation](#comparison-to-the-reference-implementation) for the full list of what matches and what's deliberately different.

## What gets measured

For each gateway, every probe request is one of two kinds:

- **Cold** — a brand-new TCP+TLS connection, opened from scratch for this single request. We time each connection phase individually (see below), plus the request itself.
- **Warm** — one throwaway request completes and is discarded on a freshly-opened keep-alive connection, then a **second** request is sent and measured on that same still-open socket. This isolates the connection-pool case: no DNS, no TCP, no TLS, just the request/response over a connection that's already up.

Every probe (cold or warm) also records:

- **Output tokens generated** and **tokens/sec** (generation throughput after the first token)
- **Success/error** — any non-2xx response, a timeout, or a completed stream with zero content tokens observed counts as a failure for that iteration
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

- **Model**: Claude Haiku 4.5 for all six participants — `anthropic/claude-haiku-4.5` via OpenRouter's and Vercel AI Gateway's catalog alias, `anthropic/claude-haiku-4-5` via LLM Gateway's provider-pinned catalog naming, `claude-haiku-4-5-20251001` via Cloudflare's, Anthropic's own, and Pydantic AI Gateway's native model ID (Pydantic proxies Anthropic's native API as-is, no gateway-specific model prefix). Same underlying model, addressed the way each API expects it to be addressed.
- **Prompt**: `"Write a two-sentence description of how distributed systems handle partial failures."` — identical for every request, cold or warm, every gateway.
- **`max_tokens`**: 200. **`temperature`**: 0. **`stream`**: true (required for TTFT; also used for token-count extraction via `stream_options.include_usage` on the OpenAI-compatible path).
- **Timeout**: 45 seconds per request.

Two wire formats are in play, handled explicitly per gateway (`AIGatewayProviderConfig.wireFormat` in `benchmarks/ai-gateway/types.ts`):

- **`openai`** (OpenRouter, Vercel AI Gateway, LLM Gateway) — OpenAI-compatible `/chat/completions` shape, `Authorization: Bearer <key>`.
- **`anthropic`** (Cloudflare AI Gateway, Anthropic direct, Pydantic AI Gateway) — Anthropic's native `/v1/messages` shape. Auth header varies within this group: Cloudflare and Anthropic direct use `x-api-key` + `anthropic-version`; Pydantic AI Gateway uses `Authorization: Bearer <key>` + `anthropic-version` instead — confirmed directly against a real request (its own auth failures return a same-shaped 401 regardless of which of the two header styles is wrong, so this took a few rounds of live testing to pin down precisely).

TTFT detection is format-agnostic by design: a single regex (`"(?:content|text)"\s*:\s*"[^"]`) matches OpenAI's `delta.content` and Anthropic's `delta.text` fields alike, so the first-token timestamp doesn't depend on fully parsing every SSE event on the hot path. Token counts are extracted the same lightweight way (regex over the raw buffer, not a full SSE/JSON parser) — see Limitations.

Knowing when the stream has fully ended (needed for `ttfbMs`/`totalMs` and to safely reuse a warm connection) is handled by Node's own HTTP parser (`res.on('end')`), which understands `Content-Length` and chunked-transfer framing generically for any spec-compliant response. This differs from the reference implementation, which reads raw socket bytes and has to recognize completion itself via hand-matched byte sequences (`data: [DONE]`, `"type":"message_stop"`, the chunked terminator `\r\n0\r\n\r\n`) — a reasonable approach when working with raw sockets in Python, but one that has to be kept in sync with each gateway's exact stream-termination convention. Delegating that to Node's HTTP parser avoids needing to enumerate termination formats per gateway at all.

### Every gateway is hit directly — no gateway is proxied through another

This is the single most important fairness property of this benchmark, worth stating plainly: **Cloudflare AI Gateway is called via its own direct-to-Anthropic passthrough route** (`/v1/{account}/{gateway}/anthropic/v1/messages`), not routed through OpenRouter or any other intermediary. OpenRouter, Vercel AI Gateway, and LLM Gateway are each called via their own native routing to the same model — LLM Gateway's model id is provider-pinned (`anthropic/claude-haiku-4-5`) so its requests route to Anthropic itself rather than to a different host of the same model; this was confirmed directly against a real request, whose response `metadata` block explicitly reports `used_provider: "anthropic"`, `used_model: "claude-haiku-4-5"`. **Pydantic AI Gateway proxies Anthropic's native API directly** (`/proxy/anthropic/v1/messages`, native model ID `claude-haiku-4-5-20251001`, no gateway-specific routing prefix) — confirmed with a real request returning a genuine Anthropic response (`"model":"claude-haiku-4-5-20251001"`, real `usage`/`cost_estimate` fields from Pydantic's own accounting). `anthropic-direct` calls Anthropic's API with no gateway at all, as the no-gateway control — it isolates how much latency each gateway adds on top of the underlying provider.

A gateway that's itself proxied through a second gateway would have that second hop's latency baked into its numbers, misattributed to the outer gateway. That's not happening here — every participant's number reflects that gateway's own overhead only.

## How the runner behaves

### Round-robin across gateways — and what that does and doesn't mean

Iterations run **round-robin across every active gateway**, not sequentially per gateway (`runAIGatewayBenchmarks` in `benchmarks/ai-gateway/benchmark.ts`):

```
round 1: openrouter → vercel-ai-gateway → cloudflare-ai-gateway → llmgateway → pydantic-ai-gateway → anthropic-direct
round 2: openrouter → vercel-ai-gateway → cloudflare-ai-gateway → llmgateway → pydantic-ai-gateway → anthropic-direct
...
```

This is purely about **execution order in time**. Instead of running all of one gateway's iterations back-to-back and then moving to the next gateway (where the last gateway tested could be unfairly affected by, say, a network blip or a provider's load spike five minutes into the run), every gateway gets its Nth iteration at roughly the same point in time as every other gateway's Nth iteration. No gateway's numbers are systematically favored by running earlier, later, or during a different network condition than the others.

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
# All six gateways, default 10 cold + 10 warm iterations each
pnpm run bench:ai-gateway

# One gateway
pnpm run bench:ai-gateway:openrouter
pnpm run bench:ai-gateway:vercel
pnpm run bench:ai-gateway:cloudflare
pnpm run bench:ai-gateway:llmgateway
pnpm run bench:ai-gateway:pydantic
pnpm run bench:ai-gateway:anthropic

# Custom iteration count (applies to both cold and warm)
pnpm run bench:ai-gateway -- --iterations 20

# Asymmetric cold/warm split, or isolating one phase entirely
npx tsx benchmarks/src/run.ts --mode ai-gateway --ai-gateway-iterations-cold 20 --ai-gateway-iterations-warm 0
```

Required environment variables (`benchmarks/.env.example`): `OPENROUTER_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `LLM_GATEWAY_API_KEY`, `PYDANTIC_AI_GATEWAY_API_KEY`, `CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID` + `CLOUDFLARE_AI_GATEWAY_GATEWAY_ID` (+ optional `CLOUDFLARE_AI_GATEWAY_TOKEN` if the gateway has Authenticated Gateway enabled), `ANTHROPIC_API_KEY` (shared by Cloudflare's passthrough and the direct baseline). Missing credentials cause that gateway to be reported as `SKIPPED` rather than failing the run.

## Output

Results are written to `results/ai-gateway/YYYY-MM-DD.json` and copied to `results/ai-gateway/latest.json`. Every iteration's phase timings, token counts, and receipt headers are preserved in full — enough to trace any specific measured request back to its provider-side request ID.

```bash
pnpm run generate-ai-gateway-svg
```
produces `ai-gateway.svg` — a ranked comparison table (score, cold E2E, warm TTFT, tokens/sec, success rate).

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