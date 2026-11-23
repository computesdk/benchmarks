import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { providers as legacyProviders } from '../../sandbox/providers.js';
import { providers as compositeProviders } from '../composite/providers.js';
import { providers as reliabilityProviders } from './sandbox-reliability.providers.js';
import { getCiSandboxOptions } from './resource-options.js';
import { getSandboxOptionsWithResources, MARKET_SIZES } from './sizes.js';
import { OCI_PARTICIPANTS, REFERENCE_IMAGE } from './oci-tti.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sandboxDir = path.join(root, 'benchmarks/stealth/sandbox');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function runCloudParticipant(participants: { name: string; requiredEnvVars: string[] }[], label: string) {
  const matches = participants.filter((p) => p.name === 'run-cloud');
  assert.equal(matches.length, 1, `${label}: Run Cloud must participate exactly once`);
  assert.deepEqual(matches[0].requiredEnvVars, ['RUN_CLOUD_API_KEY'], label);
  return matches[0];
}

async function main() {
  runCloudParticipant(legacyProviders, 'legacy TTI / DAX / capabilities');
  runCloudParticipant(reliabilityProviders, 'reliability');
  assert.deepEqual(compositeProviders.find((p) => p.name === 'run-cloud')?.categories, ['sandbox']);

  const workflowNames: Record<string, string> = {
    cpu: 'sandbox-cpu',
    'filesystem-snapshot': 'filesystem-snapshot',
    'oci-tti': 'oci-tti',
    'os-capabilities': 'os-capabilities',
    rootfs: 'sandbox-rootfs',
    volumes: 'sandbox-volumes',
  };

  function checkWorkflowMatrix(workflow: string, label: string) {
    const command = workflow.match(/node -e "([^"\n]*readFileSync\('benchmarks\/stealth\/sandbox\/providers\.ts'[^"\n]*)"/);
    if (command) {
      const output = execFileSync(process.execPath, ['-e', command[1]], { cwd: root, encoding: 'utf8' });
      const names: string[] = JSON.parse(output.trim().replace(/^providers=/, ''));
      assert.equal(names.filter((p) => p === 'run-cloud').length, 1, label);
    } else {
      const source = workflow.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
      const matrices = [...source.matchAll(/matrix:\n[ \t]+provider:\n((?:[ \t]*(?:-[^\n]*)?\n)+)/g)];
      assert.ok(matrices.some((m) => /^\s+- run-cloud\s*$/m.test(m[1])), label);
    }
  }

  function checkWorkflowCredentials(workflow: string, label: string) {
    if (workflow.includes('vault-keys.sh')) {
      assert.ok(
        workflow.includes('vault-keys.sh benchmarks/stealth/sandbox/providers.ts --provider "${{ matrix.provider }}"'),
        `${label}: vault keys must be scoped to the leg's provider`,
      );
      const vaultKeys = (provider: string) => new RegExp(execFileSync('bash', [
        'benchmarks/stealth/scripts/vault-keys.sh',
        'benchmarks/stealth/sandbox/providers.ts',
        '--provider',
        provider,
        'BENCHMARKS_PLATFORM_API_KEY',
      ], { cwd: root, encoding: 'utf8' }));
      assert.match('RUN_CLOUD_API_KEY=fixture', vaultKeys('run-cloud'), label);
      assert.doesNotMatch('RUN_CLOUD_API_KEY=fixture', vaultKeys('e2b'), `${label}: other legs must not receive RUN_CLOUD_API_KEY`);
      return;
    }
    const cases = [...workflow.matchAll(/case "\$PROVIDER" in[\s\S]*?\besac/g)];
    if (cases.length) {
      const keys = execFileSync('bash', ['-e', '-c', `${cases.at(-1)![0]}\nprintf '%s' "\${PROVIDER_KEYS:?}"`], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PROVIDER: 'run-cloud' },
      });
      assert.equal(keys, 'RUN_CLOUD_API_KEY', label);
    } else {
      assert.match(workflow, /\bRUN_CLOUD_API_KEY\b/, label);
    }
  }

  const benchmarks = readdirSync(sandboxDir).filter((name) => name.endsWith('.bench.ts')).sort();
  for (const file of benchmarks) {
    const { config } = await import(pathToFileURL(path.join(sandboxDir, file)).href);
    runCloudParticipant(config.participants, file);
    const name = file.replace('.bench.ts', '');
    const workflowPath = `.computesdk/workflows/stealth-${workflowNames[name] ?? name}.yml`;
    const workflow = read(workflowPath);
    if (name !== 'sandbox-reliability') checkWorkflowMatrix(workflow, workflowPath);
    checkWorkflowCredentials(workflow, workflowPath);
    if (name === 'oci-tti') {
      assert.equal(config.participants.find((p: { name: string }) => p.name === 'run-cloud').sandboxOptions.image, REFERENCE_IMAGE);
    }
  }

  for (const name of ['sandbox-tti-benchmarks', 'sandbox-dax-benchmarks', 'sandbox-capabilities']) {
    const file = `.github/workflows/${name}.yml`;
    const workflow = read(file);
    checkWorkflowMatrix(workflow, file);
    checkWorkflowCredentials(workflow, file);
  }
  checkWorkflowMatrix(read('.computesdk/workflows/stealth-provider-weekly-composite.yml'), 'weekly composite');

  const daily = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'benchmarks/scripts/daily/build-daily-matrix.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PROVIDER_FILTER: 'run-cloud', BENCHMARK_FILTER: 'all', RUN_MODE: 'schedule' },
  }));
  assert.deepEqual(daily.include.map((p: { kind: string; provider: string }) => [p.kind, p.provider]), [
    ['sandbox', 'run-cloud'], ['dax', 'run-cloud'],
  ]);

  const base = { templateId: 'runcloud/agent-base', timeout: 900_000 };
  for (const [size, expected] of Object.entries(MARKET_SIZES)) {
    const options = getSandboxOptionsWithResources('run-cloud', base, size as keyof typeof MARKET_SIZES)!;
    assert.equal(options.cpu, expected.cpus, size);
    assert.equal(options.memory, expected.memoryMb, size);
    assert.equal(options.templateId, base.templateId, size);
  }
  const workload = getCiSandboxOptions('run-cloud', base, 3_600_000);
  assert.equal(workload.cpu, 8);
  assert.equal(workload.memory, 16384);
  assert.equal(workload.timeout, 3_600_000);
  assert.equal(workload.onTimeout, undefined);
  const deadline = getCiSandboxOptions('run-cloud', base, 240_000, 'deadline');
  assert.equal(deadline.timeout, 240_000);
  assert.equal(deadline.onTimeout, 'destroy');
  assert.equal(base.timeout, 900_000);
  assert.equal(OCI_PARTICIPANTS['run-cloud'].mechanism, 'image');

  console.log(`Run Cloud registration passed: ${benchmarks.length} sandbox suites, legacy workflows, daily matrix, resource tiers, and weekly composite`);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
