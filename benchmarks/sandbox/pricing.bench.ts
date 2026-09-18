/**
 * Pricing benchmark: fetches each sandbox provider's public pricing page and
 * extracts the published unit rates, so we track the *stated* cost of the Dax
 * spec (8 vCPU / 16 GiB) over time rather than trusting a hand-maintained
 * table. One iteration per provider; no credentials required — every input is
 * a public page.
 *
 * Rates are extracted literally (each pattern captures a price figure printed
 * on the page, optionally scaled to per-hour), then `hourlyRate` reduces them
 * to a comparable $/hr at the Dax spec. A provider whose page stops matching
 * records `fieldsMatched < fieldsTotal` and a null hourlyRate — the drift is
 * the signal.
 *
 * Results are written to results/sandbox-pricing/<YYYY-MM-DD>.json +
 * latest.json via the legacy-results bridge, same as sandbox-dax.
 *
 * Run:
 *   bench run benchmarks/sandbox/pricing.bench.ts
 *   bench run benchmarks/sandbox/pricing.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { TaskResult } from '@benchsdk/runner';
import { PRICING_PROVIDERS, stripHtml } from './pricing.js';
import type { PricingProvider } from './pricing.js';
import { writePricingLegacyResults } from './pricing-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FETCH_TIMEOUT_MS = 30_000;

interface PricingParticipant {
  name: string;
  pricing: PricingProvider;
}

const participants: PricingParticipant[] = PRICING_PROVIDERS.map((p) => ({ name: p.name, pricing: p }));

export const config = defineBenchmarkConfig({
  benchmarkSlug: `sandbox-pricing${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Sandbox Pricing${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  iterations: 1,
  concurrency: participants.length,
  participants,
  display: {
    metrics: [
      { key: 'hourlyRate', label: '$/hr @ 8 vCPU / 16 GiB', unit: 'usd', direction: 'lower-better', decimals: 4 },
      { key: 'fieldsMatched', label: 'Fields matched', direction: 'higher-better', decimals: 0 },
      { key: 'fieldsTotal', label: 'Fields total', direction: 'higher-better', decimals: 0 },
    ],
    overview: { defaultMetric: 'hourlyRate', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writePricingLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/sandbox-pricing'),
    }),
});

async function fetchPricingText(provider: PricingProvider): Promise<{ text: string; status: number }> {
  const res = await fetch(provider.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // Pricing pages are public marketing/docs HTML; send a browser-ish UA so
      // CDNs that bot-block plain `node` still serve the real page.
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  const html = await res.text();
  if (!res.ok) {
    return { text: stripHtml(html), status: res.status };
  }
  return { text: stripHtml(html), status: res.status };
}

export const task = defineTask<PricingParticipant>(async (ctx): Promise<TaskResult> => {
  const provider = ctx.participant.pricing;
  const start = Date.now();
  const { text, status } = await fetchPricingText(provider);
  const fetchMs = Date.now() - start;

  const rates: Record<string, number> = {};
  for (const ex of provider.extractors) {
    const m = ex.pattern.exec(text);
    if (m?.[1] !== undefined) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) rates[ex.key] = v * (ex.scale ?? 1);
    }
  }

  const hourlyRate = provider.hourlyRate(rates);
  const fieldsTotal = provider.extractors.length;
  const fieldsMatched = Object.keys(rates).length;

  if (status >= 400) {
    return {
      latencyMs: fetchMs,
      data: {
        provider: provider.name,
        url: provider.url,
        hourlyRate,
        rates,
        fieldsMatched,
        fieldsTotal,
        httpStatus: status,
        error: `HTTP ${status}`,
      },
    };
  }

  return {
    latencyMs: fetchMs,
    data: {
      provider: provider.name,
      url: provider.url,
      hourlyRate,
      perSandboxFee: provider.perSandboxFee?.(rates) ?? null,
      rates,
      fieldsMatched,
      fieldsTotal,
      httpStatus: status,
    },
  };
});
