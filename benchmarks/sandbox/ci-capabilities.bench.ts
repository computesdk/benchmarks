/**
 * CI capabilities benchmark — the Actions-product readiness gate.
 *
 * Runs the same in-sandbox path benchmarks-platform's CI executor uses, end
 * to end, inside one provider sandbox per iteration: exec semantics,
 * fresh-process re-attach, concurrent + detached exec, workspace and runtime,
 * egress reachability, git clone, the resource floor, the real dockerd
 * bring-up and act install scripts (./ci-runtime.ts, ported verbatim from
 * lib/ci/executor/act-runtime.ts), the runner-image pull, and a detached
 * `act push` that runs a real workflow to a green exit. A second sandbox is
 * created with a short `timeout` to prove the instance deadline is honored —
 * the auto-pause / hard-cap failure the namespace 1h bug shipped.
 *
 * A provider that passes every check can be placed into the Actions product;
 * each failing check names the gap to fix. Checks never abort on first
 * failure: each runs inside its own `step()` and records {passed, error}
 * into the capability matrix (`record.data.features`), so a provider that
 * fails dockerd still reports git/egress/detached.
 *
 *   bench run benchmarks/sandbox/ci-capabilities.bench.ts
 *   bench run benchmarks/sandbox/ci-capabilities.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import type { CommandResult, CreateSandboxOptions, SandboxInterface } from 'computesdk';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import type { ProviderConfig, ProviderCapabilityMatrix } from './types.js';
import { getSandboxOptionsWithResources } from './resource-options.js';
import {
  ACT_ARTIFACTS_DIR,
  ACT_ARTIFACT_SERVER_PORT,
  ACT_ACTION_CACHE_DIR,
  BLAXEL_RUNNER_IMAGE,
  DOCKER_BIN_DIR,
  actBinaryPath,
  actImageArgs,
  buildActInstallScript,
  buildBlaxelRunnerImageScript,
  buildDockerBringUpScript,
  buildRunnerImagePullScript,
  dockerLocalBridgeGatewayScript,
  dockerdClientEnv,
  runnerImage,
  sandboxPrimaryAddrScript,
  shellQuote,
} from './ci-runtime.js';
import { writeCiCapabilitiesResults } from './ci-capabilities-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 300_000;
const EXEC_TIMEOUT_MS = 60_000;
const LONG_EXEC_TIMEOUT_MS = 600_000; // dockerd bring-up + act install
const PULL_TIMEOUT_MS = 1_200_000; // catthehacker/ubuntu:act-latest is ~1.4GB
const ACT_RUN_TIMEOUT_MS = 1_500_000; // detached act launch, polled
const DESTROY_TIMEOUT_MS = 15_000;
const SANDBOX_LEASE_MS = 3_600_000; // the battery can run ~45min on slow egress
const DEADLINE_MS = 240_000; // second sandbox's requested instance lifetime
const DEADLINE_GRACE_MS = 120_000; // how late a kill may land and still be honored
const DEADLINE_EARLY_MS = Math.floor(DEADLINE_MS * 0.75); // dying sooner fails
const DEADLINE_POLL_MS = 15_000;

/** The CI floor the Actions product provisions: ~4 vCPU / 8 GiB / 16 GiB. */
const FLOOR_VCPU = 4;
const FLOOR_MEM_MIB = 7_800; // 8 GiB minus what `free` hides behind the kernel
const FLOOR_DISK_AVAIL_MIB = 14_000;

const WORK_DIR = '/tmp/ci-cap';
const ACT_RUN_DIR = '/tmp/act/run';

const WORKFLOW_YML = `name: ci-capability-probe
on: push
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - name: Probe marker
        run: echo "ci_capability_probe_ok"
`;

const EVENT_JSON = '{"ref":"refs/heads/main"}\n';

const EGRESS_HOSTS: readonly { name: string; url: string }[] = [
  { name: 'github', url: 'https://github.com/' },
  { name: 'github_api', url: 'https://api.github.com/' },
  { name: 'codeload', url: 'https://codeload.github.com/octocat/Hello-World/tar.gz/refs/heads/master' },
  { name: 'npm', url: 'https://registry.npmjs.org/' },
  { name: 'docker_static', url: 'https://download.docker.com/' },
  { name: 'docker_hub', url: 'https://registry-1.docker.io/v2/' },
  { name: 'platform', url: 'https://platform.computesdk.com/' },
  { name: 'nodejs', url: 'https://nodejs.org/dist/' },
];

export const config = defineBenchmarkConfig({
  benchmarkSlug: `sandbox-ci-capabilities${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `Sandbox CI Capabilities${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  iterations: 1,
  concurrency: 1,
  participants: providers,
  display: {
    metrics: [
      { key: 'checksPassedPct', label: 'Checks passed', unit: '%', direction: 'higher-better', decimals: 0 },
      { key: 'checksPassed', label: 'Checks passed', direction: 'higher-better', decimals: 0 },
      { key: 'checksTotal', label: 'Checks total', direction: 'higher-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'exec', label: 'Exec semantics' },
      { key: 'reconnect', label: 'Re-attach (getById)' },
      { key: 'concurrent', label: 'Concurrent exec' },
      { key: 'detached', label: 'Detached process survives exec' },
      { key: 'workspace', label: 'Writable workspace' },
      { key: 'runtime', label: 'Node runtime' },
      { key: 'egress', label: 'Egress reachability' },
      { key: 'git', label: 'Git clone' },
      { key: 'sizing', label: 'Resource floor' },
      { key: 'deadline', label: 'Deadline honored' },
      { key: 'dockerd', label: 'Docker daemon bring-up' },
      { key: 'act_install', label: 'act install' },
      { key: 'runner_image', label: 'Runner image pull' },
      { key: 'act_run', label: 'act workflow run' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    overview: { defaultMetric: 'checksPassedPct', defaultLayout: 'ranking' },
  },
  scoring: {
    metrics: [
      { key: 'checksPassedPct', unit: '%', higherIsBetter: true, floor: 0, ceiling: 100, weights: { median: 0.6, p95: 0.25, p99: 0.15 } },
    ],
  },
  onComplete: (outcome) =>
    writeCiCapabilitiesResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../results/sandbox-ci-capabilities'),
      runConfig: outcome.config,
    }),
});

function b64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function tailLines(output: string | undefined, n: number): string {
  return (output ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .slice(-n)
    .join('\n');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;
  const provider = participant.name;
  const compute = participant.createCompute() as {
    sandbox: {
      create(options?: CreateSandboxOptions): Promise<SandboxInterface>;
      getById(id: string): Promise<SandboxInterface | null>;
      destroy(id: string): Promise<void>;
    };
  };

  const matrix: ProviderCapabilityMatrix = {};
  let sandbox: SandboxInterface | undefined;
  let deadlineSandbox: SandboxInterface | undefined;

  const createOptions: CreateSandboxOptions = {
    ...getSandboxOptionsWithResources(provider, participant.sandboxOptions),
    // The battery outlives every TTI-oriented TTL in providers.ts (e2b's
    // 10-minute sandboxOptions.timeout would kill the box mid-act-run).
    timeout: SANDBOX_LEASE_MS,
  };

  async function exec(
    command: string,
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
    return (await withTimeout(
      sandbox!.runCommand(command, { timeout: timeoutMs, env: opts.env }),
      timeoutMs + 15_000,
      `exec timed out after ${timeoutMs}ms`,
    )) as CommandResult;
  }

  function mustExit(result: CommandResult, what: string): CommandResult {
    if (result.exitCode !== 0) {
      throw new Error(`${what} failed (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 6) || 'no output'}`);
    }
    return result;
  }

  async function check(name: string, fn: () => Promise<JsonObject | void>, opts: { needsSandbox?: boolean } = {}): Promise<void> {
    await step(name, async () => {
      if (opts.needsSandbox !== false && !sandbox) {
        const error = 'sandbox creation failed';
        measure({ passed: false, error });
        matrix[name] = { passed: false, error };
        return;
      }
      try {
        const detail = (await fn()) ?? {};
        measure({ passed: true, ...detail });
        matrix[name] = { passed: true };
      } catch (err) {
        const error = formatError(err);
        measure({ passed: false, error });
        matrix[name] = { passed: false, error };
        log(`check ${name} failed`, { level: 'warn', meta: { error } });
      }
    });
  }

  await step('create', async () => {
    sandbox = await withTimeout(
      compute.sandbox.create(createOptions),
      participant.timeout ?? CREATE_TIMEOUT_MS,
      'Sandbox creation timed out',
    );
    matrix['create'] = { passed: true };
    measure({ passed: true });
  }).catch((err: unknown) => {
    const error = formatError(err);
    measure({ passed: false, error });
    matrix['create'] = { passed: false, error };
    log('sandbox create failed', { level: 'error', meta: { provider, error } });
  });

  try {
    await check('exec', async () => {
      const marker = 'ci-cap-marker-41a7';
      const echoResult = mustExit(
        await exec('echo "$CI_CAP_MARKER"', { env: { CI_CAP_MARKER: marker } }),
        'marker echo',
      );
      if (!echoResult.stdout.includes(marker)) {
        throw new Error(`env injection missing: expected ${marker}, got "${tailLines(echoResult.stdout, 2)}"`);
      }
      const splitResult = await exec(`sh -c 'echo out-marker; echo err-marker >&2; exit 3'`);
      if (splitResult.exitCode !== 3) {
        throw new Error(`exit code not propagated: expected 3, got ${splitResult.exitCode}`);
      }
      if (!splitResult.stdout.includes('out-marker') || !splitResult.stderr.includes('err-marker')) {
        throw new Error(
          `stdout/stderr not separated: stdout="${tailLines(splitResult.stdout, 2)}" stderr="${tailLines(splitResult.stderr, 2)}"`,
        );
      }
      const killStart = Date.now();
      let killed = false;
      try {
        const r = await exec('sleep 30', { timeoutMs: 4_000 });
        killed = r.exitCode !== 0;
      } catch {
        killed = true;
      }
      const killMs = Date.now() - killStart;
      if (!killed || killMs > 12_000) {
        throw new Error(`per-command timeout ignored: sleep 30 returned after ${killMs}ms`);
      }
      return { timeoutKillMs: killMs };
    });

    await check('reconnect', async () => {
      const handle = await withTimeout(
        compute.sandbox.getById(sandbox!.sandboxId),
        EXEC_TIMEOUT_MS,
        'getById timed out',
      );
      if (!handle) throw new Error('getById returned null for a live sandbox');
      mustExit(await withTimeout(handle.runCommand('echo reconnect-ok'), EXEC_TIMEOUT_MS, 'reconnect exec timed out'), 'reconnect exec');
    });

    await check('concurrent', async () => {
      const started = Date.now();
      const [a, b] = await Promise.all([
        exec('sleep 2; echo leg-a', { timeoutMs: 30_000 }),
        exec('sleep 4; echo leg-b', { timeoutMs: 30_000 }),
      ]);
      const wallMs = Date.now() - started;
      mustExit(a, 'concurrent exec leg a');
      mustExit(b, 'concurrent exec leg b');
      return { wallMs, overlapped: wallMs < 5_500 };
    });

    await check('detached', async () => {
      const marker = 'detached-ok-9f3c';
      const detachedFile = `${WORK_DIR}-detached`;
      mustExit(
        await exec(
          `rm -f ${detachedFile}; nohup setsid sh -c 'sleep 3; echo ${marker} > ${detachedFile}' >/dev/null 2>&1 </dev/null & echo launched`,
          { timeoutMs: 15_000 },
        ),
        'detached launch',
      );
      await sleep(5_000);
      const result = mustExit(await exec(`cat ${detachedFile}`), 'detached file read');
      if (!result.stdout.includes(marker)) {
        throw new Error('detached process did not survive exec teardown');
      }
    });

    await check('workspace', async () => {
      const result = mustExit(
        await exec(`id -u; id -un 2>/dev/null || true; mkdir -p ${WORK_DIR}/work ${WORK_DIR}/act ${ACT_RUN_DIR} && touch ${WORK_DIR}/w && echo writable`),
        'workspace probe',
      );
      const uid = result.stdout.split('\n')[0]?.trim() ?? 'unknown';
      return { execUid: uid };
    });

    await check('runtime', async (): Promise<JsonObject> => {
      const result = mustExit(
        await exec('(command -v node || command -v nodejs || true) | head -1'),
        'runtime probe',
      );
      const nodeBin = result.stdout.trim();
      if (nodeBin) {
        const version = mustExit(await exec(`${nodeBin} -v`), 'node -v').stdout.trim();
        return { node: version };
      }
      // The product bootstraps a pinned Node itself — absent node is workable
      // as long as the box can fetch it (musl arm64 remains a real gap).
      const fetcher = mustExit(
        await exec('for t in curl wget python3 busybox; do command -v $t && break; done'),
        'fetch-tool probe',
      ).stdout.trim();
      if (!fetcher) throw new Error('no node runtime and no fetch tool for the pinned-node bootstrap');
      return { node: 'absent', note: `product bootstrap required (fetch via ${fetcher})` };
    });

    await check('egress', async () => {
      const script = [
        'ci_probe() {',
        '  ci_p_name="$1"; ci_p_url="$2"; ci_p_code=0; ci_p_ms=0',
        '  if command -v curl >/dev/null 2>&1; then',
        '    ci_p_out=$(curl -sSL -o /dev/null -w \'%{http_code} %{time_total}\' --max-time 30 "$ci_p_url" 2>/dev/null || true)',
        '    ci_p_code=${ci_p_out%% *}',
        '    ci_p_ms=$(printf \'%s\' "${ci_p_out##* }" | awk \'{printf "%d", $1*1000}\' 2>/dev/null || echo 0)',
        '  elif command -v python3 >/dev/null 2>&1; then',
        '    ci_p_out=$(python3 -c \'import sys,time,urllib.request,urllib.error',
        'u=sys.argv[1]; t=time.time()',
        'try:',
        '    r=urllib.request.urlopen(u,timeout=30); r.read(64); print(r.status, int((time.time()-t)*1000))',
        'except urllib.error.HTTPError as e:',
        '    print(e.code, int((time.time()-t)*1000))',
        'except Exception:',
        '    print(0, int((time.time()-t)*1000))\' "$ci_p_url" 2>/dev/null || true)',
        '    ci_p_code=${ci_p_out%% *}; ci_p_ms=${ci_p_out##* }',
        '  elif command -v wget >/dev/null 2>&1; then',
        '    ci_p_start=$(date +%s)',
        '    ci_p_code=$(wget -O /dev/null --timeout=30 -S "$ci_p_url" 2>&1 | awk \'/  HTTP\\//{c=$2} END{print c+0}\')',
        '    ci_p_ms=$(( ($(date +%s) - ci_p_start) * 1000 ))',
        '  elif command -v busybox >/dev/null 2>&1; then',
        '    busybox wget -q -O /dev/null "$ci_p_url" >/dev/null 2>&1 && ci_p_code=200',
        '  fi',
        '  echo "BENCH_EGRESS $ci_p_name ${ci_p_code:-0} ${ci_p_ms:-0}"',
        '}',
        ...EGRESS_HOSTS.map((h) => `ci_probe ${h.name} ${shellQuote(h.url)}`),
      ].join('\n');
      const result = mustExit(await exec(script, { timeoutMs: 180_000 }), 'egress probe');
      const latencies: Record<string, number> = {};
      const unreachable: string[] = [];
      for (const line of result.stdout.split('\n')) {
        const m = line.match(/^BENCH_EGRESS (\S+) (\d+) (\d+)$/);
        if (!m) continue;
        const code = Number(m[2]);
        const ms = Number(m[3]);
        if (code > 0) {
          if (ms > 0) latencies[`egress_${m[1]}Ms`] = ms;
        } else {
          unreachable.push(m[1]);
        }
      }
      const probed = Object.keys(latencies).length + unreachable.length;
      if (unreachable.length > 0) {
        throw new Error(`unreachable: ${unreachable.join(', ')} (${probed}/${EGRESS_HOSTS.length} probed)`);
      }
      if (probed === 0) throw new Error('egress probe produced no results');
      return latencies as JsonObject;
    });

    await check('git', async () => {
      const script = [
        'if ! command -v git >/dev/null 2>&1; then',
        '  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq git >/dev/null 2>&1;',
        '  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q git >/dev/null 2>&1;',
        '  elif command -v yum >/dev/null 2>&1; then yum install -y -q git >/dev/null 2>&1;',
        '  elif command -v apk >/dev/null 2>&1; then apk add --no-cache git >/dev/null 2>&1; fi',
        'fi',
        'command -v git >/dev/null 2>&1 || { echo "git is missing and could not be installed" >&2; exit 1; }',
        `rm -rf ${WORK_DIR}/clone`,
        `git clone -q --depth 1 https://github.com/octocat/Hello-World ${WORK_DIR}/clone`,
        `test -d ${WORK_DIR}/clone/.git`,
      ].join('\n');
      const result = await exec(script, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw new Error(`git clone failed (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 6)}`);
      }
    });

    await check('sizing', async () => {
      const result = mustExit(
        await exec('nproc; awk \'/MemTotal/{print int($2/1024)}\' /proc/meminfo; df -m / | awk \'NR==2{print $4}\''),
        'sizing probe',
      );
      const [cpus, memMiB, diskAvailMiB] = result.stdout.split('\n').map((l) => Number(l.trim()));
      const detail = { vcpus: cpus, memMiB, diskAvailMiB };
      const short: string[] = [];
      if (!(cpus >= FLOOR_VCPU)) short.push(`${cpus} vCPU < ${FLOOR_VCPU}`);
      if (!(memMiB >= FLOOR_MEM_MIB)) short.push(`${memMiB} MiB < ${FLOOR_MEM_MIB} MiB`);
      if (!(diskAvailMiB >= FLOOR_DISK_AVAIL_MIB)) short.push(`${diskAvailMiB} MiB disk < ${FLOOR_DISK_AVAIL_MIB} MiB`);
      if (short.length > 0) {
        throw new Error(`below the Actions floor: ${short.join(', ')}`);
      }
      return detail;
    });

    // Runs its own short-lived sandbox, so it still executes when the main
    // box failed to create.
    await check('deadline', async () => {
      // Second sandbox with a short requested lifetime: the instance must
      // still exec until ~the deadline and be gone shortly after — auto-pause
      // and silently ignored timeouts are both failures for the product.
      let firstDeadMs: number | undefined;
      try {
        deadlineSandbox = await withTimeout(
          compute.sandbox.create({ ...(participant.sandboxOptions ?? {}), timeout: DEADLINE_MS }),
          participant.timeout ?? CREATE_TIMEOUT_MS,
          'deadline sandbox creation timed out',
        );
      } catch (err) {
        throw new Error(`deadline sandbox create failed: ${formatError(err)}`);
      }
      const t0 = Date.now();
      const probe = async (): Promise<boolean> => {
        try {
          const handle = await compute.sandbox.getById(deadlineSandbox!.sandboxId);
          if (!handle) return false;
          const r = await withTimeout(handle.runCommand('true', { timeout: 15_000 }), 20_000, 'probe timed out');
          return r.exitCode === 0;
        } catch {
          return false;
        }
      };
      // Two consecutive failures mark the box dead: a single control-plane
      // blip must not read as an early kill.
      let misses = 0;
      while (Date.now() - t0 < DEADLINE_MS + DEADLINE_GRACE_MS) {
        if (await probe()) {
          misses = 0;
        } else {
          misses += 1;
          if (misses >= 2) {
            firstDeadMs = Date.now() - t0;
            break;
          }
        }
        await sleep(DEADLINE_POLL_MS);
      }
      const elapsedS = Math.round((firstDeadMs ?? Date.now() - t0) / 1000);
      if (firstDeadMs === undefined) {
        throw new Error(`deadline not honored: still exec'ing ${Math.round((DEADLINE_MS + DEADLINE_GRACE_MS) / 1000)}s past a ${DEADLINE_MS / 1000}s timeout`);
      }
      if (firstDeadMs < DEADLINE_EARLY_MS) {
        throw new Error(`box died ~${elapsedS}s in, before the requested ${DEADLINE_MS / 1000}s deadline`);
      }
      return { deadlineKillS: elapsedS };
    }, { needsSandbox: false });

    await check('dockerd', async () => {
      const prePull = provider === 'blaxel' ? [] : [runnerImage(provider)];
      const result = await exec(
        buildDockerBringUpScript(process.env, { provider, prePullImages: prePull }),
        { timeoutMs: LONG_EXEC_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        log('dockerd bring-up output', { level: 'warn', meta: { tail: tailLines(result.stdout, 15), stderr: tailLines(result.stderr, 15) } });
        throw new Error(`dockerd bring-up failed (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 8)}`);
      }
    });

    await check('act_install', async () => {
      const result = await exec(buildActInstallScript(process.env), { timeoutMs: LONG_EXEC_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        throw new Error(`act install failed (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 8)}`);
      }
    });

    await check('runner_image', async () => {
      const image = runnerImage(provider);
      const script = [
        `export PATH="${DOCKER_BIN_DIR}:$PATH"`,
        ...dockerdClientEnv(provider),
        provider === 'blaxel' && image === BLAXEL_RUNNER_IMAGE
          ? buildBlaxelRunnerImageScript(image)
          : buildRunnerImagePullScript([image]),
      ].join('\n');
      const result = await exec(script, { timeoutMs: PULL_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        log('runner image output', { level: 'warn', meta: { tail: tailLines(result.stdout, 10), stderr: tailLines(result.stderr, 10) } });
        throw new Error(`runner image ${image} unavailable (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 8)}`);
      }
      return { image };
    });

    await check('act_run', async () => {
      const runScript = [
        `cd ${WORK_DIR}/work || exit 1`,
        `export PATH="${DOCKER_BIN_DIR}:$PATH"`,
        ...dockerdClientEnv(provider),
        ...dockerLocalBridgeGatewayScript('artifact_server_addr'),
        'if [ -z "$artifact_server_addr" ]; then',
        ...sandboxPrimaryAddrScript('artifact_server_addr'),
        'fi',
        'artifact_server_addr_arg=""',
        'cache_server_addr_arg=""',
        'if [ -n "$artifact_server_addr" ]; then',
        '  artifact_server_addr_arg="--artifact-server-addr $artifact_server_addr"',
        '  cache_server_addr_arg="--cache-server-addr $artifact_server_addr"',
        'fi',
        'set -- $artifact_server_addr_arg $cache_server_addr_arg',
        [
          `${actBinaryPath()} "$@" push`,
          `-W ${shellQuote(`${WORK_DIR}/work/workflow.yml`)}`,
          '--job probe',
          `--eventpath ${shellQuote(`${WORK_DIR}/act/event.json`)}`,
          `--secret-file ${shellQuote(`${WORK_DIR}/act/secrets.env`)}`,
          `--var-file ${shellQuote(`${WORK_DIR}/act/vars.env`)}`,
          `--env-file ${shellQuote(`${WORK_DIR}/act/env.env`)}`,
          '--json',
          `--artifact-server-path ${shellQuote(ACT_ARTIFACTS_DIR)}`,
          `--artifact-server-port ${ACT_ARTIFACT_SERVER_PORT}`,
          `--action-cache-path ${shellQuote(ACT_ACTION_CACHE_DIR)}`,
          '--action-offline-mode',
          '--bind',
          ...(provider === 'cloudflare' ? ['--network host'] : []),
          ...(provider === 'blaxel' ? ['--pull=false'] : []),
          ...actImageArgs(provider),
        ].join(' '),
        `rc=$?; printf '%s' "$rc" > ${ACT_RUN_DIR}/act.exit; exit $rc`,
      ].join('\n');

      const stage = [
        `mkdir -p ${WORK_DIR}/work ${WORK_DIR}/act ${ACT_RUN_DIR} ${ACT_ACTION_CACHE_DIR}`,
        `cd ${WORK_DIR}/work && git init -q 2>/dev/null || true`,
        `echo ${shellQuote(b64(WORKFLOW_YML))} | base64 -d > ${WORK_DIR}/work/workflow.yml`,
        `echo ${shellQuote(b64(EVENT_JSON))} | base64 -d > ${WORK_DIR}/act/event.json`,
        `: > ${WORK_DIR}/act/secrets.env`,
        `: > ${WORK_DIR}/act/vars.env`,
        `: > ${WORK_DIR}/act/env.env`,
        `echo ${shellQuote(b64(runScript))} | base64 -d > ${WORK_DIR}/act-run.sh`,
        `rm -f ${ACT_RUN_DIR}/act.exit`,
      ].join(' && ');
      mustExit(await exec(stage), 'act staging');

      mustExit(
        await exec(
          `nohup setsid sh ${WORK_DIR}/act-run.sh >${ACT_RUN_DIR}/act.log 2>${ACT_RUN_DIR}/act.err </dev/null & echo $! > ${ACT_RUN_DIR}/act.pid; echo launched`,
          { timeoutMs: 15_000 },
        ),
        'act launch',
      );

      const t0 = Date.now();
      let exitCode: number | undefined;
      while (Date.now() - t0 < ACT_RUN_TIMEOUT_MS) {
        await sleep(15_000);
        const poll = await exec(`cat ${ACT_RUN_DIR}/act.exit 2>/dev/null || true`, { timeoutMs: 15_000 });
        const text = poll.stdout.trim();
        if (text !== '') {
          exitCode = Number(text);
          break;
        }
      }
      const logs = await exec(`tail -40 ${ACT_RUN_DIR}/act.log 2>/dev/null; tail -10 ${ACT_RUN_DIR}/act.err 2>/dev/null`, { timeoutMs: 15_000 })
        .catch(() => undefined);
      if (exitCode === undefined) {
        log('act run timed out', { level: 'warn', meta: { tail: tailLines(logs?.stdout, 30) } });
        throw new Error(`act run did not finish within ${Math.round(ACT_RUN_TIMEOUT_MS / 60000)}m: ${tailLines(logs?.stdout, 10)}`);
      }
      if (exitCode !== 0) {
        log('act run failed', { level: 'warn', meta: { tail: tailLines(logs?.stdout, 30) } });
        throw new Error(`act exited ${exitCode}: ${tailLines(logs?.stdout, 12)}`);
      }
      return { actRunS: Math.round((Date.now() - t0) / 1000) };
    });
  } finally {
    if (sandbox || deadlineSandbox) {
      await step('destroy', async () => {
        if (deadlineSandbox) {
          await withTimeout(deadlineSandbox.destroy(), DESTROY_TIMEOUT_MS, 'deadline destroy timeout').catch(() => {});
        }
        if (sandbox) {
          await withTimeout(sandbox.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timed out');
        }
      }).then(
        () => {
          matrix['destroy'] = { passed: true };
        },
        (err: unknown) => {
          const error = formatError(err);
          log('destroy failed', { level: 'warn', meta: { error } });
          matrix['destroy'] = { passed: false, error };
        },
      );
    }
    if (sandbox) {
      log('sandbox', { level: 'info', meta: { provider, sandboxId: sandboxId(sandbox) } });
    }
  }

  const checksTotal = Object.keys(matrix).length;
  const checksPassed = Object.values(matrix).filter((f) => f.passed).length;
  const checksPassedPct = checksTotal === 0 ? 0 : Math.round((checksPassed / checksTotal) * 100);
  measure({ checksPassed, checksTotal, checksPassedPct });
  return {
    data: { features: matrix, checksPassed, checksTotal, checksPassedPct } as unknown as JsonObject,
  };
});
