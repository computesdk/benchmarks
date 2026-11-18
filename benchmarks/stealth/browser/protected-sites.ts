/**
 * Target list for the browser-protected-sites benchmark.
 *
 * Each entry is a real page currently gated by an anti-bot vendor (or a stable
 * vendor CAPTCHA demo). Signals are substring/CSS probes evaluated against the
 * live page after navigation:
 *   - passSignal: real content loaded (not a challenge page)
 *   - challengeSignal: a challenge/interstitial is active
 *   - blockSignal: a hard block page (no interactive challenge)
 *   - captchaSignal: an interactive CAPTCHA widget is present
 *   - solvedSelector: a token element whose non-empty `value` means the
 *     provider's CAPTCHA solver produced a token (reCAPTCHA / Turnstile)
 *   - captchaGate: `passed` additionally requires captchaSolved — used on the
 *     CAPTCHA demo pages, where the "content" behind the captcha IS the solve.
 *
 * All fields of one signal are OR'ed: any match counts. Verified 2026-10-27
 * via curl — each entry still serves the expected vendor's challenge (see
 * docs/browser-protected-sites.md for the per-site verification).
 */
export type ExpectedVendor = 'cloudflare' | 'datadome' | 'perimeterx' | 'captcha-demo';

export interface Signal {
  /** CSS selector (comma lists allowed) that must match an element. */
  selector?: string;
  /** Substring match on the page's visible body text. */
  text?: string;
  /** Substring match on the serialized HTML (catches script tags/attributes). */
  html?: string;
  /** Substring match on document.title. */
  title?: string;
}

export interface ProtectedSite {
  slug: string;
  url: string;
  expectedVendor: ExpectedVendor;
  passSignal: Signal;
  challengeSignal?: Signal;
  blockSignal?: Signal;
  captchaSignal?: Signal;
  /** Selector whose element's `value` becomes non-empty once the captcha is solved. */
  solvedSelector?: string;
  captchaGate?: boolean;
}

export const PROTECTED_SITES: ProtectedSite[] = [
  {
    slug: 'nowsecure',
    url: 'https://nowsecure.nl/',
    expectedVendor: 'cloudflare',
    // Cloudflare injects its background JS detection script
    // (/cdn-cgi/challenge-platform/scripts/jsd) into every page it serves, and
    // the page embeds its own Turnstile demo widget (id cf-chl-widget-*), so
    // neither marks an active challenge. `_cf_chl_opt` only ships on the
    // "Just a moment" interstitial.
    passSignal: { selector: 'h2.content__title' },
    challengeSignal: {
      html: '_cf_chl_opt',
      text: 'Verify you are human',
      title: 'Just a moment',
    },
    captchaSignal: { selector: '.cf-turnstile iframe, iframe[src*="challenges.cloudflare.com"]' },
    blockSignal: { title: 'Attention Required', text: 'Sorry, you have been blocked' },
  },
  {
    slug: 'indeed',
    url: 'https://www.indeed.com/',
    expectedVendor: 'cloudflare',
    passSignal: { selector: 'input[name="q"]' },
    challengeSignal: {
      html: '_cf_chl_opt',
      selector: '.cf-chl-widget, [id^="cf-chl-widget"]',
      title: 'Security Check',
      text: 'Just a moment',
    },
    captchaSignal: { selector: '.cf-turnstile iframe, iframe[src*="challenges.cloudflare.com"]' },
    blockSignal: { title: 'Attention Required', text: 'Sorry, you have been blocked' },
  },
  {
    slug: 'leboncoin',
    url: 'https://www.leboncoin.fr/',
    expectedVendor: 'datadome',
    passSignal: { text: 'Déposer une annonce', selector: 'a[href*="deposer-une-annonce"]' },
    challengeSignal: {
      html: 'captcha-delivery.com',
      selector: 'iframe[src*="captcha-delivery"]',
      text: 'Please enable JS and disable any ad blocker',
    },
    captchaSignal: { selector: 'iframe[src*="captcha-delivery.com/captcha"]' },
  },
  {
    slug: 'zillow',
    url: 'https://www.zillow.com/',
    expectedVendor: 'perimeterx',
    passSignal: { selector: '#search-box-input, [data-testid="search-bar-container"] input[role="combobox"]' },
    challengeSignal: {
      selector: '#px-captcha, .px-captcha',
      text: 'Please verify you are a human',
    },
    captchaSignal: { selector: '#px-captcha iframe, iframe[src*="captcha"], iframe[src*="_px"]' },
    blockSignal: { text: 'Access to this page has been denied' },
  },
  {
    slug: 'recaptcha-demo',
    url: 'https://www.google.com/recaptcha/api2/demo',
    expectedVendor: 'captcha-demo',
    captchaGate: true,
    passSignal: { selector: '.g-recaptcha' },
    captchaSignal: { selector: '.g-recaptcha iframe, iframe[src*="recaptcha/api2"]' },
    solvedSelector: 'textarea#g-recaptcha-response',
    blockSignal: { text: 'unusual traffic', title: 'Error' },
  },
  {
    slug: 'turnstile-demo',
    url: 'https://demo.turnstile.workers.dev/',
    expectedVendor: 'captcha-demo',
    captchaGate: true,
    passSignal: { selector: '.cf-turnstile, form' },
    captchaSignal: { selector: '.cf-turnstile iframe, iframe[src*="challenges.cloudflare.com"]' },
    solvedSelector: 'input[name="cf-turnstile-response"]',
    blockSignal: { text: 'Sorry, you have been blocked' },
  },
];
