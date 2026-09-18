import type { BenchmarkUpgradeNotice } from '@benchsdk/api';

export interface OutputOptions {
  json?: boolean;
  format?: 'json' | 'table';
}

function isJson(options: OutputOptions): boolean {
  return !!options.json || options.format === 'json';
}

// Upgrade offers collected from API responses during a command. Printed to
// stderr at the end so agents and humans see the paid tier without polluting
// stdout (which may be piped/parsed).
const pendingUpgradeNotices = new Map<string, BenchmarkUpgradeNotice>();

export function collectUpgradeNotice(notice: BenchmarkUpgradeNotice): void {
  pendingUpgradeNotices.set(`${notice.category}:${notice.message}`, notice);
}

export function printUpgradeNotices(): void {
  for (const notice of pendingUpgradeNotices.values()) {
    console.error(`Note: ${notice.message}`);
    console.error(`  Upgrade: ${notice.billingUrl ?? notice.learnMoreUrl}`);
  }
  pendingUpgradeNotices.clear();
}

// Responses may carry an `upgrade` offer next to the payload; in JSON mode it
// stays in-band, in table mode it's stripped (it prints separately via
// printUpgradeNotices).
function stripUpgradeField(data: unknown, options: OutputOptions): unknown {
  if (
    isJson(options) ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !Object.hasOwn(data, 'upgrade')
  ) {
    return data;
  }
  const { upgrade: _upgrade, ...rest } = data as Record<string, unknown>;
  return rest;
}

export function printData(data: unknown, options: OutputOptions = {}): void {
  if (isJson(options)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  data = stripUpgradeField(data, options);

  if (data === null || data === undefined) {
    console.log('No results.');
    return;
  }

  const format = options.format ?? 'table';

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('No results.');
      return;
    }
    if (format === 'table') {
      console.table(data);
      return;
    }
    console.dir(data, { depth: null });
    return;
  }

  if (typeof data === 'object') {
    if (Object.keys(data).length === 0) {
      console.log('No results.');
      return;
    }
    if (format === 'table') {
      console.table(data);
      return;
    }
    console.dir(data, { depth: null });
    return;
  }

  console.log(data);
}
