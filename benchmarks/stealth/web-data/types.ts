export type ScrapeBucket = 'static' | 'js' | 'protected';

export interface ScrapeTarget {
  url: string;
  bucket: ScrapeBucket;
  /**
   * Case-insensitive phrase that only appears in the page's real rendered
   * content. Its presence in the returned markdown is what makes a scrape a
   * success — an HTTP 200 alone is not.
   */
  marker: string;
}

/** Provider-agnostic view of one scrape response. */
export interface ScrapeOutput {
  markdown: string;
  /** HTTP status the provider reports for the target page, when it exposes one. */
  targetStatus?: number;
  /** 'hit' | 'miss' | ... as reported by the provider; undefined if it doesn't say. */
  cacheStatus?: string;
  /** Provider-side error for the target, when the provider call itself succeeded. */
  error?: string;
}

export interface ScrapeProviderConfig {
  name: string;
  requiredEnvVars: string[];
  /** Full endpoint URL (always POSTed with a JSON body). */
  endpoint: string;
  buildHeaders: () => Record<string, string>;
  buildBody: (url: string, timeoutMs: number) => Record<string, unknown>;
  parseResponse: (json: any) => ScrapeOutput;
}
