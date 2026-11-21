import type { TemplateCreateOptions } from '@superserve/sdk';
import { readFileSync } from 'node:fs';

// Keep this recipe versioned so an existing ready template cannot silently
// retain an older guest runtime after the installer pin changes.
export const SUPERSERVE_VOLUME_TEMPLATE_NAME = 'csdk-node22-volumes-v1';

function templateUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('SUPERSERVE_VOLUME_TEMPLATE_ID must be a template UUID');
  }
  return value;
}

export function superserveVolumeTemplateId(): string {
  const value = process.env.SUPERSERVE_VOLUME_TEMPLATE_ID?.trim();
  return value ? templateUuid(value) : SUPERSERVE_VOLUME_TEMPLATE_NAME;
}

export function superserveVolumeTemplateSpec(): Omit<TemplateCreateOptions, 'apiKey'> {
  const recipe = readFileSync(new URL('../scripts/superserve-volume-runtime.sh', import.meta.url), 'utf8');
  const delimiter = 'SUPERSERVE_VOLUME_RUNTIME';
  if (recipe.split('\n').includes(delimiter)) throw new Error('Volume runtime recipe delimiter collision');
  return {
    name: SUPERSERVE_VOLUME_TEMPLATE_NAME,
    from: 'node:22',
    vcpu: 2,
    memoryMib: 2048,
    diskMib: 8192,
    steps: [
      { run: "bash -s <<'" + delimiter + "'\n" + recipe + '\n' + delimiter },
      { user: { name: 'node', sudo: false } },
    ],
  };
}

interface PreparedTemplate {
  id: string;
  getInfo(): Promise<{ status: string }>;
  rebuild(): Promise<unknown>;
  waitUntilReady(): Promise<unknown>;
}

interface TemplateApi {
  create(options: TemplateCreateOptions): Promise<PreparedTemplate>;
  list(options: { apiKey: string; namePrefix: string }): Promise<Array<{ id: string; name: string }>>;
  connect(id: string, options: { apiKey: string }): Promise<PreparedTemplate>;
}

function duplicateName(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'status' in error && error.status === 409) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b409\b|already (?:exists|taken)|duplicate/i.test(message);
}

export async function ensureSuperserveVolumeTemplate(apiKey: string, api: TemplateApi, existingId?: string): Promise<string> {
  if (!apiKey) throw new Error('SUPERSERVE_API_KEY environment variable is not set');
  if (existingId) {
    const existing = await api.connect(templateUuid(existingId), { apiKey });
    await existing.waitUntilReady();
    return existing.id;
  }

  let template: PreparedTemplate;
  try {
    template = await api.create({ apiKey, ...superserveVolumeTemplateSpec() });
  } catch (error) {
    if (!duplicateName(error)) throw error;
    const match = (await api.list({ apiKey, namePrefix: SUPERSERVE_VOLUME_TEMPLATE_NAME }))
      .find((info) => info.name === SUPERSERVE_VOLUME_TEMPLATE_NAME);
    if (!match) throw new Error('Superserve volume template name conflicts but no matching template exists');
    template = await api.connect(match.id, { apiKey });
    const info = await template.getInfo();
    if (info.status === 'ready') return template.id;
    if (info.status === 'failed') await template.rebuild();
  }

  await template.waitUntilReady();
  return template.id;
}
