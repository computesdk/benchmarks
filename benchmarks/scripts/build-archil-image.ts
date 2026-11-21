/**
 * Builds the Archil image at the size the bench creates sandboxes at, so they
 * start from its snapshot instead of cold-booting, and exports ARCHIL_IMAGE_ID
 * for the bench step. Building a tag again rebuilds it, so this runs before the
 * timed step rather than inside create().
 *
 * Usage: build-archil-image.ts [vcpus memoryMiB]   (default 1 vCPU / 2048 MiB)
 */
import { appendFileSync } from 'node:fs';
import { Archil } from 'disk';
import { ARCHIL_BASE_IMAGE } from '../sandbox/archil-image.js';

async function main() {
  const [vcpuCount, memSizeMiB] = process.argv.slice(2).map(Number);
  const archil = new Archil({ apiKey: process.env.ARCHIL_API_KEY!, region: process.env.ARCHIL_REGION! });
  const image = await archil.images.build({ source: ARCHIL_BASE_IMAGE, vcpuCount, memSizeMiB });
  console.log(`Archil image ${image.imageId} (${image.vcpuCount} vCPU / ${image.memSizeMiB} MiB) is ${image.status}`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `ARCHIL_IMAGE_ID=${image.imageId}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
