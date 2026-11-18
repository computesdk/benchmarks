import '../src/env.js';
import { Template } from '@superserve/sdk';

// Mirrors build-superserve-template.ts, plus Docker: `node -v` readiness needs
// Node and the ci-capabilities dockerd probes need the daemon baked into the
// image. readyCmd `docker info` makes the snapshot capture the running daemon,
// so every sandbox from this template boots with Docker up.
const NAME = 'node-22-docker';

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
      vcpu: 2,
      memoryMib: 2048,
      diskMib: 8192,
      steps: [
        { run: 'apt-get update && apt-get install -y curl ca-certificates iproute2 fuse-overlayfs' },
        { run: 'curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh' },
      ],
      startCmd: 'dockerd > /var/log/dockerd.log 2>&1',
      readyCmd: 'docker info',
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
