import { UNTESTED_SANDBOX_PROVIDERS } from './untested.js';

const LOGO_BASE_URL = 'https://logos.computesdk.com/api/svg';
const LABEL_HEIGHT = 40;
const CHIP_WIDTH = 180;
const CHIP_HEIGHT = 36;
const CHIP_GAP = 12;
const BOTTOM_PADDING = 16;

export interface UntestedProvider {
  name: string;
  /** Logomark as a data: URI, so it renders inside an SVG shown as <img>. */
  logo: string | null;
}

const escape = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const displayName = (name: string): string =>
  name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');

async function fetchLogomark(provider: string): Promise<string | null> {
  try {
    const res = await fetch(`${LOGO_BASE_URL}/${provider}/normalized/logomark-light`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    if (!body.trimStart().startsWith('<svg')) return null;
    return `data:image/svg+xml;base64,${Buffer.from(body).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Untested providers with their logos, minus any that have results in this chart. */
export async function loadUntestedProviders(testedProviders: string[]): Promise<UntestedProvider[]> {
  const tested = new Set(testedProviders);
  const names = UNTESTED_SANDBOX_PROVIDERS.filter((name) => !tested.has(name));
  return Promise.all(names.map(async (name) => ({ name, logo: await fetchLogomark(name) })));
}

function chipsPerRow(width: number): number {
  return Math.max(1, Math.floor((width + CHIP_GAP) / (CHIP_WIDTH + CHIP_GAP)));
}

/** Vertical space the section takes; 0 when there is nothing to list. */
export function untestedSectionHeight(count: number, width: number): number {
  if (count === 0) return 0;
  const rows = Math.ceil(count / chipsPerRow(width));
  return LABEL_HEIGHT + rows * CHIP_HEIGHT + (rows - 1) * CHIP_GAP + BOTTOM_PADDING;
}

/** "Untested" label plus one logo + name chip per provider, starting at (x, y). */
export function renderUntestedSection(providers: UntestedProvider[], x: number, y: number, width: number): string {
  if (providers.length === 0) return '';
  const perRow = chipsPerRow(width);
  let svg = `
  <!-- Untested providers -->
  <text x="${x}" y="${y + 26}" style="font:600 12px Inter,Arial,sans-serif;fill:#57606a;letter-spacing:.5px">UNTESTED</text>
  <text x="${x + 90}" y="${y + 26}" style="font:12px Inter,Arial,sans-serif;fill:#57606a">Not benchmarked yet</text>
`;
  providers.forEach((provider, index) => {
    const chipX = x + (index % perRow) * (CHIP_WIDTH + CHIP_GAP);
    const chipY = y + LABEL_HEIGHT + Math.floor(index / perRow) * (CHIP_HEIGHT + CHIP_GAP);
    const logo = provider.logo
      ? `<image x="${chipX + 10}" y="${chipY + 8}" width="20" height="20" href="${provider.logo}" xlink:href="${provider.logo}"/>`
      : `<rect x="${chipX + 10}" y="${chipY + 8}" width="20" height="20" fill="#d0d7de"/>`;
    svg += `  <rect x="${chipX}" y="${chipY}" width="${CHIP_WIDTH}" height="${CHIP_HEIGHT}" fill="#f6f8fa" stroke="#d0d7de" stroke-width="1"/>
  ${logo}
  <text x="${chipX + 40}" y="${chipY + 23}" style="font:600 14px Inter,Arial,sans-serif;fill:#57606a">${escape(displayName(provider.name))}</text>
`;
  });
  return svg;
}
