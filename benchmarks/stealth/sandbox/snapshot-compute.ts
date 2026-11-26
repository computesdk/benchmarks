import { CreateosSandboxClient, pollUntil } from '@nodeops-createos/sandbox';
import { CREATE_TIMEOUT_MS, type SnapshotCapabilities, type Compute } from '../src/util/snapshot.js';
import type { ProviderConfig } from './types.js';

interface CreateosSnapshot {
  id: string;
  status: 'creating' | 'ready' | 'failed' | 'deleting';
}

/** Use CreateOS full snapshot artifacts in the snapshot and fanout suites. */
export function snapshotCompute(provider: ProviderConfig): Compute {
  const compute: Compute = provider.createCompute();
  if (provider.name !== 'createos') return compute;

  const { http } = new CreateosSandboxClient();
  const snapshotPath = (id: string) => `/v1/snapshots/${encodeURIComponent(id)}`;
  const snapshot = {
    capabilities: {
      scope: 'rootfs',
      memory: true,
      destroysSource: false,
      source: 'kept',
      fork: true,
      readiness: 'immediate', // create() waits for the full artifact to become ready.
    } satisfies SnapshotCapabilities,
    async create(id: string, options?: { name?: string }) {
      const artifact = await http.request<CreateosSnapshot>(
        'POST', `/v1/sandboxes/${encodeURIComponent(id)}/snapshots`,
        { body: { type: 'full', name: options?.name } },
      );
      try {
        if (artifact.status !== 'ready') {
          await pollUntil({
            poll: () => http.request<CreateosSnapshot>('GET', snapshotPath(artifact.id)),
            done: (s) => s.status === 'ready',
            failed: (s) => s.status === 'failed' || s.status === 'deleting'
              ? `Snapshot ${s.id} is ${s.status}` : undefined,
            timeoutMs: provider.timeout ?? CREATE_TIMEOUT_MS,
          });
        }
      } catch (error) {
        await snapshot.delete(artifact.id).catch(() => {});
        throw error;
      }
      return { id: artifact.id };
    },
    delete: (id: string) => http.request('DELETE', snapshotPath(id)),
  };
  return {
    snapshot,
    sandbox: {
      getById: (id) => compute.sandbox.getById!(id),
      async create(options) {
        if (!options?.snapshotId) return compute.sandbox.create(options);
        const { id } = await http.request<{ id: string }>('POST', '/v1/sandboxes', {
          body: { snapshot_id: options.snapshotId },
        });
        try {
          const sandbox = await compute.sandbox.getById!(id);
          if (!sandbox) throw new Error(`Unable to attach to restored CreateOS sandbox ${id}`);
          return sandbox;
        } catch (error) {
          await http.request('DELETE', `/v1/sandboxes/${encodeURIComponent(id)}`).catch(() => {});
          throw error;
        }
      },
    },
  };
}
