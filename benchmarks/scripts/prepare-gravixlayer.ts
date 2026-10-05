import 'dotenv/config';
import { GravixLayer } from 'gravixlayer';

const POLICY_NAME = 'computesdk-benchmarks-egress';

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
}

main().catch((error) => {
  console.error('Failed to prepare GravixLayer for benchmarks:', error);
  process.exit(1);
});
