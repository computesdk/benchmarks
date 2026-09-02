import type { AIGatewayModelIndexProviderConfig } from './types.js';
import { resolveNeonHost } from './neon-host.js';

/**
 * Provider roster for the AI Gateway model-index benchmark.
 *
 * Each entry points at the gateway's model-list/catalog endpoint. Some gateways
 * do not expose a public `/v1/models` endpoint (e.g. Cloudflare AI Gateway,
 * Pydantic AI Gateway, BlazeRail at the time of writing); the benchmark still
 * attempts them and records the failure in the results so the matrix is honest
 * about which gateways support programmatic discovery.
 */
export const modelIndexProviders: AIGatewayModelIndexProviderConfig[] = [
  {
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY'],
    host: 'openrouter.ai',
    modelsPath: '/api/v1/models',
    modelListFormat: 'openrouter',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
  },
  {
    name: 'vercel-ai-gateway',
    requiredEnvVars: [],
    host: 'ai-gateway.vercel.sh',
    modelsPath: '/v1/models',
    modelListFormat: 'openai',
    buildHeaders: () => ({}),
  },
  {
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: [
      'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID',
      'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID',
      'OPENAI_API_KEY',
    ],
    host: 'gateway.ai.cloudflare.com',
    modelsPath: `/v1/${process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID}/openai/v1/models`,
    modelListFormat: 'openai',
    buildHeaders: () => ({
      ...(process.env.OPENAI_API_KEY ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
      ...(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN
        ? { 'cf-aig-authorization': `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` }
        : {}),
    }),
  },
  {
    name: 'blazerail',
    requiredEnvVars: ['BLAZERAIL_API_KEY'],
    host: 'api.blazerail.com',
    modelsPath: '/v1/models',
    modelListFormat: 'openai',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.BLAZERAIL_API_KEY}`,
    }),
  },
  {
    name: 'llmgateway',
    requiredEnvVars: ['LLM_GATEWAY_API_KEY'],
    host: 'api.llmgateway.io',
    modelsPath: '/v1/models',
    modelListFormat: 'openai',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
    }),
  },
  {
    name: 'pydantic-ai-gateway',
    requiredEnvVars: ['PYDANTIC_AI_GATEWAY_API_KEY'],
    host: 'gateway-us.pydantic.dev',
    modelsPath: '/proxy/models',
    modelListFormat: 'pydantic',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.PYDANTIC_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    name: 'concentrate-ai-gateway',
    requiredEnvVars: ['CONCENTRATE_AI_GATEWAY_API_KEY'],
    host: 'api.concentrate.ai',
    modelsPath: '/v1/models',
    modelListFormat: 'openai',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.CONCENTRATE_AI_GATEWAY_API_KEY}`,
    }),
    pricingCatalog: {
      format: 'concentrate',
      host: 'api.concentrate.ai',
      pathTemplate: '/v1/models/{model}',
      buildHeaders: () => ({
        Authorization: `Bearer ${process.env.CONCENTRATE_AI_GATEWAY_API_KEY}`,
      }),
    },
  },
  {
    name: 'ramp',
    requiredEnvVars: ['RAMP_ROUTER_API_KEY'],
    host: 'router-api.ramp.com',
    modelsPath: '/v1/models',
    modelListFormat: 'openai',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.RAMP_ROUTER_API_KEY}`,
    }),
  },
  {
    name: 'neon',
    requiredEnvVars: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
    host: resolveNeonHost().host,
    modelsPath: `${resolveNeonHost().basePath}/v1/models`,
    modelListFormat: 'openrouter',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`,
    }),
    pricingCatalog: {
      format: 'neon',
      host: 'neon.com',
      path: '/models.json',
      buildHeaders: () => ({}),
    },
  },
  {
    name: 'ngrok',
    requiredEnvVars: ['NGROK_AI_GATEWAY_API_KEY'],
    host: 'gateway.ngrok.ai',
    modelsPath: '/v1/models',
    modelListFormat: 'openai',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NGROK_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    name: 'llmapi',
    requiredEnvVars: ['LLMAPI_API_KEY'],
    host: 'api.llmapi.ai',
    modelsPath: '/v1/models',
    modelListFormat: 'openai',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLMAPI_API_KEY}`,
    }),
  },
];
