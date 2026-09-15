/**
 * Per-provider token pricing used for the AI-gateway workload benchmark.
 *
 * The defaults here are the upstream Claude Haiku 4.5 list price
 * ($1.00 / $5.00 per 1M input / output tokens). Gateway-specific markups or
 * discounts can be captured by overriding a provider's entry; when no override
 * is known, the model price is used as a transparent baseline and the result
 * JSON flags the confidence as "estimated".
 *
 * See https://platform.anthropic.com/docs/en/about-claude/pricing
 */
export interface AIGatewayPricing {
  [key: string]: string | number;
  inputPer1M: number;
  outputPer1M: number;
  source: string;
  confidence: 'exact' | 'estimated' | 'unknown';
}

/** Upstream Claude Haiku 4.5 list price. */
const HAIKU_45_MODEL_PRICE: AIGatewayPricing = {
  inputPer1M: 1.0,
  outputPer1M: 5.0,
  source: 'Anthropic Claude Haiku 4.5 list price',
  confidence: 'exact',
};

/**
 * Pricing for each provider in the Anthropic-family gateway benchmark.
 * Defaults to the model list price; override individual gateways once their
 * own token markups are published.
 */
export const AIGATEWAY_PRICING: Record<string, AIGatewayPricing> = {
  'anthropic-direct': { ...HAIKU_45_MODEL_PRICE, confidence: 'exact' },
  'openrouter': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'vercel-ai-gateway': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'cloudflare-ai-gateway': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'llmgateway': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'pydantic-ai-gateway': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'concentrate-ai-gateway': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'ramp': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'neon': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'ngrok': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
  'llmapi': { ...HAIKU_45_MODEL_PRICE, confidence: 'estimated' },
};

export function getProviderPricing(providerName: string): AIGatewayPricing | undefined {
  return AIGATEWAY_PRICING[providerName];
}
