/**
 * CI capabilities benchmark — can a provider's sandbox run containerized
 * CI jobs?
 *
 * Exercises the capabilities a CI workload needs, end to end, inside one
 * provider sandbox per iteration: exec semantics,
 * fresh-process re-attach, concurrent + detached exec, workspace and runtime,
 * egress reachability, git clone, the resource floor, the real dockerd
 * bring-up script (./ci-runtime.ts, ported verbatim from
 * lib/ci/executor/act-runtime.ts), and plain-docker container checks: pull,
 * run-to-completion with exit-code propagation, detached + bind mount, and
 * container-to-container networking. A second sandbox is
 * created with a short `timeout` to prove the instance deadline is honored —
 * the auto-pause / hard-cap failure the namespace 1h bug shipped.
 *
 * A provider that passes every check can host containerized CI jobs; each
 * failing check names the gap to fix. Checks never abort on first
 * failure: each runs inside its own `step()` and records {passed, error}
 * into the capability matrix (`record.data.features`), so a provider that
 * fails dockerd still reports git/egress/detached.
 *
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-ci-capabilities.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-ci-capabilities.bench.ts --provider e2b,modal
 */
import { benchmarkResultsDir } from '../src/util/results.js';
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import type { CommandResult, CreateSandboxOptions, SandboxInterface } from 'computesdk';
import { runCloud } from '@computesdk/run-cloud';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import type { ProviderConfig, ProviderCapabilityMatrix } from './types.js';
import { getCiSandboxOptions } from './resource-options.js';
import {
  DOCKER_BIN_DIR,
  buildDockerBringUpScript,
  dockerdClientEnv,
  shellQuote,
} from './ci-runtime.js';
import { writeCiCapabilitiesResults } from './sandbox-ci-capabilities-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 300_000;
const EXEC_TIMEOUT_MS = 60_000;
const DOCKER_PROBE_TIMEOUT_MS = 120_000; // pull/run/detached/network probes
const LONG_EXEC_TIMEOUT_MS = 600_000; // dockerd bring-up
const DOCKER_PULL_TIMEOUT_MS = 300_000;
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
/** Small image every docker leg uses — pull speed is not the thing tested. */
const PROBE_IMAGE = 'alpine:latest';

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
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-ci-capabilities',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox CI Capabilities',
  iterations: 1,
  concurrency: 1,
  participants: [
    ...providers,
    {
      name: 'run-cloud',
      requiredEnvVars: ['RUN_CLOUD_API_KEY'],
      createCompute: () => runCloud({ apiKey: process.env.RUN_CLOUD_API_KEY! }),
      sandboxOptions: { templateId: 'runcloud/agent-base' },
    },
  ],
  // Composite = share of the battery's checks that passed. A provider whose
  // sandbox never comes up fails its task (successRate 0) and scores 0.
  scoring: {
    metrics: [
      {
        key: 'checksPassedPct',
        unit: '%',
        ceiling: 100,
        higherIsBetter: true,
        weights: { median: 1, p95: 0, p99: 0 },
      },
    ],
  },
  display: {
    metrics: [
      { key: 'checksPassedPct', label: 'Checks passed (%)', unit: '%', direction: 'higher-better', decimals: 0 },
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
      { key: 'docker_pull', label: 'Image pull' },
      { key: 'docker_run', label: 'Container run + exit code' },
      { key: 'docker_detached', label: 'Detached container + bind mount' },
      { key: 'docker_net', label: 'Container-to-container network' },
      { key: 'destroy', label: 'Destroy sandbox' },
    ],
    byStep: { defaultLayout: 'matrix' },
    overview: { defaultMetric: 'supportedPct', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writeCiCapabilitiesResults(outcome.participants, {
      // Repo-root results/ (the workflow uploads results/ and commits back to
      // it); __dirname is benchmarks/stealth/sandbox.
      resultsDir: benchmarkResultsDir('sandbox_ci_capabilities'),
      runConfig: outcome.config,
    }),
});


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

  const createOptions: CreateSandboxOptions = getCiSandboxOptions(provider, participant.sandboxOptions, SANDBOX_LEASE_MS);

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
    // No sandbox → the check is unprobed, not failed: don't call step() at
    // all so the cell renders as a dash (and stays out of `features`).
    // supportedPct still hits 0% via `create`'s ✗.
    if (opts.needsSandbox !== false && !sandbox) return;
    // Record the verdict inside the step and then rethrow: the runner marks
    // the step error only when the step callback throws, and the platform's
    // matrix reads step status — a swallowed failure renders as a green
    // check. The throw is caught outside the step so the battery keeps going.
    await step(name, async () => {
      try {
        const detail = (await fn()) ?? {};
        measure({ passed: true, ...detail });
        matrix[name] = { passed: true };
      } catch (err) {
        const error = formatError(err);
        measure({ passed: false, error });
        matrix[name] = { passed: false, error };
        log(`check ${name} failed`, { level: 'warn', meta: { error } });
        throw err;
      }
    }).catch(() => {
      // already recorded into matrix + measured inside the step
    });
  }

  // Second sandbox with a short requested lifetime, started immediately so
  // its deadline window ticks while the main battery runs — the verdict is
  // evaluated after the docker legs. The instance must still exec until ~the deadline
  // and be gone shortly after: auto-pause and silently ignored timeouts are
  // both failures for the product.
  const runDeadlineProbe = async (): Promise<JsonObject> => {
    let firstDeadMs: number | undefined;
    try {
      deadlineSandbox = await withTimeout(
        compute.sandbox.create(getCiSandboxOptions(provider, participant.sandboxOptions, DEADLINE_MS, 'deadline')),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'deadline sandbox creation timed out',
        (s) => s.destroy(),
      );
    } catch (err) {
      throw new Error(`deadline sandbox create failed: ${formatError(err)}`);
    }
    const t0 = Date.now();
    const probe = async (): Promise<boolean> => {
      try {
        const handle = await withTimeout(
          compute.sandbox.getById(deadlineSandbox!.sandboxId),
          20_000,
          'getById probe timed out',
        );
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
  };
  const deadlineProbe = runDeadlineProbe();
  // Mark handled so an early rejection isn't an unhandled promise rejection
  // before the deadline check awaits it at the end of the battery.
  deadlineProbe.catch(() => {});

  await step('create', async () => {
    sandbox = await withTimeout(
      compute.sandbox.create(createOptions),
      participant.timeout ?? CREATE_TIMEOUT_MS,
      'Sandbox creation timed out',
      (s) => s.destroy(),
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
      // The env probe must expand the variable inside a nested shell: a
      // `VAR=v cmd` prefix only lands in cmd's *environment* — expansions in
      // cmd's own arguments resolve before the assignment applies, so
      // `env={K:v}` + `echo "$K"` prints the pre-existing (empty) value on
      // every provider that injects env via a command prefix.
      const echoResult = mustExit(
        await exec('sh -c \'echo "$CI_CAP_MARKER"\'', { env: { CI_CAP_MARKER: marker } }),
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
        await exec(`id -u; id -un 2>/dev/null || true; mkdir -p ${WORK_DIR}/work && touch ${WORK_DIR}/w && echo writable`),
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

    await check('dockerd', async () => {
      const result = await exec(
        buildDockerBringUpScript(process.env, { provider }),
        { timeoutMs: LONG_EXEC_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        log('dockerd bring-up output', { level: 'warn', meta: { tail: tailLines(result.stdout, 15), stderr: tailLines(result.stderr, 15) } });
        throw new Error(`dockerd bring-up failed (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 8)}`);
      }
    });

    const dockerEnv = [`export PATH="${DOCKER_BIN_DIR}:$PATH"`, ...dockerdClientEnv(provider)].join('\n');

    await check('docker_pull', async () => {
      const result = await exec(
        `${dockerEnv}\ndocker pull --quiet ${shellQuote(PROBE_IMAGE)} && docker image inspect ${shellQuote(PROBE_IMAGE)} >/dev/null`,
        { timeoutMs: DOCKER_PULL_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        throw new Error(`docker pull ${PROBE_IMAGE} failed (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 8)}`);
      }
      return { image: PROBE_IMAGE };
    });

    await check('docker_run', async () => {
      // The containerized-job contract: output is visible and the container's
      // exit code propagates through docker run and the provider's exec.
      const marker = 'ci_cap_container_ok';
      const result = await exec(
        `${dockerEnv}\ndocker run --rm -e TOKEN=${marker} ${shellQuote(PROBE_IMAGE)} sh -c 'echo "$TOKEN"; exit 7'`,
        { timeoutMs: DOCKER_PROBE_TIMEOUT_MS },
      );
      if (!result.stdout.includes(marker)) {
        throw new Error(`container output missing marker: stdout="${tailLines(result.stdout, 4)}" stderr="${tailLines(result.stderr, 4)}"`);
      }
      if (result.exitCode !== 7) {
        throw new Error(`container exit code not propagated: expected 7, got ${result.exitCode}`);
      }
      return { containerExitCode: result.exitCode };
    });

    await check('docker_detached', async () => {
      // Detached container + bind mount: the supervision path CI needs —
      // start a container, let it outlive the exec, read what it wrote.
      const shared = `${WORK_DIR}/shared`;
      const result = await exec(
        [
          dockerEnv,
          `mkdir -p ${shared} && rm -f ${shared}/marker`,
          'docker rm -f ci-cap-det >/dev/null 2>&1 || true',
          `docker run -d --name ci-cap-det -v ${shared}:/shared ${shellQuote(PROBE_IMAGE)} sh -c 'sleep 2; echo det-ok > /shared/marker'`,
          'docker wait ci-cap-det',
          `cat ${shared}/marker`,
          'docker rm ci-cap-det >/dev/null 2>&1 || true',
        ].join('\n'),
        { timeoutMs: DOCKER_PROBE_TIMEOUT_MS },
      );
      mustExit(result, 'detached container');
      if (!result.stdout.includes('det-ok')) {
        throw new Error(`detached container output missing: stdout="${tailLines(result.stdout, 4)}"`);
      }
    });

    await check('docker_net', async () => {
      // Two containers on a user-defined bridge resolving each other by name —
      // the service-container pattern CI jobs rely on (db/cache sidecars).
      const result = await exec(
        [
          dockerEnv,
          'docker rm -f ci-cap-srv >/dev/null 2>&1 || true',
          'docker network rm ci-cap-net >/dev/null 2>&1 || true',
          'docker network create ci-cap-net',
          `docker run -d --name ci-cap-srv --network ci-cap-net --network-alias ci-cap-srv ${shellQuote(PROBE_IMAGE)} sh -c 'while :; do echo net-ok | nc -l -p 4321 -w 15; done'`,
          'sleep 2',
          `docker run --rm --network ci-cap-net ${shellQuote(PROBE_IMAGE)} sh -c 'nc ci-cap-srv 4321'`,
          'rc=$?',
          'docker rm -f ci-cap-srv >/dev/null 2>&1 || true',
          'docker network rm ci-cap-net >/dev/null 2>&1 || true',
          'exit $rc',
        ].join('\n'),
        { timeoutMs: DOCKER_PROBE_TIMEOUT_MS },
      );
      if (!result.stdout.includes('net-ok')) {
        throw new Error(`container-to-container networking failed (exit ${result.exitCode}): stdout="${tailLines(result.stdout, 6)}" stderr="${tailLines(result.stderr, 4)}"`);
      }
    });

    // Evaluated last so the deadline window overlaps the rest of the battery;
    // by this point the second sandbox's verdict is almost always settled.
    await check('deadline', () => deadlineProbe, { needsSandbox: false });
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
  const data = { features: matrix, checksPassed, checksTotal, checksPassedPct } as unknown as JsonObject;
  // No sandbox = the provider couldn't run the battery at all: fail the task
  // so it scores 0 instead of passing with an empty grid. The in-sandbox
  // checks stay unprobed (dashes); only `create` shows ✗.
  if (!sandbox) {
    throw new TaskError(`sandbox create failed: ${matrix['create']?.error ?? 'unknown error'}`, {
      code: 'create_failed',
      data,
    });
  }
  return { data };
});

export const beforeExit = () => drainLateCleanups();
