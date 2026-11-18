import '../src/env.js';

const NAME = 'node22-8cpu-16gb';
const MEMORY_MB = 16384;
const VCPU = 8;
// The CPU benchmark only needs bash + coreutils + sha256sum; node:22 mirrors
// the image the other xlarge templates are built from.
const IMAGE = 'node:22';
const POLL_MS = 20_000;
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

async function req(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function main() {
  const base = process.env.MOSAIC_API_URL?.replace(/\/$/, '');
  const token = process.env.MOSAIC_API_TOKEN;
  if (!base || !token) {
    throw new Error('MOSAIC_API_URL and MOSAIC_API_TOKEN environment variables are required');
  }

  // Environments are named snapshots — skip the build when one already
  // answers to NAME so the workflow step stays idempotent.
  const list = await req(base, token, 'GET', '/v1/snapshots');
  const findEnv = (snapshots: any[] | undefined) =>
    (snapshots ?? []).find((s: any) => s.name === NAME || s.id === NAME);
  let existing = findEnv(list.json?.snapshots);

  if (existing) {
    console.log(`Mosaic environment ${NAME} already exists, skipping build`);
  } else {
    const created = await req(base, token, 'POST', '/v1/environments', {
      image: IMAGE,
      name: NAME,
      memory_mb: MEMORY_MB,
      vcpu: VCPU,
    });
    if (created.status >= 400) {
      const message = JSON.stringify(created.json);
      if (message.includes('already')) {
        console.log(`Mosaic environment ${NAME} already exists, skipping build`);
      } else {
        throw new Error(`environment build request failed (${created.status}): ${message}`);
      }
    } else {
      const operationId = created.json?.id;
      const deadline = Date.now() + BUILD_TIMEOUT_MS;
      while (true) {
        const op = await req(base, token, 'GET', `/v1/operations/${encodeURIComponent(operationId)}`);
        if (op.json?.status === 'succeeded') {
          console.log(`Mosaic environment ${NAME} built successfully (${MEMORY_MB} MB / ${VCPU} vCPU)`);
          break;
        }
        if (op.json?.status === 'failed' || Date.now() > deadline) {
          throw new Error(`environment build failed: ${JSON.stringify(op.json)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
  }

  // The snapshot only replicates onto hosts that have already booted it —
  // ask for fleet coverage so xlarge creates don't pin to one host. Failure
  // is non-fatal: a single-host environment still restores correctly.
  existing = existing ?? findEnv((await req(base, token, 'GET', '/v1/snapshots')).json?.snapshots);
  if (existing && existing.coverage?.complete === false) {
    const fill = await req(base, token, 'POST', `/v1/snapshots/${encodeURIComponent(NAME)}/replicas`, {
      replicas: 'fleet',
    });
    if (fill.status >= 400) {
      console.warn(`replica fill request failed (${fill.status}): ${JSON.stringify(fill.json)}`);
    } else {
      console.log(`Requested fleet replica coverage for ${NAME}`);
    }
  }
}

main().catch((error) => {
  console.error('Failed to build Mosaic environment:', error);
  process.exit(1);
});
