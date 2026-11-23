/**
 * CRIU capabilities benchmark — where can a running process be checkpointed
 * with CRIU and restored, memory intact?
 *
 * One iteration per provider runs a battery of pass/fail checks in one
 * sandbox: privileges (root or passwordless sudo, effective caps), kernel
 * support (CONFIG_CHECKPOINT_RESTORE via /proc/sys/kernel/ns_last_pid, not
 * gVisor), CRIU install, `criu check`, then a real round trip: a shell loop
 * holding an in-memory counter is dumped, restored on the same box, and
 * must keep counting from where it stopped. If that passes, the image is
 * shipped to a second fresh sandbox of the same provider and restored there —
 * the cross-box case a pause/resume product needs.
 *
 * Every check runs in its own `step()` and records {passed, error} into the
 * capability matrix (`record.data.features`). A check whose prerequisite
 * failed is recorded as failed with `blocked by <check>` instead of running,
 * so supportedPct counts it. The cross-box legs run only when the same-box
 * restore passed; otherwise they're unprobed (no step row).
 *
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-criu.bench.ts
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-criu.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import type { CommandResult, CreateSandboxOptions, SandboxInterface } from 'computesdk';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { sandboxId } from '../src/util/sandbox-id.js';
import { providers } from './providers.js';
import { NOW_NS_FN } from './shell-timing.js';
import type { ProviderConfig, ProviderCapabilityMatrix } from './types.js';
import { writeCiCapabilitiesResults } from './sandbox-ci-capabilities-legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Every sandbox provider except parked ones (opencomputer, lightning, render); no house. */
const PUBLIC_PROVIDERS = new Set([
  'agent37', 'archil', 'arker', 'beam', 'blaxel', 'boat', 'briq', 'buddy', 'cloud-run', 'cloudflare', 'codesandbox',
  'createos', 'daytona', 'e2b', 'freestyle', 'sfcompute', 'gravixlayer', 'hopx', 'isorun', 'kosa8',
  'lelantos', 'modal', 'microsandbox', 'promigence', 'miosa', 'mosaic', 'namespace', 'neevcloud',
  'northflank', 'novita', 'railway', 'run-cloud', 'sandbox0', 'sail', 'sprites', 'styne', 'superserve',
  'luxor', 'tensorlake', 'upstash', 'vercel',
]);
const criuProviders = providers.filter((p) => PUBLIC_PROVIDERS.has(p.name));

const CREATE_TIMEOUT_MS = 300_000;
const EXEC_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 420_000;
const CRIU_TIMEOUT_MS = 120_000;
const DESTROY_TIMEOUT_MS = 15_000;
const SANDBOX_LEASE_MS = 1_800_000;

const WORK_DIR = '/tmp/criu-bench';
const IMG_DIR = `${WORK_DIR}/img`;
const IMG_TAR = `${WORK_DIR}/img.tgz`;
/** How long the counter runs before the dump: ~20 ticks at 200ms. */
const PRE_DUMP_WAIT_S = 4;
/** After a restore: a continued counter reads ~counterAtDump+5, a fresh one ~5. */
const POST_RESTORE_WAIT_S = 1;
/** Raw bytes per transfer chunk; base64 (~131 KB) stays under MAX_ARG_STRLEN. */
const TRANSFER_CHUNK_BYTES = 96 * 1024;

const CAP_SYS_PTRACE = 19n;
const CAP_SYS_ADMIN = 21n;
const CAP_CHECKPOINT_RESTORE = 40n;

/**
 * Installs CRIU with whatever package manager the image has. CRIU before
 * 3.17 can't restore rseq state, so on glibc >= 2.35 the restored process
 * segfaults; distro packages that old (Ubuntu 22.04 ships 3.16) are upgraded.
 * Debian/Ubuntu use the CRIU project's OBS repo first (Ubuntu 24.04 dropped
 * criu from its archive), then the distro archive. Prints `method=` and
 * `version=` lines on success.
 */
function installScript(sudo: string): string {
  return `
set -u
S="${sudo}"
MIN=3.17
criu_ver() { $S criu --version 2>/dev/null | sed -n 's/^Version: *//p' | head -1; }
recent() { v=$(criu_ver); [ -n "$v" ] && [ "$(printf '%s\\n%s\\n' "$MIN" "$v" | sort -V | head -1)" = "$MIN" ]; }
apt_i() { $S env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>/tmp/criu-apt.err; }
if command -v criu >/dev/null 2>&1 && recent; then
  echo method=preinstalled
elif command -v apt-get >/dev/null 2>&1; then
  . /etc/os-release
  case "$ID" in
    ubuntu) OBS="xUbuntu_$VERSION_ID" ;;
    debian) OBS="Debian_$VERSION_ID" ;;
    *) OBS="" ;;
  esac
  $S env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
  method=""
  if [ -n "$OBS" ] && apt_i curl gpg ca-certificates \
    && curl -fsSL "https://download.opensuse.org/repositories/devel:/tools:/criu/$OBS/Release.key" \
      | gpg --dearmor | $S tee /etc/apt/trusted.gpg.d/criu-obs.gpg >/dev/null; then
    echo "deb https://download.opensuse.org/repositories/devel:/tools:/criu/$OBS/ /" | $S tee /etc/apt/sources.list.d/criu-obs.list >/dev/null
    $S env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
    apt_i criu && method=apt-obs
  fi
  if [ -z "$method" ]; then
    apt_i criu && method=apt || { echo "error=apt install criu failed (OBS + archive): $(grep '^E:' /tmp/criu-apt.err | tail -2)" >&2; exit 2; }
  fi
  echo "method=$method"
elif command -v apk >/dev/null 2>&1; then
  $S apk add --no-cache criu >/dev/null 2>&1 || { echo "error=apk add criu failed" >&2; exit 2; }
  echo method=apk
elif command -v dnf >/dev/null 2>&1; then
  $S dnf install -y -q criu >/dev/null 2>&1 || { echo "error=dnf install criu failed" >&2; exit 2; }
  echo method=dnf
elif command -v yum >/dev/null 2>&1; then
  $S yum install -y -q criu >/dev/null 2>&1 || { echo "error=yum install criu failed" >&2; exit 2; }
  echo method=yum
else
  echo "error=no supported package manager" >&2; exit 2
fi
command -v criu >/dev/null 2>&1 || { echo "error=criu not on PATH after install" >&2; exit 2; }
echo "version=$(criu_ver)"
recent || { echo "error=criu $(criu_ver) is older than $MIN (no rseq restore)" >&2; exit 2; }
`;
}

/** Key=value probe of identity, caps and kernel. Never fails. */
const PROBE_SCRIPT = `
echo "uid=$(id -u)"
if [ "$(id -u)" = 0 ]; then echo sudo=root
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then echo sudo=yes
else echo sudo=no; fi
S=""; [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null && S="sudo -n"
echo "capEff=$($S sh -c 'grep CapEff /proc/self/status' | awk '{print $2}')"
echo "seccomp=$(grep '^Seccomp:' /proc/self/status | awk '{print $2}')"
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
echo "procVersion=$(head -c 160 /proc/version 2>/dev/null)"
[ -e /proc/sys/kernel/ns_last_pid ] && echo nsLastPid=yes || echo nsLastPid=no
echo "ptraceScope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo none)"
echo "pid1=$(tr '\\0' ' ' </proc/1/cmdline 2>/dev/null | head -c 80)"
echo "cpuVendor=$(grep -m1 vendor_id /proc/cpuinfo | cut -d: -f2 | xargs)"
echo "cpuModel=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)"
grep -qw avx512f /proc/cpuinfo && echo avx512=yes || echo avx512=no
`;

/** Starts the in-memory counter loop detached; it writes its own pid. */
const START_WORKLOAD = [
  `rm -rf ${WORK_DIR} && mkdir -p ${IMG_DIR} && cd ${WORK_DIR}`,
  `setsid sh -c 'echo $$ > ${WORK_DIR}/pid; i=0; while :; do i=$((i+1)); echo $i > ${WORK_DIR}/counter; sleep 0.2; done' </dev/null >/dev/null 2>&1 &`,
  `for _ in $(seq 1 50); do [ -s ${WORK_DIR}/pid ] && break; sleep 0.1; done`,
  `cat ${WORK_DIR}/pid`,
].join('\n');

function parseKv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function hasCap(capEffHex: string | undefined, bit: bigint): boolean {
  if (!capEffHex || !/^[0-9a-f]+$/i.test(capEffHex)) return false;
  return ((BigInt(`0x${capEffHex}`) >> bit) & 1n) === 1n;
}

function tailLines(output: string | undefined, n: number): string {
  return (output ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .slice(-n)
    .join('\n');
}

function mustExit(result: CommandResult, what: string): CommandResult {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${result.exitCode}): ${tailLines(result.stderr || result.stdout, 8) || 'no output'}`);
  }
  return result;
}

function exec(box: SandboxInterface, command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<CommandResult> {
  return withTimeout(
    box.runCommand(command, { timeout: timeoutMs }),
    timeoutMs + 15_000,
    `exec timed out after ${timeoutMs}ms`,
  ) as Promise<CommandResult>;
}

/**
 * Runs `command` (may be multi-line), prints its in-box wall-clock `ms=` and
 * leaves its exit status in `$rc`; exits with it unless `keepGoing`.
 */
function timed(command: string, opts: { keepGoing?: boolean } = {}): string {
  return [
    NOW_NS_FN,
    't0=$(now_ns)',
    '{',
    command,
    '}',
    'rc=$?',
    't1=$(now_ns)',
    'echo "ms=$(( (t1 - t0) / 1000000 ))"',
    ...(opts.keepGoing ? [] : ['exit $rc']),
  ].join('\n');
}

/** Restore from IMG_DIR, then wait and read the counter the restored loop keeps writing. */
function restoreScript(sudo: string): string {
  return [
    `cd ${WORK_DIR}`,
    timed(`${sudo}criu restore -D ${IMG_DIR} -d -o ${WORK_DIR}/restore.log -v4 >/dev/null 2>&1`, { keepGoing: true }),
    `if [ $rc != 0 ]; then ${sudo}tail -n 15 ${WORK_DIR}/restore.log >&2; exit $rc; fi`,
    `sleep ${POST_RESTORE_WAIT_S}`,
    `pid=$(cat ${WORK_DIR}/pid)`,
    `if ${sudo}kill -0 $pid 2>/dev/null; then echo alive=yes; else echo alive=no; fi`,
    `echo "counter=$(cat ${WORK_DIR}/counter)"`,
  ].join('\n');
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-criu',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox CRIU',
  iterations: 1,
  concurrency: 1,
  participants: criuProviders,
  // A provider that can't complete the round trip (restore with memory intact on
  // the same box and on a fresh box) scores 0; the rest score the share of checks passed.
  scoring: {
    metrics: [
      { key: 'checksPassedPct', unit: '%', floor: 0, ceiling: 100, higherIsBetter: true, weights: { median: 1, p95: 0, p99: 0 } },
    ],
    success: {
      requireData: { criuSupported: true },
    },
  },
  display: {
    metrics: [
      { key: 'checksPassedPct', label: 'Checks passed (%)', unit: '%', direction: 'higher-better', decimals: 0 },
      { key: 'checksPassed', label: 'Checks passed', direction: 'higher-better', decimals: 0 },
      { key: 'checksTotal', label: 'Checks total', direction: 'higher-better', decimals: 0 },
      { key: 'dumpMs', label: 'Dump', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'restoreMs', label: 'Restore', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'crossBoxRestoreMs', label: 'Cross-box restore', unit: 'ms', direction: 'lower-better', decimals: 0 },
      { key: 'imageBytes', label: 'Image size', unit: 'bytes', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'create', label: 'Create sandbox' },
      { key: 'privileges', label: 'Root + checkpoint caps' },
      { key: 'kernel', label: 'Kernel checkpoint/restore support' },
      { key: 'criu_install', label: 'Install CRIU' },
      { key: 'criu_check', label: 'criu check' },
      { key: 'dump', label: 'Dump running process' },
      { key: 'restore', label: 'Restore on same box' },
      { key: 'memory_preserved', label: 'In-memory state survives' },
      { key: 'cross_box_restore', label: 'Restore on a new box' },
      { key: 'cross_box_memory', label: 'In-memory state survives (new box)' },
      { key: 'destroy', label: 'Destroy sandboxes' },
    ],
    byStep: { defaultLayout: 'matrix' },
    overview: { defaultMetric: 'supportedPct', defaultLayout: 'ranking' },
  },
  onComplete: (outcome) =>
    writeCiCapabilitiesResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/sandbox_criu'),
      runConfig: outcome.config,
      benchmarkSlug: 'sandbox-criu',
    }),
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure, log } = ctx;
  const provider = participant.name;
  const compute = participant.createCompute() as {
    sandbox: { create(options?: CreateSandboxOptions): Promise<SandboxInterface> };
  };

  const matrix: ProviderCapabilityMatrix = {};
  const metrics: Record<string, number> = {};
  let sandbox: SandboxInterface | undefined;
  let secondBox: SandboxInterface | undefined;
  /** '' when root, 'sudo -n ' with passwordless sudo. */
  let sudo = '';
  let counterAtDump = 0;

  const createOptions: CreateSandboxOptions = {
    ...(participant.sandboxOptions ?? {}),
    // Briq refuses create-time timeout; the bench's own timeouts still bound it.
    ...(participant.name === 'briq' ? {} : { timeout: SANDBOX_LEASE_MS }),
  };
  const createBox = () =>
    withTimeout(compute.sandbox.create(createOptions), participant.timeout ?? CREATE_TIMEOUT_MS, 'Sandbox creation timed out', (s) => s.destroy());

  async function check(
    name: string,
    fn: () => Promise<JsonObject | void>,
    opts: { requires?: string[] } = {},
  ): Promise<void> {
    if (!sandbox) return;
    await step(name, async () => {
      try {
        const blocker = (opts.requires ?? []).find((dep) => !matrix[dep]?.passed);
        if (blocker) throw new Error(`blocked by ${blocker}`);
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
      // recorded into matrix + measured inside the step
    });
  }

  async function install(box: SandboxInterface): Promise<Record<string, string>> {
    const result = mustExit(await exec(box, timed(installScript(sudo)), INSTALL_TIMEOUT_MS), 'criu install');
    return parseKv(result.stdout);
  }

  await step('create', async () => {
    sandbox = await createBox();
    matrix['create'] = { passed: true };
    measure({ passed: true });
  }).catch((err: unknown) => {
    const error = formatError(err);
    measure({ passed: false, error });
    matrix['create'] = { passed: false, error };
    log('sandbox create failed', { level: 'error', meta: { provider, error } });
  });

  let probe: Record<string, string> = {};
  try {
    await check('privileges', async () => {
      probe = parseKv((await exec(sandbox!, PROBE_SCRIPT)).stdout);
      if (probe.sudo === 'yes') sudo = 'sudo -n ';
      const detail = {
        uid: probe.uid ?? '',
        sudo: probe.sudo ?? '',
        capEff: probe.capEff ?? '',
        seccomp: probe.seccomp ?? '',
        ptraceScope: probe.ptraceScope ?? '',
        pid1: probe.pid1 ?? '',
      };
      if (probe.sudo === 'no') throw new Error(`not root and no passwordless sudo (uid ${probe.uid})`);
      const caps = probe.capEff;
      const ptrace = hasCap(caps, CAP_SYS_PTRACE);
      const checkpoint = hasCap(caps, CAP_SYS_ADMIN) || hasCap(caps, CAP_CHECKPOINT_RESTORE);
      if (!ptrace || !checkpoint) {
        throw new Error(
          `root lacks caps: CapEff=${caps ?? '?'} (CAP_SYS_PTRACE ${ptrace ? 'yes' : 'no'}, CAP_SYS_ADMIN|CAP_CHECKPOINT_RESTORE ${checkpoint ? 'yes' : 'no'})`,
        );
      }
      return detail;
    });

    await check('kernel', async () => {
      if (!probe.kernel) probe = parseKv((await exec(sandbox!, PROBE_SCRIPT)).stdout);
      const detail = {
        kernel: probe.kernel ?? '',
        arch: probe.arch ?? '',
        cpuVendor: probe.cpuVendor ?? '',
        cpuModel: probe.cpuModel ?? '',
        avx512: probe.avx512 === 'yes',
      };
      if (/gvisor/i.test(probe.procVersion ?? '')) throw new Error(`gVisor sandbox kernel (${probe.kernel}) — no CRIU`);
      if (probe.nsLastPid !== 'yes') {
        throw new Error(`/proc/sys/kernel/ns_last_pid missing — kernel ${probe.kernel} built without CONFIG_CHECKPOINT_RESTORE`);
      }
      return detail;
    });

    await check('criu_install', async () => {
      const kv = await install(sandbox!);
      metrics.installMs = Number(kv.ms ?? 0);
      return { method: kv.method ?? '', version: kv.version ?? '', installMs: metrics.installMs };
    });

    await check('criu_check', async () => {
      const result = await exec(sandbox!, `${sudo}criu check 2>&1`, CRIU_TIMEOUT_MS);
      if (result.exitCode !== 0 || !/looks good/i.test(result.stdout)) {
        throw new Error(`criu check failed (exit ${result.exitCode}): ${tailLines(result.stdout || result.stderr, 8)}`);
      }
    }, { requires: ['criu_install'] });

    await check('dump', async () => {
      const pid = mustExit(await exec(sandbox!, START_WORKLOAD), 'start workload').stdout.trim().split('\n').pop()!;
      if (!/^\d+$/.test(pid)) throw new Error(`workload did not report a pid: "${pid}"`);
      const dump = await exec(
        sandbox!,
        [
          `sleep ${PRE_DUMP_WAIT_S}`,
          `cd ${WORK_DIR}`,
          timed(`${sudo}criu dump -t ${pid} -D ${IMG_DIR} -o ${WORK_DIR}/dump.log -v4 >/dev/null 2>&1`, { keepGoing: true }),
          `if [ $rc != 0 ]; then ${sudo}tail -n 15 ${WORK_DIR}/dump.log >&2; ${sudo}kill ${pid} 2>/dev/null; exit $rc; fi`,
          `if ${sudo}kill -0 ${pid} 2>/dev/null; then echo stillRunning=yes; else echo stillRunning=no; fi`,
          `echo "counter=$(cat ${WORK_DIR}/counter)"`,
          `${sudo}tar -C ${WORK_DIR} -czf ${IMG_TAR} img pid && ${sudo}chmod 644 ${IMG_TAR}`,
          `echo "imageBytes=$(stat -c %s ${IMG_TAR})"`,
        ].join('\n'),
        CRIU_TIMEOUT_MS,
      );
      mustExit(dump, 'criu dump');
      const kv = parseKv(dump.stdout);
      if (kv.stillRunning === 'yes') throw new Error('process still running after dump (dump should stop it)');
      counterAtDump = Number(kv.counter ?? 0);
      metrics.dumpMs = Number(kv.ms ?? 0);
      metrics.imageBytes = Number(kv.imageBytes ?? 0);
      return { pid: Number(pid), counterAtDump, dumpMs: metrics.dumpMs, imageBytes: metrics.imageBytes };
    }, { requires: ['criu_check'] });

    let restoredCounter = 0;
    await check('restore', async () => {
      const result = mustExit(await exec(sandbox!, restoreScript(sudo), CRIU_TIMEOUT_MS), 'criu restore');
      const kv = parseKv(result.stdout);
      if (kv.alive !== 'yes') throw new Error('restore exited 0 but the process is not running');
      restoredCounter = Number(kv.counter ?? 0);
      metrics.restoreMs = Number(kv.ms ?? 0);
      return { restoreMs: metrics.restoreMs };
    }, { requires: ['dump'] });

    await check('memory_preserved', async () => {
      if (restoredCounter <= counterAtDump) {
        throw new Error(`counter did not continue: ${restoredCounter} after restore vs ${counterAtDump} at dump`);
      }
      return { counterAtDump, restoredCounter };
    }, { requires: ['restore'] });

    if (matrix['restore']?.passed) {
      let crossCounter = 0;
      await check('cross_box_restore', async () => {
        // Stop the same-box copy first so nothing else writes the image dir.
        await exec(sandbox!, `${sudo}kill $(cat ${WORK_DIR}/pid) 2>/dev/null; true`);
        const size = metrics.imageBytes;
        if (!size) throw new Error('no image size recorded');
        const srcSha = (await exec(sandbox!, `sha256sum ${IMG_TAR} | cut -d' ' -f1`)).stdout.trim();
        if (!/^[0-9a-f]{64}$/.test(srcSha)) throw new Error(`could not hash image on source box: "${srcSha}"`);
        secondBox = await createBox();
        await install(secondBox).catch((err) => {
          throw new Error(`second box criu install: ${formatError(err)}`);
        });
        mustExit(await exec(secondBox, `rm -rf ${WORK_DIR} && mkdir -p ${WORK_DIR} && : > ${WORK_DIR}/img.b64`), 'second box workdir');
        for (let offset = 0; offset < size; offset += TRANSFER_CHUNK_BYTES) {
          const chunk = mustExit(
            await exec(sandbox!, `dd if=${IMG_TAR} bs=${TRANSFER_CHUNK_BYTES} skip=${offset / TRANSFER_CHUNK_BYTES} count=1 2>/dev/null | base64 -w0`),
            'read image chunk',
          ).stdout.trim();
          mustExit(await exec(secondBox, `printf '%s\\n' '${chunk}' >> ${WORK_DIR}/img.b64`), 'write image chunk');
        }
        const dst = await exec(
          secondBox,
          `cd ${WORK_DIR} && while read -r l; do printf '%s' "$l" | base64 -d; done < img.b64 > img.tgz && sha256sum img.tgz | cut -d' ' -f1 && tar -xzf img.tgz`,
        );
        const dstSha = dst.stdout.trim().split('\n')[0] ?? '';
        if (dst.exitCode !== 0 || dstSha !== srcSha) {
          throw new Error(`image transfer corrupted: ${srcSha} vs ${dstSha || '?'} ${tailLines(dst.stderr, 3)}`.trim());
        }
        const result = mustExit(await exec(secondBox, restoreScript(sudo), CRIU_TIMEOUT_MS), 'cross-box criu restore');
        const kv = parseKv(result.stdout);
        if (kv.alive !== 'yes') throw new Error('restore exited 0 but the process is not running');
        crossCounter = Number(kv.counter ?? 0);
        metrics.crossBoxRestoreMs = Number(kv.ms ?? 0);
        return { crossBoxRestoreMs: metrics.crossBoxRestoreMs };
      });

      await check('cross_box_memory', async () => {
        if (crossCounter <= counterAtDump) {
          throw new Error(`counter did not continue: ${crossCounter} on the new box vs ${counterAtDump} at dump`);
        }
        return { counterAtDump, crossCounter };
      }, { requires: ['cross_box_restore'] });
    }
  } finally {
    if (sandbox || secondBox) {
      await step('destroy', async () => {
        if (secondBox) {
          await withTimeout(secondBox.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'second box destroy timeout').catch(() => {});
        }
        if (sandbox) {
          await withTimeout(sandbox.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timed out');
        }
      }, { reportConcurrency: false }).then(
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
    if (sandbox) log('sandbox', { level: 'info', meta: { provider, sandboxId: sandboxId(sandbox) } });
  }

  const checksTotal = Object.keys(matrix).length;
  const checksPassed = Object.values(matrix).filter((f) => f.passed).length;
  const checksPassedPct = checksTotal === 0 ? 0 : Math.round((checksPassed / checksTotal) * 100);
  const criuSupported =
    matrix['memory_preserved']?.passed === true && matrix['cross_box_memory']?.passed === true;
  measure({ checksPassed, checksTotal, checksPassedPct, criuSupported, ...metrics });
  return {
    data: {
      features: matrix,
      checksPassed,
      checksTotal,
      checksPassedPct,
      criuSupported,
      ...metrics,
    } as unknown as JsonObject,
  };
});

export const beforeExit = () => drainLateCleanups();
