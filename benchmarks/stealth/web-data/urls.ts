import type { ScrapeTarget } from './types.js';

/**
 * Fixed v1 target set: 4 URLs per bucket. Iteration N scrapes
 * `SCRAPE_TARGETS[N % length]`, and with `groupBy: 'round'` every provider
 * scrapes the same URL in the same round.
 *
 * - static: content is in the server HTML.
 * - js: content is rendered client-side (marker absent from the raw HTML, or
 *   only present inside script data).
 * - protected: plain curl gets a 403 / bot challenge.
 *
 * Markers must stay specific to real page content — a marker that could also
 * appear on a block page would let a blocked scrape count as a success.
 */
export const SCRAPE_TARGETS: ScrapeTarget[] = [
  { bucket: 'static', url: 'https://example.com', marker: 'for use in documentation' },
  { bucket: 'static', url: 'https://en.wikipedia.org/wiki/Web_scraping', marker: 'data scraping used for extracting data' },
  { bucket: 'static', url: 'https://www.rfc-editor.org/rfc/rfc9110.html', marker: 'HTTP Semantics' },
  { bucket: 'static', url: 'https://docs.python.org/3/library/json.html', marker: 'JSON encoder and decoder' },

  { bucket: 'js', url: 'https://quotes.toscrape.com/js/', marker: 'Albert Einstein' },
  { bucket: 'js', url: 'https://quotes.toscrape.com/js/page/2/', marker: 'Marilyn Monroe' },
  { bucket: 'js', url: 'https://quotes.toscrape.com/scroll', marker: 'Albert Einstein' },
  { bucket: 'js', url: 'https://www.scrapingcourse.com/javascript-rendering', marker: 'Chaz Kangeroo Hoodie' },

  { bucket: 'protected', url: 'https://www.scrapingcourse.com/cloudflare-challenge', marker: 'You bypassed the Cloudflare challenge' },
  { bucket: 'protected', url: 'https://www.scrapingcourse.com/antibot-challenge', marker: 'You bypassed the Antibot challenge' },
  { bucket: 'protected', url: 'https://www.g2.com/products/slack/reviews', marker: 'Slack' },
  { bucket: 'protected', url: 'https://www.indeed.com/q-software-engineer-jobs.html', marker: 'Software Engineer' },
];

/**
 * Strings that only appear on bot-challenge / block pages. Checked before the
 * marker so a block page can never pass. Kept to challenge-page titles and
 * copy — generic words like "captcha" appear in legitimate content.
 */
export const BLOCK_PAGE_PATTERNS: RegExp[] = [
  /just a moment\.\.\./i,
  /attention required! \| cloudflare/i,
  /verifying you are human/i,
  /verify you are (a )?human/i,
  /enable javascript and cookies to continue/i,
  /press & hold/i,
  /pardon our interruption/i,
  /access to this page has been denied/i,
  /request unsuccessful\. incapsula/i,
];
