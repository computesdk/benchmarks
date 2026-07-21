import 'dotenv/config';
import fs from 'fs';

interface Plan {
  id: string;
  cpuResource?: number;
  ramResource?: number;
  [key: string]: any;
}

interface PlansResponse {
  plans?: Plan[];
  data?: { plans?: Plan[] };
}

async function main() {
  const token = process.env.NORTHFLANK_TOKEN;
  if (!token) {
    throw new Error('NORTHFLANK_TOKEN environment variable is not set');
  }

  const res = await fetch('https://api.northflank.com/v1/plans', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to list Northflank plans: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as PlansResponse | Plan[];
  // Log the raw response structure (keys only, not the full body) for debugging.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    console.log('Northflank plans response keys:', Object.keys(body).join(', '));
    if ('data' in body && body.data && typeof body.data === 'object') {
      console.log('Northflank plans response.data keys:', Object.keys(body.data as object).join(', '));
    }
  } else if (Array.isArray(body)) {
    console.log('Northflank plans response is an array of length', body.length);
  } else {
    console.log('Northflank plans response is of type', typeof body);
  }

  // The API may return plans at body.plans, body.data.plans, or as a bare array.
  const plans: Plan[] = Array.isArray(body)
    ? body
    : body.plans ?? body.data?.plans ?? [];

  if (plans.length === 0) {
    console.warn('Warning: No plans returned from Northflank API, falling back to nf-compute-50');
    const fallback = 'nf-compute-50';
    console.log(`NORTHFLANK_DEPLOYMENT_PLAN=${fallback}`);
    const githubEnv = process.env.GITHUB_ENV;
    if (githubEnv) {
      fs.appendFileSync(githubEnv, `NORTHFLANK_DEPLOYMENT_PLAN=${fallback}\n`);
    }
    return;
  }

  const targetCpu = 8;
  const targetRam = 16384; // 16 GiB in MB

  const exactMatch = plans.find(
    (p) => p.cpuResource === targetCpu && p.ramResource === targetRam,
  );

  let selectedPlan: Plan;
  if (exactMatch) {
    selectedPlan = exactMatch;
    console.log(`Found Northflank plan with exact match: ${selectedPlan.id} (${targetCpu} vCPU, ${targetRam} MB)`);
  } else {
    const suitable = plans.filter(
      (p) => (p.cpuResource ?? 0) >= targetCpu && (p.ramResource ?? 0) >= targetRam,
    );
    if (suitable.length === 0) {
      throw new Error(
        `No Northflank plan meets the target resources of ${targetCpu} vCPU / ${targetRam} MB`,
      );
    }
    // Pick the SMALLEST suitable plan by total resource footprint to minimise
    // the chance of exceeding Northflank project allowance. (1 vCPU ~= 2048 MB
    // for normalisation against RAM in MB.)
    suitable.sort((a, b) => {
      const sizeA = (a.cpuResource ?? 0) * 2048 + (a.ramResource ?? 0);
      const sizeB = (b.cpuResource ?? 0) * 2048 + (b.ramResource ?? 0);
      return sizeA - sizeB;
    });
    selectedPlan = suitable[0]!;
    console.warn(
      `Warning: no exact match for ${targetCpu} vCPU / ${targetRam} MB. ` +
        `Using smallest suitable plan: ${selectedPlan.id} ` +
        `(${selectedPlan.cpuResource ?? '?'} vCPU, ${selectedPlan.ramResource ?? '?'} MB)`,
    );
  }

  // Sanitise the plan ID before writing to GITHUB_ENV to avoid injection of
  // newlines or other shell/environment-file control characters.
  if (!/^[a-zA-Z0-9_-]+$/.test(selectedPlan.id)) {
    throw new Error(
      `Invalid Northflank plan ID: ${JSON.stringify(selectedPlan.id)} ` +
        `(must match /^[a-zA-Z0-9_-]+$/)`,
    );
  }

  console.log(`NORTHFLANK_DEPLOYMENT_PLAN=${selectedPlan.id}`);

  const githubEnv = process.env.GITHUB_ENV;
  if (githubEnv) {
    fs.appendFileSync(githubEnv, `NORTHFLANK_DEPLOYMENT_PLAN=${selectedPlan.id}\n`);
  }
}

main().catch((error) => {
  console.error('Failed to find Northflank plan:', error);
  process.exit(1);
});
