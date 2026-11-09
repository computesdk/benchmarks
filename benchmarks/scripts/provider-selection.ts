export function selectProviders<T extends { dailyOnly?: boolean }>(providers: T[]): T[] {
  return providers.filter(provider => !provider.dailyOnly || process.env.DAILY_BENCH_SLUG === 'daily');
}
