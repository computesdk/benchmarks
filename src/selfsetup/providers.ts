import type { ProviderSelfSetupConfig } from './types.js';

/**
 * Self-Setup provider configurations
 * 
 * These reuse the same credentials as the TTI benchmarks.
 * Each provider has its SDK package and required env vars documented.
 */

export const selfSetupProviders: ProviderSelfSetupConfig[] = [
  {
    name: 'e2b',
    npmPackage: 'e2b',
    importPath: 'e2b',
    credentials: [
      {
        name: 'API Key',
        envVar: 'E2B_API_KEY',
        description: 'Your E2B API key from https://e2b.dev/dashboard',
      },
    ],
    hints: [
      'Create a sandbox with Sandbox.create()',
      'Run commands with sandbox.runCommand()',
      'Don\'t forget to call sandbox.kill() when done',
    ],
  },
  {
    name: 'daytona',
    npmPackage: '@daytonaio/sdk',
    importPath: '@daytonaio/sdk',
    credentials: [
      {
        name: 'API Key',
        envVar: 'DAYTONA_API_KEY',
        description: 'Your Daytona API key',
      },
    ],
    hints: [
      'Use DaytonaClient for the main SDK entry point',
      'Set autoStopInterval and autoDeleteInterval on sandboxes',
    ],
  },
  {
    name: 'modal',
    npmPackage: 'modal-client',
    importPath: 'modal-client',
    credentials: [
      {
        name: 'Token ID',
        envVar: 'MODAL_TOKEN_ID',
        description: 'Your Modal token ID from https://modal.com/settings/tokens',
      },
      {
        name: 'Token Secret',
        envVar: 'MODAL_TOKEN_SECRET',
        description: 'Your Modal token secret',
      },
    ],
    hints: [
      'Modal uses a different pattern - you define functions with @stub.function()',
      'For sandbox-like behavior, look for Sandbox or stub.run() patterns',
    ],
  },
  {
    name: 'blaxel',
    npmPackage: '@blaxel/sdk',
    importPath: '@blaxel/sdk',
    credentials: [
      {
        name: 'API Key',
        envVar: 'BL_API_KEY',
        description: 'Your Blaxel API key',
      },
      {
        name: 'Workspace',
        envVar: 'BL_WORKSPACE',
        description: 'Your Blaxel workspace name',
      },
    ],
    hints: [
      'You need both BL_API_KEY and BL_WORKSPACE',
      'Default region is us-was-1',
    ],
  },
  {
    name: 'runloop',
    npmPackage: '@runloop/sdk',
    importPath: '@runloop/sdk',
    credentials: [
      {
        name: 'API Key',
        envVar: 'RUNLOOP_API_KEY',
        description: 'Your RunLoop API key',
      },
    ],
    hints: [
      'RunLoop focuses on dev environments',
      'Look for DevEnvironment or Sandbox in the SDK',
    ],
  },
  {
    name: 'namespace',
    npmPackage: '@namespace/sdk',
    importPath: '@namespace/sdk',
    credentials: [
      {
        name: 'Token',
        envVar: 'NSC_TOKEN',
        description: 'Your Namespace Cloud token',
      },
    ],
    hints: [
      'Namespace is Kubernetes-based',
      'You may need to specify an image like node:22',
    ],
  },
  {
    name: 'codesandbox',
    npmPackage: '@codesandbox/sdk',
    importPath: '@codesandbox/sdk',
    credentials: [
      {
        name: 'API Key',
        envVar: 'CSB_API_KEY',
        description: 'Your CodeSandbox API key',
      },
    ],
    hints: [
      'CSB has a specific SDK for programmatic access',
      'Be aware of destroy timeouts - use destroyTimeoutMs: 1000',
    ],
  },
  {
    name: 'hopx',
    npmPackage: '@hopx/sdk',
    importPath: '@hopx/sdk',
    credentials: [
      {
        name: 'API Key',
        envVar: 'HOPX_API_KEY',
        description: 'Your HopX API key',
      },
    ],
  },
  {
    name: 'vercel',
    npmPackage: '@vercel/sdk',
    importPath: '@vercel/sdk',
    credentials: [
      {
        name: 'Token',
        envVar: 'VERCEL_TOKEN',
        description: 'Your Vercel token',
      },
      {
        name: 'Team ID',
        envVar: 'VERCEL_TEAM_ID',
        description: 'Your Vercel team ID',
      },
      {
        name: 'Project ID',
        envVar: 'VERCEL_PROJECT_ID',
        description: 'Your Vercel project ID',
      },
    ],
    hints: [
      'Vercel is deployment-focused, not true sandbox',
      'You may need to use preview deployments',
    ],
  },
];

export function getProviderConfig(name: string): ProviderSelfSetupConfig | undefined {
  return selfSetupProviders.find(p => p.name === name);
}
