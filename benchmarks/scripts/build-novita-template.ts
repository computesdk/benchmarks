import 'dotenv/config';
import { Novita } from 'novita-sandbox';

const NAME = 'node22-8cpu-16gb';

async function main() {
  const apiKey = process.env.NOVITA_API_KEY;
  if (!apiKey) {
    throw new Error('NOVITA_API_KEY environment variable is not set');
  }

  const sdk = new Novita({ apiKey });
  const template = sdk.template.new().fromNodeImage('22');

  try {
    await sdk.template.build(template, NAME, {
      cpuCount: 8,
      memoryMB: 16384,
    });
    console.log(`Novita template ${NAME} built successfully`);
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
  console.error('Failed to build Novita template:', error);
  process.exit(1);
});
