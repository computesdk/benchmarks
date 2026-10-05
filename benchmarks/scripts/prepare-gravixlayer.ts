import 'dotenv/config';
import { GravixLayer } from 'gravixlayer';
import { gravixlayer } from '@computesdk/gravixlayer';

const TEMPLATE_NAME = 'node22-8cpu-16gb';
const POLICY_NAME = 'computesdk-benchmarks-egress';

async function ensureTemplate(apiKey: string) {
  const provider = gravixlayer({ apiKey });
  try {
    await provider.template.create({
      name: TEMPLATE_NAME,
      fromImage: 'node:22',
      vcpu: 8,
      memoryMb: 16384,
      diskMb: 10240,
    });
    console.log(`GravixLayer template ${TEMPLATE_NAME} built successfully`);
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

// Runtimes are egress fail-closed and @computesdk/gravixlayer cannot pass
// networkPolicyIds per sandbox.create, so benchmarks rely on a default
// account policy that opens egress for every new runtime (dax needs it for
// dependency installs).
async function ensureDefaultEgressPolicy(client: GravixLayer) {
  const page = await client.networkPolicies.list({ search: POLICY_NAME });
  const existing = page.policies.find((p) => p.name === POLICY_NAME);
  if (existing) {
    if (existing.isDefault) {
      console.log(`Network policy ${POLICY_NAME} already default, skipping`);
      return;
    }
    await client.networkPolicies.update(existing.id, { isDefault: true });
    console.log(`Network policy ${POLICY_NAME} marked as default`);
    return;
  }
  await client.networkPolicies.create(POLICY_NAME, {
    egressMode: 'allow_all',
    isDefault: true,
    description: 'ComputeSDK benchmarks: open egress for package installs inside benchmark sandboxes.',
  });
  console.log(`Network policy ${POLICY_NAME} created (allow_all, default)`);
}

async function main() {
  const apiKey = process.env.GRAVIXLAYER_API_KEY;
  if (!apiKey) {
    throw new Error('GRAVIXLAYER_API_KEY environment variable is not set');
  }

  await ensureDefaultEgressPolicy(new GravixLayer({ apiKey }));
  await ensureTemplate(apiKey);
}

main().catch((error) => {
  console.error('Failed to prepare GravixLayer for benchmarks:', error);
  process.exit(1);
});
