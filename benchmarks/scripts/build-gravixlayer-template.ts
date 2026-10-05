import 'dotenv/config';
import { gravixlayer } from '@computesdk/gravixlayer';

const NAME = 'node22-8cpu-16gb';

async function main() {
  const apiKey = process.env.GRAVIXLAYER_API_KEY;
  if (!apiKey) {
    throw new Error('GRAVIXLAYER_API_KEY environment variable is not set');
  }

  const provider = gravixlayer({ apiKey });
  try {
    await provider.template.create({
      name: NAME,
      fromImage: 'node:22',
      vcpu: 8,
      memoryMb: 16384,
      diskMb: 10240,
    });
    console.log(`GravixLayer template ${NAME} built successfully`);
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
  console.error('Failed to build GravixLayer template:', error);
  process.exit(1);
});
