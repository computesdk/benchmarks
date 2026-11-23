/**
 * VolumeAdapters — THIN wrappers over the computesdk volume surface.
 *
 * The durable home for provider volume support is the SDK itself:
 * `compute.volume.create/get/list/delete`, `CreateInstanceOptions.volumes`
 * (create-time mounts), and `instance.attachVolume`/`detachVolume` (runtime
 * attach) shipped in computesdk #980. Provider wire shapes (daytona's
 * `volumes:[{volumeId}]`, namespace's `persistency_kind`, vercel's `mounts`
 * map, ...) live in the `@computesdk/*` packages — this file only encodes
 * which style each provider mounts with plus the few bench-specific
 * tolerances verify runs exposed.
 *
 * Everything still here is deliberate:
 * - namespace destroy tolerates the 403 our API key's RBAC produces.
 * - tenki attach retries through the SYNC_PENDING window (SDK attachVolume
 *   is the raw call; a hardening follow-up belongs SDK-side).
 * - archil's "volume" is the shared bench disk referenced by
 *   ARCHIL_DISK_ID — no CRUD, mounted via the diskId create option.
 */

export const MOUNT_PATH = '/mnt/bench-volume';

export interface VolumeHandle {
  /** Provider-assigned id, when the API returns one. */
  id?: string;
  name: string;
  /** Opaque SDK object some mounts need (modal Volume, beam Volume). */
  native?: unknown;
}

export interface MountedSandbox {
  sandbox: any;
  /** Wall-clock ms of the `compute.sandbox.create` portion. */
  createMs: number;
  /** Wall-clock ms of any post-create attach work (0 for create-time mounts). */
  mountMs: number;
}

interface MountArgs {
  compute: any;
  sandboxOptions?: Record<string, any>;
  mountPath: string;
  volume: VolumeHandle;
}

export interface VolumeAdapter {
  provider: string;
  /** Reporting label — block-backed vs object-backed, shown in iteration data. */
  storageClass: 'block' | 'object' | 'unknown';
  mountStyle: 'create' | 'runtime' | 'native';
  /** Env vars beyond the participant's requiredEnvVars the adapter needs. */
  requiredEnv?: string[];
  /** Real mounted path when the provider fixes it — archil exec mode always
   *  mounts the disk at /mnt/archil regardless of the requested path. */
  mountPath?: string;
  createVolume(name: string, mountPath: string, compute: any): Promise<VolumeHandle>;
  createMounted(args: MountArgs): Promise<MountedSandbox>;
  destroyVolume(volume: VolumeHandle, compute: any): Promise<void>;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  try {
    const rendered = JSON.stringify(err);
    return new Error(rendered === '{}' ? String(err) : rendered);
  } catch {
    return new Error(String(err));
  }
}

/** A failed runtime attach leaks the just-created sandbox (the bench only
 *  receives it on success) — destroy on failure. */
async function destroyQuietly(sandbox: any): Promise<void> {
  try {
    await sandbox?.destroy?.();
  } catch { /* best-effort cleanup */ }
}

/* ------------------------- shared SDK-backed pieces ------------------------- */

/** compute.volume.create({name}) — returns the unified Volume handle. */
function sdkCreateVolume(compute: any) {
  return async (name: string): Promise<VolumeHandle> => {
    const v = await compute.volume.create({ name });
    return { id: v.id, name: v.name ?? name, native: v.native };
  };
}

/** compute.volume.delete(idOrName). `tolerate` swallows expected errors
 *  (e.g. namespace's RBAC 403 on DestroyPersistentVolumes). */
function sdkDestroyVolume(compute: any, tolerate?: (err: Error) => boolean) {
  return async (volume: VolumeHandle): Promise<void> => {
    try {
      await compute.volume.delete(volume.id ?? volume.name);
    } catch (err) {
      const e = asError(err);
      if (tolerate?.(e)) {
        console.warn(`volume ${volume.name} left orphaned:`, e.message);
        return;
      }
      throw e;
    }
  };
}

/** Create-time mount: `compute.sandbox.create({..., volumes: [mount]})` —
 *  the provider maps the unified VolumeMount onto its own wire shape. */
function sdkCreateMounted(args: MountArgs): Promise<MountedSandbox> {
  const t0 = performance.now();
  return args.compute.sandbox
    .create({
      ...(args.sandboxOptions ?? {}),
      volumes: [{ volume: args.volume, mountPath: args.mountPath }],
    })
    .then((sandbox: any) => ({ sandbox, createMs: performance.now() - t0, mountMs: 0 }));
}

/** Runtime attach: create, then `instance.attachVolume(volume, mountPath)`. */
function sdkRuntimeAttach(args: MountArgs, attach: (sandbox: any) => Promise<void>): Promise<MountedSandbox> {
  const t0 = performance.now();
  return args.compute.sandbox
    .create(args.sandboxOptions ?? {})
    .then(async (sandbox: any) => {
      const createMs = performance.now() - t0;
      const t1 = performance.now();
      try {
        await attach(sandbox);
      } catch (err) {
        await destroyQuietly(sandbox);
        throw asError(err);
      }
      return { sandbox, createMs, mountMs: performance.now() - t1 };
    });
}

/* ------------------------------ adapters ------------------------------ */

const CREATE_MOUNT_PROVIDERS: Array<Pick<VolumeAdapter, 'provider' | 'storageClass'>> = [
  { provider: 'daytona', storageClass: 'object' },      // S3-backed fuse mount
  { provider: 'e2b', storageClass: 'object' },
  { provider: 'modal', storageClass: 'unknown' },
  { provider: 'beam', storageClass: 'object' },
  { provider: 'blaxel', storageClass: 'unknown' },
  { provider: 'vercel', storageClass: 'object' },       // Drive
  { provider: 'namespace', storageClass: 'block' },     // persistent volume tags
  { provider: 'northflank', storageClass: 'block' },    // RWX volumes
  { provider: 'sandbox0', storageClass: 'unknown' },    // claim mounts
  { provider: 'microsandbox', storageClass: 'block' },
  { provider: 'sail', storageClass: 'object' },         // file system on object storage
  { provider: 'styne', storageClass: 'unknown' },
];

const RUNTIME_ATTACH_PROVIDERS: Array<Pick<VolumeAdapter, 'provider' | 'storageClass'>> = [
  { provider: 'novita', storageClass: 'block' },
  // miosa has no leg on purpose: its volumes attach to "computers", a
  // separate product — sandbox records carry no computer_id to attach to.
  { provider: 'luxor', storageClass: 'block' },
  { provider: 'createos', storageClass: 'object' },     // BYO S3 disk
];

function sdkAdapter(provider: string, storageClass: VolumeAdapter['storageClass'], mountStyle: 'create' | 'runtime', extra?: Partial<VolumeAdapter>): VolumeAdapter {
  return {
    provider,
    storageClass,
    mountStyle,
    createVolume: (name, _mountPath, compute) => sdkCreateVolume(compute)(name),
    createMounted:
      mountStyle === 'create'
        ? sdkCreateMounted
        : (args) => sdkRuntimeAttach(args, (s) => s.attachVolume(args.volume, args.mountPath)),
    destroyVolume: (volume, compute) => sdkDestroyVolume(compute)(volume),
    ...extra,
  };
}

const adapters = new Map<string, VolumeAdapter>();

for (const { provider, storageClass } of CREATE_MOUNT_PROVIDERS) {
  adapters.set(provider, sdkAdapter(provider, storageClass, 'create'));
}
for (const { provider, storageClass } of RUNTIME_ATTACH_PROVIDERS) {
  adapters.set(provider, sdkAdapter(provider, storageClass, 'runtime'));
}

/* --------------------- bench-specific tolerances --------------------- */

// microsandbox: create volumes with an explicit size. The bench writes
// ~256MiB plus small files; the provider default may be smaller, which
// stalls seq-write at the data timeout instead of erroring.
adapters.set('microsandbox', {
  ...sdkAdapter('microsandbox', 'block', 'create'),
  createVolume: async (name, _mountPath, compute) => {
    const v = await compute.volume.create({ name, sizeBytes: 4 * 1024 * 1024 * 1024 });
    return { id: v.id, name: v.name ?? name, native: v.native };
  },
});

// namespace: our API key's RBAC lacks DestroyPersistentVolumes — leave the
// tag-keyed volume orphaned (cheap) instead of failing a measured leg.
adapters.set('namespace', {
  ...sdkAdapter('namespace', 'block', 'create'),
  destroyVolume: (volume, compute) =>
    sdkDestroyVolume(compute, (e) => /403|permission_denied|PERMISSION_DENIED/i.test(e.message))(volume),
});

// tenki: attachVolume throws SYNC_PENDING while a fresh volume's initial
// sync-back is in flight — retry until the window clears.
adapters.set('luxor', {
  ...sdkAdapter('luxor', 'block', 'runtime'),
  createMounted: (args) =>
    sdkRuntimeAttach(args, async (sandbox) => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          await sandbox.attachVolume(args.volume, args.mountPath);
          return;
        } catch (err) {
          const e = asError(err);
          const syncPending = /SYNC_PENDING|sync.?pending/i.test(e.message) || e.name === 'VolumeSyncPendingError';
          if (!syncPending || Date.now() > deadline) throw e;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }),
});

// createos: BYO-S3 disk — the SDK resolves CREATEOS_S3_* env at volume
// create; the adapter just declares which envs the leg needs.
adapters.set('createos', {
  ...adapters.get('createos')!,
  requiredEnv: ['CREATEOS_S3_BUCKET', 'CREATEOS_S3_ENDPOINT', 'CREATEOS_S3_ACCESS_KEY', 'CREATEOS_S3_SECRET_KEY'],
});

/* ------------------------------ archil ------------------------------ */

// Archil's product IS the persistent disk — the bench attaches the shared
// disk referenced by ARCHIL_DISK_ID via the `diskId` create option. No
// volume CRUD exists to unify (and the shared disk is never destroyed).
adapters.set('archil', {
  provider: 'archil',
  storageClass: 'block',
  mountStyle: 'native',
  requiredEnv: ['ARCHIL_DISK_ID'],
  // Exec-mode runCommands check the disk out at ARCHIL_MOUNT_ROOT inside an
  // ephemeral container — any other path is transient container rootfs.
  mountPath: '/mnt/archil',
  async createVolume() {
    const diskId = env('ARCHIL_DISK_ID');
    return { id: diskId, name: diskId };
  },
  async createMounted(args) {
    const t0 = performance.now();
    const sandbox = await args.compute.sandbox.create({
      ...(args.sandboxOptions ?? {}),
      diskId: args.volume.id,
    });
    return { sandbox, createMs: performance.now() - t0, mountMs: 0 };
  },
  async destroyVolume() {
    // The benchmark disk is shared infra — never destroyed.
  },
});

/* ------------------------------ lookup ------------------------------ */

export function getVolumeAdapter(provider: string): VolumeAdapter | undefined {
  return adapters.get(provider);
}
