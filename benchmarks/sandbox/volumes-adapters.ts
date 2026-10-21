/**
 * Per-provider volume adapters for the volumes lifecycle benchmark.
 *
 * ComputeSDK has no unified `compute.volume` API yet, so each adapter wraps the
 * provider's native SDK (or REST API) behind one contract:
 *
 *   createVolume(name, mountPath)  → an independent storage object
 *   createMounted({compute, ...})  → a ComputeSDK sandbox with the volume mounted
 *   destroyVolume(handle)          → delete the volume
 *
 * Three mount styles hide behind `createMounted`:
 *
 *   'create'  — mount options merged into `compute.sandbox.create()` (the
 *               provider's ComputeSDK adapter already spreads providerOptions:
 *               daytona, e2b, modal, beam, blaxel, archil).
 *   'runtime' — ComputeSDK sandbox created plain, then attached via the native
 *               API (novita, miosa). `mountMs` carries the attach cost.
 *   'native'  — provider ComputeSDK adapter can't express the mount, so the
 *               native client creates the workload and `compute.sandbox.getById`
 *               wraps it (northflank).
 *
 * Providers without a volume feature have no registry entry — the task records
 * them as `volumes_not_supported`. Capability flags (POSIX probe results,
 * multi-attach) live in iteration data, not in adapter branching.
 *
 * v2 candidates: namespace (PersistentVolumes + instance-create attach),
 * microsandbox + sandbox0 (native create paths), tenki (session.attachVolume —
 * needs a session handle for a computesdk-created sandbox), createos (BYO-S3
 * disks — needs bucket creds), cloudflare (mountBucket is Worker-side,
 * unreachable through the compute surface), runloop (object mounts are
 * read-mostly injection, not a read-write volume).
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
  createVolume(name: string, mountPath: string): Promise<VolumeHandle>;
  createMounted(args: MountArgs): Promise<MountedSandbox>;
  destroyVolume(volume: VolumeHandle): Promise<void>;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function createViaCompute(
  args: MountArgs,
  extraOptions: Record<string, any>,
): Promise<MountedSandbox> {
  const t0 = performance.now();
  const sandbox = await args.compute.sandbox.create({
    ...(args.sandboxOptions ?? {}),
    ...extraOptions,
  });
  return { sandbox, createMs: performance.now() - t0, mountMs: 0 };
}

/* ---------------------------------- daytona ---------------------------------- */

const daytonaAdapter: VolumeAdapter = {
  provider: 'daytona',
  storageClass: 'object', // S3-backed fuse mount per Daytona docs
  mountStyle: 'create',
  async createVolume(name) {
    const { Daytona } = await import('@daytonaio/sdk');
    const daytona = new Daytona({ apiKey: env('DAYTONA_API_KEY') });
    const vol = await daytona.volume.get(name, true); // create if missing
    return { id: vol.id, name: vol.name, native: vol };
  },
  createMounted: (args) =>
    createViaCompute(args, {
      volumes: [{ volumeId: args.volume.id, mountPath: args.mountPath }],
    }),
  async destroyVolume(volume) {
    const { Daytona } = await import('@daytonaio/sdk');
    const daytona = new Daytona({ apiKey: env('DAYTONA_API_KEY') });
    await daytona.volume.delete(volume.native as never);
  },
};

/* ------------------------------------ e2b ------------------------------------ */

const e2bAdapter: VolumeAdapter = {
  provider: 'e2b',
  storageClass: 'object',
  mountStyle: 'create',
  async createVolume(name) {
    const { Volume } = await import('e2b');
    await Volume.create(name); // auth from E2B_API_KEY env
    return { name };
  },
  createMounted: (args) =>
    createViaCompute(args, {
      volumeMounts: { [args.mountPath]: args.volume.name },
    }),
  async destroyVolume(volume) {
    const { Volume } = await import('e2b');
    const info = await Volume.getInfo(volume.name).catch(() => undefined);
    await Volume.destroy(info?.volumeId ?? volume.name);
  },
};

/* ------------------------------------ modal ------------------------------------ */

const modalAdapter: VolumeAdapter = {
  provider: 'modal',
  storageClass: 'unknown',
  mountStyle: 'create',
  async createVolume(name) {
    const { ModalClient } = await import('modal');
    const client = new ModalClient({
      tokenId: env('MODAL_TOKEN_ID'),
      tokenSecret: env('MODAL_TOKEN_SECRET'),
      ...(process.env.MODAL_ENVIRONMENT ? { environment: process.env.MODAL_ENVIRONMENT } : {}),
    });
    const vol = await client.volumes.fromName(name, { createIfMissing: true });
    return { name, native: vol };
  },
  createMounted: (args) =>
    createViaCompute(args, {
      volumes: { [args.mountPath]: args.volume.native },
    }),
  async destroyVolume(volume) {
    const { ModalClient } = await import('modal');
    const client = new ModalClient({
      tokenId: env('MODAL_TOKEN_ID'),
      tokenSecret: env('MODAL_TOKEN_SECRET'),
      ...(process.env.MODAL_ENVIRONMENT ? { environment: process.env.MODAL_ENVIRONMENT } : {}),
    });
    await client.volumes.delete(volume.name);
  },
};

/* ------------------------------------ beam ------------------------------------ */

const beamAdapter: VolumeAdapter = {
  provider: 'beam',
  storageClass: 'object', // beam CloudBucket-style volumes
  mountStyle: 'create',
  async createVolume(name, mountPath) {
    const { Volume } = await import('@beamcloud/beam-js');
    const vol = new Volume(name, mountPath);
    await vol.getOrCreate();
    return { name, native: vol as unknown };
  },
  createMounted: (args) => createViaCompute(args, { volumes: [args.volume.native] }),
  async destroyVolume(volume) {
    // beam-js exposes no volume delete in the typed API — best effort.
    const native = volume.native as { delete?: () => Promise<void> };
    await native?.delete?.();
  },
};

/* ------------------------------------ blaxel ------------------------------------ */

const blaxelAdapter: VolumeAdapter = {
  provider: 'blaxel',
  storageClass: 'unknown',
  mountStyle: 'create',
  async createVolume(name) {
    const { VolumeInstance } = await import('@blaxel/core');
    await VolumeInstance.create({ name } as never);
    return { name };
  },
  createMounted: (args) =>
    createViaCompute(args, {
      volumes: [{ name: args.volume.name, mountPath: args.mountPath }],
    }),
  async destroyVolume(volume) {
    const { VolumeInstance } = await import('@blaxel/core');
    await VolumeInstance.delete(volume.name);
  },
};

/* ------------------------------------ archil ------------------------------------ */

// Archil's product IS the persistent disk — the bench attaches the disk
// referenced by ARCHIL_DISK_ID (already in the participant's sandboxOptions).
const archilAdapter: VolumeAdapter = {
  provider: 'archil',
  storageClass: 'block',
  mountStyle: 'create',
  requiredEnv: ['ARCHIL_DISK_ID'],
  async createVolume() {
    const diskId = env('ARCHIL_DISK_ID');
    return { id: diskId, name: diskId };
  },
  createMounted: (args) =>
    createViaCompute(args, { diskId: args.volume.id }),
  async destroyVolume() {
    // The benchmark disk is shared infra — never destroyed.
  },
};

/* ------------------------------------ novita ------------------------------------ */

const novitaAdapter: VolumeAdapter = {
  provider: 'novita',
  storageClass: 'block',
  mountStyle: 'runtime',
  async createVolume(name) {
    const { Novita } = await import('novita-sandbox');
    const novita = new Novita(); // NOVITA_API_KEY env
    await novita.volume.create(name);
    return { name };
  },
  async createMounted(args) {
    const t0 = performance.now();
    const sandbox = await args.compute.sandbox.create(args.sandboxOptions ?? {});
    const createMs = performance.now() - t0;

    const t1 = performance.now();
    const { Sandbox } = await import('novita-sandbox');
    const native = await Sandbox.connect(sandbox.sandboxId);
    await native.mountVolume(args.volume.name, args.mountPath);
    return { sandbox, createMs, mountMs: performance.now() - t1 };
  },
  async destroyVolume(volume) {
    const { Novita } = await import('novita-sandbox');
    const novita = new Novita();
    await novita.volume.destroy(volume.name);
  },
};

/* ------------------------------------ miosa ------------------------------------ */

const MIOSA_BASE_URL = 'https://api.miosa.ai/api/v1';

async function miosaFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${MIOSA_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env('MIOSA_API_KEY')}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`MIOSA ${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  }
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

const miosaAdapter: VolumeAdapter = {
  provider: 'miosa',
  storageClass: 'block',
  mountStyle: 'runtime',
  async createVolume(name) {
    const vol = await miosaFetch('/volumes', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return { id: vol?.id, name };
  },
  async createMounted(args) {
    const t0 = performance.now();
    const sandbox = await args.compute.sandbox.create(args.sandboxOptions ?? {});
    const createMs = performance.now() - t0;

    const t1 = performance.now();
    await miosaFetch(`/sandboxes/${sandbox.sandboxId}/volumes`, {
      method: 'POST',
      body: JSON.stringify({
        volumeId: args.volume.id,
        name: args.volume.name,
        mountPath: args.mountPath,
      }),
    });
    return { sandbox, createMs, mountMs: performance.now() - t1 };
  },
  async destroyVolume(volume) {
    await miosaFetch(`/volumes/${volume.id ?? volume.name}`, { method: 'DELETE' });
  },
};

/* ---------------------------------- northflank ---------------------------------- */

// The ComputeSDK northflank adapter doesn't expose `volumesToAttach`, so the
// native client creates the deployment service and getById wraps it.
const northflankAdapter: VolumeAdapter = {
  provider: 'northflank',
  storageClass: 'block',
  mountStyle: 'native',
  async createVolume(name, mountPath) {
    const client = await northflankClient();
    await client.create.volume({
      parameters: { projectId: env('NORTHFLANK_PROJECT_ID') },
      data: {
        name,
        mounts: [{ containerMountPath: mountPath }],
        spec: {
          accessMode: 'ReadWriteMany',
          storageClassName: 'nf-multi-rw',
          storageSize: 10240,
        },
      } as never,
    });
    return { name };
  },
  async createMounted(args) {
    const t0 = performance.now();
    const client = await northflankClient();
    const serviceName = `vol-bench-${Date.now()}`;
    await client.create.service.deployment({
      parameters: { projectId: env('NORTHFLANK_PROJECT_ID') },
      data: {
        name: serviceName,
        billing: { deploymentPlan: 'nf-compute-200' },
        deployment: {
          instances: 1,
          external: { imagePath: 'node:22' },
          docker: { configType: 'customCommand', customCommand: 'sleep infinity' },
        },
        createOptions: { volumesToAttach: [args.volume.name] },
      } as never,
    });
    const sandbox = await args.compute.sandbox.getById(serviceName);
    return { sandbox, createMs: performance.now() - t0, mountMs: 0 };
  },
  async destroyVolume(volume) {
    const client = await northflankClient();
    await (client as any).delete?.volume?.({
      parameters: { projectId: env('NORTHFLANK_PROJECT_ID'), volumeId: volume.name },
    }).catch(() => {});
  },
};

async function northflankClient(): Promise<any> {
  const { ApiClient, ApiClientInMemoryContextProvider } = await import(
    '@northflank/js-client'
  );
  const ctx = new ApiClientInMemoryContextProvider();
  ctx.addContext({
    name: 'vol-bench',
    token: env('NORTHFLANK_TOKEN'),
    host: 'https://api.northflank.com',
  });
  ctx.useContext('vol-bench');
  return new ApiClient(ctx, { throwErrorOnHttpErrorCode: true });
}

/* ---------------------------------- registry ---------------------------------- */

export const VOLUME_ADAPTERS: Record<string, VolumeAdapter> = {
  daytona: daytonaAdapter,
  e2b: e2bAdapter,
  modal: modalAdapter,
  beam: beamAdapter,
  blaxel: blaxelAdapter,
  archil: archilAdapter,
  novita: novitaAdapter,
  miosa: miosaAdapter,
  northflank: northflankAdapter,
};

export function getVolumeAdapter(provider: string): VolumeAdapter | undefined {
  return VOLUME_ADAPTERS[provider];
}
