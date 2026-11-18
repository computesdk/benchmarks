import '../src/env.js';
import { ConflictError, Template } from '@superserve/sdk';

// Sandbox sizes live on the template in Superserve (sandboxes inherit them;
// they cannot be overridden per-sandbox). The soak pins a box 24/7, so it
// runs on the smallest node-22 spec Superserve allows: 1 vCPU / 256 MiB.
// The disk needs headroom — node:22 on 1 GiB fails the build with
// image_too_large, which is what zeroed the soak on Nov 4.
const NAME = 'csdk-node22-1cpu-256mb';

const SPEC = {
  name: NAME,
  from: 'node:22',
  vcpu: 1,
  memoryMib: 256,
  diskMib: 10 * 1024,
} as const;

async function main() {
  const apiKey = process.env.SUPERSERVE_API_KEY;
  if (!apiKey) {
    throw new Error('SUPERSERVE_API_KEY environment variable is not set');
  }

  try {
    const template = await Template.create({ apiKey, ...SPEC });
    await template.waitUntilReady();
    console.log(`Superserve template ${NAME} built successfully`);
    return;
  } catch (error) {
    if (!(error instanceof ConflictError) && !isDuplicateName(error)) {
      throw error;
    }
  }

  // Name is taken: the create was a no-op, so verify the existing template is
  // actually usable — a failed template still returns 409 here and would let
  // the soak proceed into guaranteed sandbox-create rejections.
  // GET /templates/<arg> only accepts a UUID — Template.connect(NAME) returns
  // 400 — so resolve the name to an id via the list endpoint first.
  const infos = await Template.list({ apiKey });
  const match = infos.find((t) => t.name === NAME);
  if (!match) {
    throw new Error(`POST /templates returned 409 but no template named ${NAME} exists`);
  }
  const existing = await Template.connect(match.id, { apiKey });
  const info = await existing.getInfo();
  if (info.status === 'ready') {
    console.log(`Superserve template ${NAME} already exists and is ready`);
    return;
  }
  if (info.status === 'failed') {
    console.log(
      `Superserve template ${NAME} is failed (${info.errorMessage ?? 'no error'}), rebuilding`,
    );
    await existing.rebuild();
  }
  await existing.waitUntilReady();
  console.log(`Superserve template ${NAME} is ready`);
}

function isDuplicateName(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.toLowerCase().includes('already exists') ||
    message.toLowerCase().includes('already taken') ||
    message.toLowerCase().includes('duplicate') ||
    message.includes('409')
  );
}

main().catch((error) => {
  console.error('Failed to build Superserve template:', error);
  process.exit(1);
});
