import '../src/env.js';
import { Template } from '@superserve/sdk';

// Rebuild of the CI capabilities template at Superserve's request: fresh
// node:22 (newer kernel), 8 vCPU / 16 GiB / 32 GiB disk (above the bench's
// 14 GiB free-space floor). Docker is intentionally NOT baked in — the bench
// brings dockerd up in-guest via ci-runtime.ts.
const NAME = 'csdk-node22-ci-8cpu-16gb-32gb';

async function main() {
  const apiKey = process.env.SUPERSERVE_API_KEY;
  if (!apiKey) {
    throw new Error('SUPERSERVE_API_KEY environment variable is not set');
  }

  try {
    const template = await Template.create({
      apiKey,
      name: NAME,
      from: 'node:22',
      vcpu: 8,
      memoryMib: 16384,
      diskMib: 32768,
    });
    await template.waitUntilReady();
    console.log(`Superserve template ${NAME} built: ${template.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.toLowerCase().includes('already exists') ||
      message.toLowerCase().includes('already taken') ||
      message.toLowerCase().includes('duplicate') ||
      message.includes('409')
    ) {
      console.log('Template already exists, skipping');
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error('Failed to build Superserve template:', error);
  process.exit(1);
});
