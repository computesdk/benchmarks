import fs from 'node:fs';
import path from 'node:path';

try {
  const provider = process.env.SOAK_PROVIDER ?? '';
  const providers = fs.readFileSync(new URL('../sandbox/providers.ts', import.meta.url), 'utf8');
  const names = [...providers.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((match) => match[1]);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider) || !names.includes(provider)) {
    throw new Error('Choose a registered sandbox provider');
  }
  const state = JSON.parse(process.env.SOAK_STATE_JSON ?? '');
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('State must be a JSON object');
  const counters = ['epochIndex', 'verifiedLines', 'headTs', 'ticksAttempted', 'ticksPassed', 'ticksFailed',
    'corruptTicks', 'pauseGaps', 'restarts', 'writerRestarts', 'sameSandboxViolations'];
  const allowed = new Set([...counters, 'sandboxId', 'workdir', 'epochStartedAt', 'headHash',
    'respawnReason', 'orphanedSandboxIds', 'lastCheckAt', 'lastSeenAliveAt']);
  if (Object.keys(state).some((key) => !allowed.has(key))) throw new Error('State contains unsupported fields');
  for (const key of counters) {
    if (!Number.isSafeInteger(state[key]) || state[key] < 0) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['sandboxId', 'workdir']) {
    if (state[key] !== null && (typeof state[key] !== 'string' || !state[key])) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['epochStartedAt', 'lastCheckAt', 'lastSeenAliveAt']) {
    if (key !== 'epochStartedAt' && state[key] === null) continue;
    if (typeof state[key] !== 'string' || !Number.isFinite(Date.parse(state[key]))) throw new Error(`Invalid ${key}`);
  }
  if (typeof state.headHash !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(state.headHash)) throw new Error('Invalid headHash');
  if (state.respawnReason !== undefined && typeof state.respawnReason !== 'string') throw new Error('Invalid respawnReason');
  if (state.orphanedSandboxIds !== undefined && (!Array.isArray(state.orphanedSandboxIds) ||
      state.orphanedSandboxIds.some((id) => typeof id !== 'string' || !id))) throw new Error('Invalid orphanedSandboxIds');
  const directory = path.resolve('results/sandbox_soak/state');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, `${provider}.json`), JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Validated state written for ${provider}; no provider calls were made.`);
} catch (error) {
  // JSON syntax errors can quote private payload text; never print the payload or parser error.
  console.error(error instanceof SyntaxError ? 'State must be valid JSON' : error.message);
  process.exitCode = 1;
}
