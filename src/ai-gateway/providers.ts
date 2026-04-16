import type { AIGatewayProviderConfig } from './types.js';

export const aiGatewayProviders: AIGatewayProviderConfig[] = [
  {
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY', 'AI_GATEWAY_MODEL'],
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.AI_GATEWAY_MODEL || '',
    defaultHeaders: {
      ...(process.env.OPENROUTER_HTTP_REFERER ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER } : {}),
      ...(process.env.OPENROUTER_X_TITLE ? { 'X-Title': process.env.OPENROUTER_X_TITLE } : {}),
    },
  },
  {
    name: 'vercel-ai-gateway',
    requiredEnvVars: ['VERCEL_AI_GATEWAY_BASE_URL', 'VERCEL_AI_GATEWAY_API_KEY', 'AI_GATEWAY_MODEL'],
    baseUrl: process.env.VERCEL_AI_GATEWAY_BASE_URL || '',
    apiKey: process.env.VERCEL_AI_GATEWAY_API_KEY || '',
    model: process.env.AI_GATEWAY_MODEL || '',
  },
  {
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: ['CLOUDFLARE_AI_GATEWAY_BASE_URL', 'CLOUDFLARE_AI_GATEWAY_API_KEY', 'AI_GATEWAY_MODEL'],
    baseUrl: process.env.CLOUDFLARE_AI_GATEWAY_BASE_URL || '',
    apiKey: process.env.CLOUDFLARE_AI_GATEWAY_API_KEY || '',
    model: process.env.AI_GATEWAY_MODEL || '',
  },
];
