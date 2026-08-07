import type { GitProviderConfig } from './types.js';

/**
 * Git hosting provider benchmark configurations.
 *
 * Every participant requires both a writable `*_GIT_REPO_URL` env var and a
 * matching `*_TOKEN` env var. The runner skips providers whose credentials are
 * missing, so there is no read-only fallback.
 */
export const providers: GitProviderConfig[] = [
  {
    name: 'github',
    requiredEnvVars: ['GITHUB_GIT_REPO_URL', 'GITHUB_TOKEN'],
    repoUrlEnvVar: 'GITHUB_GIT_REPO_URL',
    tokenEnvVar: 'GITHUB_TOKEN',
    tokenUsername: 'token',
  },
  {
    name: 'gitlab',
    requiredEnvVars: ['GITLAB_GIT_REPO_URL', 'GITLAB_TOKEN'],
    repoUrlEnvVar: 'GITLAB_GIT_REPO_URL',
    tokenEnvVar: 'GITLAB_TOKEN',
    tokenUsername: 'oauth2',
  },
  {
    name: 'bitbucket',
    requiredEnvVars: ['BITBUCKET_GIT_REPO_URL', 'BITBUCKET_TOKEN'],
    repoUrlEnvVar: 'BITBUCKET_GIT_REPO_URL',
    tokenEnvVar: 'BITBUCKET_TOKEN',
    tokenUsername: 'x-token-auth',
  },
  {
    name: 'tensorlake',
    requiredEnvVars: ['TENSORLAKE_GIT_REPO_URL', 'TENSORLAKE_API_KEY'],
    repoUrlEnvVar: 'TENSORLAKE_GIT_REPO_URL',
    tokenEnvVar: 'TENSORLAKE_API_KEY',
    tokenUsername: 't',
  },
  //
  // add git providers above
];
