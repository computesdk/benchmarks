import '../src/env.js';
import { Template } from '@superserve/sdk';
import { ensureSuperserveVolumeTemplate, SUPERSERVE_VOLUME_TEMPLATE_NAME, superserveVolumeTemplateId } from '../sandbox/superserve-volume-template.js';

async function main() {
  const selected = superserveVolumeTemplateId();
  const id = await ensureSuperserveVolumeTemplate(
    process.env.SUPERSERVE_API_KEY ?? '', Template,
    selected === SUPERSERVE_VOLUME_TEMPLATE_NAME ? undefined : selected,
  );
  console.log('Superserve volume template is ready: ' + id);
}

main().catch((error) => {
  console.error('Failed to build Superserve volume template:', error);
  process.exit(1);
});
