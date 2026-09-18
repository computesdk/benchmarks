/**
 * Pricing benchmark data: the public pricing page per sandbox provider plus
 * the extractors that pull each published rate off that page. Rates are
 * normalized to $/hour at the Dax spec (8 vCPU / 16 GiB) so they are
 * comparable to each other and to the dotcom /compare page, which uses the
 * same numbers.
 *
 * Extraction is literal: each `Extractor.pattern` has one capture group around
 * the price figure as printed on the page, with an optional `scale` that
 * converts the captured unit (e.g. per-second, per-core) to per-vCPU-hr or
 * per-GiB-hr. When a page redesign stops matching, the field is recorded as
 * missing rather than guessed — the history shows the drift.
 */

export interface PricingExtractor {
  /** Field the extracted number is stored under in the result. */
  key: string;
  /** Regex with exactly one capture group around the numeric price. */
  pattern: RegExp;
  /** Optional multiplier applied to the captured value (unit conversion). */
  scale?: number;
  /** Human-readable meaning of the captured figure, e.g. "$/vCPU-s". */
  label: string;
}

export interface PricingProvider {
  name: string;
  /** Public pricing page the rates were verified against. */
  url: string;
  extractors: PricingExtractor[];
  /**
   * Derives the comparable $/hr figure at 8 vCPU / 16 GiB from extracted
   * rates. Returns null when the required inputs were not extracted.
   */
  hourlyRate: (rates: Record<string, number>) => number | null;
  /** Any fixed per-sandbox (per-run) fee to add, extracted or constant. */
  perSandboxFee?: (rates: Record<string, number>) => number;
}

const HOUR = 3600;
/** Modal/Beam quote per *core* where 1 core = 2 vCPU in their sizing docs. */
const CORE_PAIR = 2;

const perSecond = (key: string, label: string, pattern: RegExp, scale = HOUR): PricingExtractor => ({
  key,
  label,
  pattern,
  scale,
});

/** 8 vCPU + 16 GiB from per-unit hourly rates. */
const vcpuMem = (): ((rates: Record<string, number>) => number | null) =>
  (r) => (r.vcpuHour !== undefined && r.gibHour !== undefined ? 8 * r.vcpuHour + 16 * r.gibHour : null);

export const PRICING_PROVIDERS: PricingProvider[] = [
  {
    name: 'sail',
    url: 'https://docs.sailresearch.com/sailboxes-pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/used vCPU-hr', pattern: /\$?(0\.015)\b/ },
      { key: 'gibHour', label: '$/used GiB-hr', pattern: /\$?(0\.008)\b/ },
      { key: 'nvmeGibHour', label: '$/GiB-hr NVMe', pattern: /\$?(0\.0007)\b/ },
      { key: 'sandboxFee', label: '$/sandbox creation', pattern: /\$?(0\.012)\b/ },
    ],
    hourlyRate: (r) =>
      r.vcpuHour !== undefined && r.gibHour !== undefined
        ? 8 * r.vcpuHour + 16 * (r.gibHour + (r.nvmeGibHour ?? 0))
        : null,
    perSandboxFee: (r) => r.sandboxFee ?? 0,
  },
  {
    name: 'northflank',
    url: 'https://northflank.com/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/vCPU-hr', pattern: /\$?(0\.01667)\b/ },
      { key: 'gibHour', label: '$/GB-hr', pattern: /\$?(0\.00833)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'archil',
    url: 'https://archil.com/pricing',
    extractors: [{ key: 'flatHour', label: '$/sandbox-hr', pattern: /\$?(0\.27)\b/ }],
    hourlyRate: (r) => r.flatHour ?? null,
  },
  {
    name: 'sandbox0',
    url: 'https://sandbox0.ai/pricing',
    extractors: [{ key: 'gibHour', label: '$/GiB-hr', pattern: /\$?(0\.02)\b/ }],
    hourlyRate: (r) => (r.gibHour !== undefined ? 16 * r.gibHour : null),
  },
  {
    name: 'upstash',
    url: 'https://upstash.com/pricing/box',
    extractors: [{ key: 'flatHour', label: '$/active-CPU-hr (large box)', pattern: /\$?(0\.40?)\b/ }],
    hourlyRate: (r) => r.flatHour ?? null,
  },
  {
    name: 'isorun',
    url: 'https://docs.isorun.ai/getting-started/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/vCPU-hr', pattern: /\$?(0\.025)\b/ },
      { key: 'gibHour', label: '$/GiB-hr', pattern: /\$?(0\.015)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'freestyle',
    url: 'https://www.freestyle.sh/docs/vms/pricing-and-limits',
    extractors: [
      { key: 'vcpuHour', label: '$/vCPU-hr', pattern: /\$?(0\.04032)\b/ },
      { key: 'gibHour', label: '$/GiB-hr', pattern: /\$?(0\.0129)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'codesandbox',
    url: 'https://codesandbox.io/docs/sdk/pricing',
    extractors: [
      { key: 'creditPrice', label: '$/credit', pattern: /\$?(0\.01486)\b/ },
      { key: 'creditsPerHour', label: 'credits/hr (Small VM)', pattern: /(40)\s*credits/i },
    ],
    hourlyRate: (r) =>
      r.creditPrice !== undefined && r.creditsPerHour !== undefined ? r.creditPrice * r.creditsPerHour : null,
  },
  {
    name: 'cloud-run',
    url: 'https://cloud.google.com/run/pricing',
    extractors: [
      perSecond('vcpuHour', '$/vCPU-s', /\$?(0\.000018)\b/),
      perSecond('gibHour', '$/GiB-s', /\$?(0\.000002)\b/),
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'e2b',
    url: 'https://e2b.dev/docs/faq/calculate-sandbox-price',
    extractors: [
      perSecond('vcpuHour', '$/vCPU-s', /\$?(0\.000014\d*)/),
      perSecond('gibHour', '$/GiB-s', /\$?(0\.0000045\d*)/),
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'daytona',
    url: 'https://www.daytona.io/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/vCPU-hr', pattern: /\$?(0\.0504)\b/ },
      { key: 'gibHour', label: '$/GiB-hr', pattern: /\$?(0\.0162)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'hopx',
    url: 'https://www.hopx.ai/pricing/',
    extractors: [
      perSecond('vcpuHour', '$/vCPU-s', /\$?(0\.000014\d*)/),
      perSecond('gibHour', '$/GiB-s', /\$?(0\.0000045\d*)/),
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'createos',
    url: 'https://createos.sh/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/vCPU-hr', pattern: /\$?(0\.0504)\b/ },
      { key: 'gibHour', label: '$/GiB-hr', pattern: /\$?(0\.0162)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'superserve',
    url: 'https://www.superserve.ai/pricing/',
    extractors: [
      { key: 'vcpuHour', label: '$/vCPU-hr', pattern: /\$?(0\.0504)\b/ },
      { key: 'gibHour', label: '$/GiB-hr', pattern: /\$?(0\.0162)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'tenki',
    url: 'https://tenki.cloud/pricing',
    extractors: [
      perSecond('vcpuHour', '$/vCPU-s', /\$?(0\.000014\d*)/),
      perSecond('gibHour', '$/GiB-s', /\$?(0\.0000045\d*)/),
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'microsandbox',
    url: 'https://microsandbox.dev/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/vCPU-hr', pattern: /\$?(0\.05)\b/ },
      { key: 'gibHour', label: '$/GiB-hr', pattern: /\$?(0\.0162)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'blaxel',
    url: 'https://blaxel.ai/pricing',
    extractors: [perSecond('gibHour', '$/GB-s active compute', /\$?(0\.0000115)\b/)],
    hourlyRate: (r) => (r.gibHour !== undefined ? 16 * r.gibHour : null),
  },
  {
    name: 'namespace',
    url: 'https://namespace.so/pricing',
    extractors: [
      // 8 vCPU / 16 GiB shape consumes 8 unit-min per minute at this rate.
      { key: 'unitMinute', label: '$/unit-min', pattern: /\$?(0\.0015)\b/ },
    ],
    hourlyRate: (r) => (r.unitMinute !== undefined ? r.unitMinute * 8 * 60 : null),
  },
  {
    name: 'cloudflare',
    url: 'https://developers.cloudflare.com/containers/platform/pricing/',
    extractors: [
      perSecond('vcpuHour', '$/vCPU-s active', /\$?(0\.00002\d*)/),
      perSecond('gibHour', '$/GiB-s provisioned', /\$?(0\.0000025\d*)/),
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'givemeanode',
    url: 'https://givemeanode.com/',
    extractors: [{ key: 'gibHour', label: '$/GiB-hr active', pattern: /\$?(0\.04572)\b/ }],
    hourlyRate: (r) => (r.gibHour !== undefined ? 16 * r.gibHour : null),
  },
  {
    name: 'tensorlake',
    url: 'https://www.tensorlake.ai/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/core-hr on-demand', pattern: /\$?(0\.07)\b/ },
      { key: 'gibHour', label: '$/GB-hr', pattern: /\$?(0\.015)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'beam',
    url: 'https://www.beam.cloud/pricing',
    extractors: [
      perSecond('coreHour', '$/core-s (1 core = 2 vCPU)', /\$?(0\.0000375)\b/, HOUR),
      perSecond('gibHour', '$/GiB-s', /\$?(0\.0000064)\b/),
    ],
    hourlyRate: (r) =>
      r.coreHour !== undefined && r.gibHour !== undefined ? 4 * r.coreHour + 16 * r.gibHour : null,
  },
  {
    name: 'modal',
    url: 'https://modal.com/pricing',
    extractors: [
      perSecond('coreHour', '$/core-s sandbox (1 core = 2 vCPU)', /\$?(0\.00003942)\b/, HOUR),
      perSecond('gibHour', '$/GiB-s', /\$?(0\.00000667)\b/),
    ],
    hourlyRate: (r) =>
      r.coreHour !== undefined && r.gibHour !== undefined ? 4 * r.coreHour + 16 * r.gibHour : null,
  },
  {
    name: 'sprites',
    url: 'https://fly.io/sprites/',
    extractors: [
      { key: 'vcpuHour', label: '$/CPU-hr', pattern: /\$?(0\.07)\b/ },
      { key: 'gibHour', label: '$/GB-hr', pattern: /\$?(0\.04375)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'runloop',
    url: 'https://runloop.ai/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/CPU-hr', pattern: /\$?(0\.108)\b/ },
      { key: 'gibHour', label: '$/GB-hr', pattern: /\$?(0\.0252)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
  {
    name: 'vercel',
    url: 'https://vercel.com/docs/sandbox/pricing',
    extractors: [
      { key: 'vcpuHour', label: '$/active-CPU-hr per vCPU', pattern: /\$?(0\.128)\b/ },
      { key: 'gibHour', label: '$/GB-hr provisioned', pattern: /\$?(0\.0212)\b/ },
    ],
    hourlyRate: vcpuMem(),
  },
];

/** Result row written into results/sandbox-pricing/. */
export interface PricingBenchmarkResult {
  provider: string;
  url: string;
  /** $/hr at the 8 vCPU / 16 GiB Dax spec, or null when extraction failed. */
  hourlyRate: number | null;
  /** Fixed per-sandbox fee, when the provider charges one. */
  perSandboxFee?: number;
  /** Extracted unit rates, keyed by extractor field. */
  rates: Record<string, number>;
  /** Extractor keys that matched / total declared. */
  fieldsMatched: number;
  fieldsTotal: number;
  httpStatus?: number;
  error?: string;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}
