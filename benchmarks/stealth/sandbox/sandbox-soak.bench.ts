/**
 * Sandbox Soak: a long-running durability benchmark. One unit of work is one
 * ~6h "shift": reattach to the provider's persistent sandbox via
 * `compute.sandbox.getById`, confirm the detached chain writer is alive, then
 * run a 60s check tick for the whole shift window — tail the new lines of
 * `<workdir>/soak-chain.log` and verify each link is `sha256(previous)`.
 *
 * A writer inside the sandbox appends `N <unix_seconds> <sha256>` at
 * ~1 line/sec, always reading the previous hash back from the file so
 * mid-chain corruption self-propagates into every later head. Score =
 * uptimePct (ticks where the box exec'd, the chain grew, and every new link
 * verified) plus integrityPct (ticks without a corrupt link). The ts column
 * is observational: monotonically non-decreasing (a backward ts = bad line),
 * it exposes a paused/resumed VM as a timestamp gap, and feeds coveragePct
 * (the share of the shift window the writer was provably writing) and
 * pauseGaps (ts jumps > 5s). A box exec'ing fine whose chain head lags > ~2
 * tick intervals behind wall clock fails as a stalled writer.
 *
 * The sandbox is the test subject: it is NEVER destroyed at shift end — only
 * epoch rollover (24h, daily) and dead-box replacement destroy. Replaced ids
 * are destroyed by id (not just via a live handle) so a box getById can't
 * reach doesn't leak; ids that still can't be destroyed are persisted in
 * state.orphanedSandboxIds and reaped on a later shift. The soak is
 * bound to ONE sandbox: getById returning a different sandboxId (e.g. a
 * snapshot-recreated clone) is a same-sandbox violation — counted, flagged,
 * and replaced, never silently adopted. Per-provider state
 * (sandbox id, verified offset, counters) lives at
 * results/sandbox_soak/state/<provider>.json, cached between workflow shifts
 * and read back by the next shift.
 *
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Run:
 *   pnpm bench benchmarks/stealth/sandbox/sandbox-soak.bench.ts --provider e2b --iterations 1
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '@benchsdk/client';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';
import {
  CHAIN_FILE,
  SOAK_CHECK_INTERVAL_MS,
  SOAK_EPOCH_MS,
  SOAK_LIFETIME_HEADROOM_MS,
  SOAK_SHIFT_MS,
  SUITE_CONFIG,
  TICK_LAG_S,
  TICK_TIMEOUT_MS,
  WRITER_SCRIPT,
  WRITER_SCRIPT_BODY,
  freshState,
  soakLifetime,
  declaredLifetime,
  launchWriterCmd,
  writerAliveCmd,
  readState,
  stateFilePath,
  tailCmd,
  verifyTail,
  writeState,
  type SoakState,
} from './sandbox-soak.js';
import { writeSoakLegacyResults } from './sandbox-soak-legacy-results.js';
import { fullPrecisionScoring } from '../src/util/scoring.js';
import { formatError } from '../src/util/error.js';
import { drainLateCleanups, withTimeout } from '../src/util/timeout.js';
import {
  CREATE_TIMEOUT_MS,
  DESTROY_TIMEOUT_MS,
  resolveWorkdir,
  type SnapshotSandbox,
} from '../src/util/snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SoakCompute {
  sandbox: {
    create(options?: Record<string, any>): Promise<SnapshotSandbox>;
    getById?(id: string): Promise<SnapshotSandbox | null>;
    /** Lifecycle primitive: destroy by id — no live handle needed. */
    destroy?(instanceId: string): Promise<void>;
  };
}

export const config = defineBenchmarkConfig({
  // CI mints cadence variants by exporting BENCHMARK_SLUG/BENCHMARK_NAME
  // (scheduled runs report as sandbox-soak-stealth); literals keep local runs
  // working.
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'sandbox-soak',
  benchmarkName: process.env.BENCHMARK_NAME ?? 'Sandbox Soak',
  iterations: SUITE_CONFIG.defaultIterations,
  concurrency: 1,
  groupBy: 'round',
  participants: providers.map(soakParticipant),
  scoring: fullPrecisionScoring({
    metrics: [
      // Headline: the share of shift ticks where the box exec'd, the chain
      // grew, and every new link verified — "stayed alive and correct".
      { key: 'uptimePct', unit: '%', ceiling: 100, higherIsBetter: true, weights: { median: 0.7, p95: 0, p99: 0 } },
      // Same denominator as uptimePct; diverges only for exec-ok-but-corrupt
      // ticks (tracked separately as corruptTicks).
      { key: 'integrityPct', unit: '%', ceiling: 100, higherIsBetter: true, weights: { median: 0.3, p95: 0, p99: 0 } },
    ],
    // A record without the shift's measures is not a soak run — a provider
    // that could not attach/create gets no composite at all.
    success: {
      requireData: { measured: true },
    },
  }),
  display: {
    metrics: [
      { key: 'uptimePct', label: 'Uptime', unit: '%', direction: 'higher-better', decimals: 1 },
      { key: 'integrityPct', label: 'Chain integrity', unit: '%', direction: 'higher-better', decimals: 1 },
      { key: 'ticksAttempted', label: 'Ticks', unit: 'ticks', direction: 'higher-better', decimals: 0 },
      { key: 'ticksPassed', label: 'Passed ticks', unit: 'ticks', direction: 'higher-better', decimals: 0 },
      { key: 'ticksFailed', label: 'Failed ticks', unit: 'ticks', direction: 'lower-better', decimals: 0 },
      { key: 'corruptTicks', label: 'Corrupt ticks', unit: 'ticks', direction: 'lower-better', decimals: 0 },
      { key: 'coveragePct', label: 'Write coverage', unit: '%', direction: 'higher-better', decimals: 1 },
      { key: 'pauseGaps', label: 'Pause gaps', unit: 'gaps', direction: 'lower-better', decimals: 0 },
      { key: 'maxClockSkewS', label: 'Guest clock skew', unit: 's', direction: 'lower-better', decimals: 0 },
      { key: 'chainLength', label: 'Chain length', unit: 'lines', direction: 'higher-better', decimals: 0 },
      { key: 'restarts', label: 'Box restarts', direction: 'lower-better', decimals: 0 },
      { key: 'writerRestarts', label: 'Writer restarts', direction: 'lower-better', decimals: 0 },
      { key: 'sameSandboxViolations', label: 'Same-sandbox violations', direction: 'lower-better', decimals: 0 },
      { key: 'soakAgeHours', label: 'Soak age', unit: 'h', direction: 'higher-better', decimals: 1 },
      { key: 'wallClockMs', label: 'Wall clock', unit: 'ms', direction: 'lower-better', decimals: 0 },
    ],
    steps: [
      { key: 'state-load', label: 'Load provider state', order: 0 },
      { key: 'epoch-rollover', label: 'Epoch rollover', order: 1 },
      { key: 'attach', label: 'Attach / create sandbox', order: 2 },
      { key: 'writer-check', label: 'Ensure chain writer', order: 3 },
      { key: 'check-loop', label: 'Soak check loop', order: 4 },
      { key: 'state-save', label: 'Persist state', order: 5 },
    ],
    overview: { defaultMetric: 'uptimePct', defaultLayout: 'ranking' },
  },
  onComplete: (outcome): Promise<void> =>
    writeSoakLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, '../../../results/sandbox_soak'),
      scoring: config.scoring,
    }),
});

/**
 * Soak-only participant overrides. providers.ts stays untouched: other
 * benches want the shared defaults.
 * - TTL-bound providers get their maximum lifetime capped by the shift, or
 *   the box dies at the 5–15 min default and the shift measures the TTL.
 *   The task re-derives it from the SDK's declared `lifetime.maxMs` when
 *   present (the compute only exists inside the task).
 * - miosa's default SOMA runtime kills detached processes when the exec
 *   returns; firecracker keeps them.
 * - Superserve sizes at the template, so the 24/7 box uses the smallest
 *   node-22 template (provisioned by build-superserve-soak-template.ts).
 */
function soakParticipant(p: ProviderConfig): ProviderConfig {
  const opts: Record<string, any> = { ...p.sandboxOptions };
  const lifetime = soakLifetime(p.name);
  opts.timeout = lifetime.lifetimeMs;
  // Briq refuses create-time timeout; its idle sleep window is the provider bound.
  if (p.name === 'briq') delete opts.timeout;
  // Archil persistent VMs carry a shared 900s maxTtlSeconds (providers.ts),
  // which wins over `timeout`; drop it so the box lives through the shift.
  if (p.name === 'archil' && opts.maxTtlSeconds !== undefined) {
    delete opts.maxTtlSeconds;
    opts.timeout ??= SOAK_SHIFT_MS + SOAK_LIFETIME_HEADROOM_MS;
  }
  // Sandbox0 carries a shared 900s hardTtl (providers.ts) that outranks
  // `timeout` in the adapter; set both claim TTLs to the soak lifetime.
  if (p.name === 'sandbox0') {
    const secs = Math.ceil(opts.timeout / 1000);
    opts.ttl = secs;
    opts.hardTtl = secs;
  }
  if (p.name === 'miosa') opts.runtime = 'firecracker';
  if (p.name === 'superserve') opts.templateId = 'csdk-node22-1cpu-256mb';
  return { ...p, sandboxOptions: opts };
}

const ATTACH_TIMEOUT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, log, step, measure } = ctx;
  const p = participant;
  const provider = p.name;

  const compute = p.createCompute() as SoakCompute;
  const createTimeout = p.timeout ?? CREATE_TIMEOUT_MS;
  const cleanupTimeout = p.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS;

  const resultsDir = path.resolve(__dirname, '../../../results/sandbox_soak');
  const stateFile = stateFilePath(resultsDir, provider);

  let state: SoakState = freshState();
  let sandbox: SnapshotSandbox | undefined;
  let getByIdSupported = true;

  // This shift's measures (state.* counters are cumulative for the epoch).
  let ticksAttempted = 0;
  let ticksPassed = 0;
  let ticksFailed = 0;
  let corruptTicks = 0;
  let corruptLines = 0;
  let coveredSeconds = 0;
  let pauseGaps = 0;
  let shiftStartMs = 0;
  /** Host minus guest clock (s) at the last tick / largest seen this shift. */
  let clockSkewS: number | null = null;
  let maxClockSkewS = 0;
  const declared = declaredLifetime(compute);
  const lifetime = soakLifetime(provider, undefined, declared);
  const createOptions = provider === 'briq'
    ? p.sandboxOptions
    : lifetime ? { ...p.sandboxOptions, timeout: lifetime.lifetimeMs } : p.sandboxOptions;
  let attachError: string | undefined;
  /** Replaced ids this shift confirmed destroyed via the orphan path. */
  let orphansReaped = 0;

  const rStart = performance.now();

  const orphanIds = (): string[] => (state.orphanedSandboxIds ??= []);

  function rememberOrphan(id: string | null | undefined): void {
    if (id && !orphanIds().includes(id)) orphanIds().push(id);
  }

  const isGoneError = (err: unknown): boolean =>
    /not[ -]?found|does not exist|no such|\b404\b|\bgone\b/i.test(formatError(err));

  /**
   * Destroy a sandbox by id without a live handle. Previously every destroy
   * went through a getById handle, so when getById failed (API flake,
   * unsupported, or an unreachable-but-alive box) the recorded sandboxId was
   * abandoned while the box kept billing. Ids that still can't be destroyed
   * stay in state.orphanedSandboxIds and are retried on the next shift.
   * Callers must only pass ids of boxes being replaced, never the live one.
   */
  async function reapById(id: string | null | undefined, why: string): Promise<void> {
    if (!id) return;
    const destroy = compute.sandbox.destroy?.bind(compute.sandbox);
    if (typeof destroy !== 'function') {
      rememberOrphan(id);
      return;
    }
    const ok = await withTimeout(destroy(id), cleanupTimeout, `${why} destroy timeout`)
      .then(() => true)
      .catch((err: unknown) => {
        if (isGoneError(err)) return true;
        log(`${why} destroy failed`, { level: 'warn', meta: { error: formatError(err), sandboxId: id } });
        return false;
      });
    if (ok) {
      orphansReaped++;
      state.orphanedSandboxIds = orphanIds().filter((o) => o !== id);
    } else {
      rememberOrphan(id);
    }
  }

  async function uploadWriter(box: SnapshotSandbox, workdir: string): Promise<void> {
    const scriptPath = `${workdir}/${WRITER_SCRIPT}`;
    try {
      await box.filesystem.writeFile(scriptPath, WRITER_SCRIPT_BODY);
    } catch (err) {
      // Fallback for providers whose fs API is scoped or absent: base64
      // through runCommand, the baseline sandbox contract.
      log('filesystem.writeFile failed; falling back to base64 upload', {
        level: 'warn',
        meta: { error: formatError(err) },
      });
      const b64 = Buffer.from(WRITER_SCRIPT_BODY).toString('base64');
      await box.runCommand(`printf '%s' '${b64}' | base64 -d > ${scriptPath}`, { timeout: createTimeout });
    }
    await box.runCommand(`chmod +x ${scriptPath}`, { timeout: createTimeout });
  }

  /** Give a just-launched writer a bounded moment to seed the chain. */
  async function waitForChain(box: SnapshotSandbox, workdir: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await box
        .runCommand(`[ -s ${workdir}/${CHAIN_FILE} ] && echo ready || echo pending`, { timeout: 10_000 })
        .catch(() => null);
      if ((res?.stdout ?? '').includes('ready')) return;
      await sleep(1_000);
    }
  }

  /** Create a replacement sandbox and (re)start its chain + writer. */
  async function respawn(reason: string): Promise<void> {
    state.restarts++;
    state.respawnReason = reason;
    state.verifiedLines = 0;
    state.headHash = '';
    state.headTs = 0;
    const replacedId = state.sandboxId;
    let replacedDestroyed = false;
    if (sandbox) {
      replacedDestroyed = await withTimeout(sandbox.destroy(), cleanupTimeout, 'Old sandbox destroy timeout')
        .then(() => true)
        .catch((err: unknown) => {
          log('old sandbox destroy failed', { level: 'warn', meta: { error: formatError(err) } });
          rememberOrphan(sandbox?.sandboxId);
          return false;
        });
    }
    // The recorded box has no live handle this shift (getById miss /
    // unsupported) or its destroy just failed — reap by id so it can't leak.
    if (replacedId && (!replacedDestroyed || replacedId !== sandbox?.sandboxId)) {
      await reapById(replacedId, 'replaced sandbox');
    }
    sandbox = await withTimeout(
      compute.sandbox.create(createOptions),
      createTimeout,
      'Sandbox creation timed out',
      (s) => s.destroy(),
    );
    state.sandboxId = sandbox.sandboxId;
    const workdir = await resolveWorkdir(sandbox, createTimeout);
    state.workdir = workdir;
    await uploadWriter(sandbox, workdir);
    await sandbox.runCommand(launchWriterCmd(workdir), { timeout: createTimeout });
    await waitForChain(sandbox, workdir);
    writeState(stateFile, state);
  }

  try {
    // 1. Per-provider state from the last shift (missing/corrupt -> fresh).
    state = await step('state-load', async () => readState(stateFile), { reportConcurrency: false });

    // 2. Epoch rollover: retire a 24h-old (daily) soak and start a fresh chain.
    if (Date.now() - Date.parse(state.epochStartedAt) >= SOAK_EPOCH_MS) {
      await step(
        'epoch-rollover',
        async () => {
          if (state.sandboxId && getByIdSupported) {
            const old = await withTimeout(
              compute.sandbox.getById!(state.sandboxId!),
              createTimeout,
              'getById timed out',
            ).catch(() => null);
            let destroyed = false;
            if (old) {
              destroyed = await withTimeout(old.destroy(), cleanupTimeout, 'Epoch sandbox destroy timeout')
                .then(() => true)
                .catch((err: unknown) => {
                  log('epoch sandbox destroy failed', { level: 'warn', meta: { error: formatError(err) } });
                  return false;
                });
            }
            if (!destroyed) {
              // getById couldn't hand us a handle (miss, timeout, or
              // unsupported) or the destroy failed — reap by id anyway.
              await reapById(state.sandboxId, 'epoch sandbox');
            }
          }
          // Carry still-pending orphans across the epoch reset — otherwise
          // freshState drops them and the leak becomes invisible again.
          const carriedOrphans = [...orphanIds()];
          state = freshState(state.epochIndex + 1);
          state.orphanedSandboxIds = carriedOrphans;
          writeState(stateFile, state);
        },
        { reportConcurrency: false },
      );
    }

    // 3. Attach: reattach to the persisted sandbox, or respawn when the box
    // is gone / getById is unsupported / getById hands back a DIFFERENT
    // sandboxId. The soak is bound to a single sandbox id — a provider that
    // quietly recreates the box (e.g. from a snapshot) breaks the contract:
    // that is a same-sandbox violation — counted, flagged, replaced. A
    // dead-box replacement destroys what it replaces; everything else leaves
    // the subject running.
    // One deadline over the whole attach: some SDK calls in it (pwd, writer
    // upload) can hang on a promise that holds no timer or socket, and Node
    // then exits mid-task with code 0, recording nothing for the provider
    // (codesandbox). The deadline's timer turns that into a failed shift.
    await step('attach', () => withTimeout((async () => {
      getByIdSupported = typeof compute.sandbox.getById === 'function';
      let handle: SnapshotSandbox | null = null;
      if (state.sandboxId && getByIdSupported) {
        handle = await withTimeout(
          compute.sandbox.getById!(state.sandboxId),
          createTimeout,
          'getById timed out',
        ).catch((err: unknown) => {
          log('getById failed; respawning', { level: 'warn', meta: { error: formatError(err) } });
          return null;
        });
      }
      if (handle && handle.sandboxId !== state.sandboxId) {
        state.sameSandboxViolations++;
        log('getById returned a different sandboxId — same-sandbox violation', {
          level: 'warn',
          meta: { expected: state.sandboxId, got: handle.sandboxId },
        });
        await withTimeout(handle.destroy(), cleanupTimeout, 'Replaced sandbox destroy timeout').catch(
          (err: unknown) => {
            log('replaced sandbox destroy failed', { level: 'warn', meta: { error: formatError(err) } });
            rememberOrphan(handle?.sandboxId);
          },
        );
        await respawn('sandbox-id-changed');
      } else if (handle) {
        sandbox = handle;
      } else if (state.sandboxId) {
        // getById miss / unsupported: the recorded box has no handle here, so
        // respawn's reap-by-id is what keeps a live-but-unreachable box from
        // leaking.
        await respawn(getByIdSupported ? 'sandbox-gone' : 'getById-unsupported');
      } else {
        // First shift of an epoch: the initial create is not a restart.
        sandbox = await withTimeout(
          compute.sandbox.create(createOptions),
          createTimeout,
          'Sandbox creation timed out',
          (s) => s.destroy(),
        );
        state.sandboxId = sandbox.sandboxId;
        state.workdir = await resolveWorkdir(sandbox, createTimeout);
        state.verifiedLines = 0;
        state.headHash = '';
        state.headTs = 0;
        await uploadWriter(sandbox, state.workdir);
        await sandbox.runCommand(launchWriterCmd(state.workdir), { timeout: createTimeout });
        await waitForChain(sandbox, state.workdir);
      }
      // Reap ids earlier shifts replaced but could not destroy — persisted
      // orphans are retried here so transient provider errors don't leak
      // boxes indefinitely.
      for (const orphanId of [...orphanIds()]) {
        if (orphanId !== state.sandboxId) await reapById(orphanId, 'orphaned sandbox');
      }
      writeState(stateFile, state);
    })(), Math.max(ATTACH_TIMEOUT_MS, createTimeout * 5), 'attach timed out'));

    // 4. Ensure the chain writer is alive. A dead writer on a live box is a
    // writer restart; a box that cannot exec at all is a dead-box
    // replacement. Either way a stalled chain is a failed check, not a skip.
    await step('writer-check', async () => {
      let writerAlive = false;
      try {
        const res = await withTimeout(
          sandbox!.runCommand(writerAliveCmd(state.workdir!), { timeout: TICK_TIMEOUT_MS - 5_000 }),
          TICK_TIMEOUT_MS,
          'Writer probe timed out',
        );
        writerAlive = (res.stdout ?? '').includes('writer=alive');
        if (/writer=(alive|dead)/.test(res.stdout ?? '')) state.lastSeenAliveAt = new Date().toISOString();
      } catch (err) {
        log('writer probe failed', { level: 'warn', meta: { error: formatError(err) } });
      }
      if (writerAlive) return;

      const boxAlive = await withTimeout(
        sandbox!.runCommand('echo box-alive', { timeout: 10_000 }),
        TICK_TIMEOUT_MS,
        'Box probe timed out',
      )
        .then(() => true)
        .catch(() => false);
      if (!boxAlive) {
        await respawn('box-unreachable');
        return;
      }
      state.writerRestarts++;
      await sandbox!.runCommand(launchWriterCmd(state.workdir!), { timeout: createTimeout });
      await waitForChain(sandbox!, state.workdir!);
      writeState(stateFile, state);
    });

    // 5. Check loop: one exec per tick for the whole shift window. Pass iff
    // the exec succeeded AND every new link verified AND the chain grew.
    await step('check-loop', async () => {
      shiftStartMs = Date.now();
      while (Date.now() - shiftStartMs < SOAK_SHIFT_MS) {
        ticksAttempted++;
        state.ticksAttempted++;
        state.lastCheckAt = new Date().toISOString();
        let tickOk = false;
        try {
          const res = await withTimeout(
            sandbox!.runCommand(tailCmd(state.workdir!, state.verifiedLines + 1), {
              timeout: TICK_TIMEOUT_MS - 5_000,
            }),
            TICK_TIMEOUT_MS,
            'Tick exec timed out',
          );
          const v = verifyTail(res.stdout ?? '', state.verifiedLines, state.headHash, state.headTs);
          state.verifiedLines += v.newLines;
          state.headHash = v.lastHash;
          state.headTs = v.lastTs;
          corruptLines += v.badLines;
          coveredSeconds += v.coveredSeconds;
          pauseGaps += v.pauseGaps;
          state.pauseGaps += v.pauseGaps;
          if (v.badLines > 0) {
            corruptTicks++;
            state.corruptTicks++;
          }
          // Zero growth = stalled writer = failed check. A chain head lagging
          // > ~2 tick intervals behind the GUEST clock is the same failure:
          // the box execs fine but the writer stopped writing. Guest-relative
          // so a skewed guest clock (givemeanode) is not read as a dead
          // writer; host-vs-guest skew is reported on its own.
          const lagging = v.guestNowS > 0 && v.lastTs > 0 && v.guestNowS - v.lastTs > TICK_LAG_S;
          if (v.guestNowS > 0) {
            const skew = Date.now() / 1000 - v.guestNowS;
            clockSkewS = skew;
            if (Math.abs(skew) > Math.abs(maxClockSkewS)) maxClockSkewS = skew;
          }
          tickOk = v.newLines > 0 && v.badLines === 0 && !lagging;
          // Only a guest-clock echo proves the exec ran in the box; some
          // adapters return an empty non-throwing result for a dead box.
          if (v.guestNowS > 0) state.lastSeenAliveAt = new Date().toISOString();
        } catch (err) {
          log('tick exec failed', { level: 'warn', meta: { error: formatError(err) } });
        }
        if (tickOk) {
          ticksPassed++;
          state.ticksPassed++;
        } else {
          ticksFailed++;
          state.ticksFailed++;
        }
        writeState(stateFile, state);
        // A tick that overruns just starts the next tick late.
        await sleep(SOAK_CHECK_INTERVAL_MS);
      }
    });
  } catch (err) {
    attachError = formatError(err);
    log('soak shift failed before/inside check loop', { level: 'warn', meta: { error: attachError } });
  } finally {
    // 6. Persist state for the next shift. NEVER destroy the sandbox here —
    // it is the test subject; only epoch rollover and dead-box replacement
    // destroy.
    await step(
      'state-save',
      async () => {
        writeState(stateFile, state);
      },
      { reportConcurrency: false },
    ).catch((err: unknown) =>
      log('state save failed', { level: 'warn', meta: { error: formatError(err) } }),
    );
  }

  const wallClockMs = performance.now() - rStart;
  const uptimePct = ticksAttempted > 0 ? (ticksPassed / ticksAttempted) * 100 : 0;
  const integrityPct = ticksAttempted > 0 ? ((ticksAttempted - corruptTicks) / ticksAttempted) * 100 : 0;
  const soakAgeHours = Math.max(0, (Date.now() - Date.parse(state.epochStartedAt)) / 3_600_000);
  // This-shift window: fraction of the shift's elapsed wall-clock the writer
  // was provably writing (each verified line credits <= 1 writer-rate second,
  // so a paused box's huge ts jump earns ~1s, not 3600s).
  const shiftElapsedS = shiftStartMs > 0 ? (Date.now() - shiftStartMs) / 1000 : 0;
  const coveragePct = shiftElapsedS > 0 ? Math.min(100, (coveredSeconds / shiftElapsedS) * 100) : 0;

  measure({
    ticksAttempted,
    ticksPassed,
    ticksFailed,
    corruptTicks,
    corruptLines,
    uptimePct,
    integrityPct,
    coveragePct,
    pauseGaps,
    chainLength: state.verifiedLines,
    restarts: state.restarts,
    writerRestarts: state.writerRestarts,
    sameSandboxViolations: state.sameSandboxViolations,
    soakAgeHours,
    epochIndex: state.epochIndex,
    maxClockSkewS,
    measured: attachError === undefined,
    wallClockMs,
  });

  const meta = {
    provider,
    sandboxId: state.sandboxId,
    workdir: state.workdir,
    getByIdSupported,
    ticksAttempted,
    ticksPassed,
    ticksFailed,
    corruptTicks,
    corruptLines,
    uptimePct,
    integrityPct,
    coveragePct,
    coveredSeconds,
    pauseGaps,
    chainLength: state.verifiedLines,
    headTs: state.headTs,
    clockSkewS,
    maxClockSkewS,
    lifetimeMs: lifetime?.lifetimeMs ?? null,
    maxLifetimeMs: lifetime?.maxLifetimeMs ?? null,
    maxLifetimeShorterThanShift: lifetime?.maxShorterThanShift ?? false,
    lifetimeSource: lifetime?.source ?? null,
    defaultLifetimeMs: lifetime?.defaultLifetimeMs ?? null,
    lifetimeExtendable:
      lifetime?.extendable ?? (typeof declared?.extendable === 'boolean' ? declared.extendable : null),
    restarts: state.restarts,
    writerRestarts: state.writerRestarts,
    sameSandboxViolations: state.sameSandboxViolations,
    respawnReason: state.respawnReason ?? null,
    orphansReaped,
    orphansPending: state.orphanedSandboxIds?.length ?? 0,
    soakAgeHours,
    epochIndex: state.epochIndex,
    epochStartedAt: state.epochStartedAt,
    lastCheckAt: state.lastCheckAt,
    lastSeenAliveAt: state.lastSeenAliveAt,
    attachError: attachError ?? null,
    measured: attachError === undefined,
    wallClockMs,
  } as unknown as JsonObject;

  if (attachError) {
    throw new TaskError('soak shift failed: ' + attachError, {
      code: 'soak_shift_failed',
      data: { ...meta, replicateMs: [wallClockMs] } as JsonObject,
    });
  }

  log('soak shift completed', { level: 'info', meta });
  return {
    data: { ...meta, replicateMs: [wallClockMs] } as JsonObject,
    latencyMs: wallClockMs,
  };
});

export const beforeExit = () => drainLateCleanups();
