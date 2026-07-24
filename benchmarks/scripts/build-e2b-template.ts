import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';

async function main() {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error('E2B_API_KEY environment variable is not set');
  }

  const template = Template().fromTemplate('base');

  try {
    await Template.build(template, 'base-8cpu-16gb', {
      cpuCount: 8,
      memoryMB: 16384,
      onBuildLogs: defaultBuildLogger(),
    });
    console.log('E2B template base-8cpu-16gb built successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.toLowerCase().includes('already exists') ||
      message.toLowerCase().includes('already taken') ||
      message.toLowerCase().includes('duplicate')
    ) {
      console.log('Template already exists, skipping');
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error('Failed to build E2B template:', error);
  process.exit(1);
});
