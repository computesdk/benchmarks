import 'dotenv/config';
import { Template } from '@superserve/sdk';

const NAME = 'node22-8cpu-16gb';

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
      diskMib: 10240,
    });
    await template.waitUntilReady();
    console.log(`Superserve template ${NAME} built successfully`);
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
