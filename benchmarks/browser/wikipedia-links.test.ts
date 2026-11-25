import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { firstWikipediaArticleLink } from './wikipedia.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ channel: 'chromium', headless: true }); });
after(async () => { await browser?.close(); });

const sourceUrl = 'https://en.wikipedia.org/wiki/Fixture';
async function fixture(html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  // Fulfil every request locally; no Wikipedia, other site, or provider access.
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(sourceUrl);
  return page;
}

test('skips a hidden infobox flag after the visible map passes the selector wait', async t => {
  const html = readFileSync(new URL('./fixtures/wikipedia-collapsed-infobox.html', import.meta.url), 'utf8');
  const page = await fixture(html);
  t.after(() => page.close());
  const link = await firstWikipediaArticleLink(page);
  assert.equal(await link.isVisible(), true);
  assert.equal(await link.textContent(), 'Denmark', 'selects the visible text link, not the hidden flag');
  await link.click();
  assert.equal(page.url(), 'https://en.wikipedia.org/wiki/Denmark');
});

test('an initial hidden selector match does not prevent selecting a later visible link', async t => {
  const page = await fixture(`<main id="mw-content-text">
    <a href="/wiki/File:Hidden.svg" hidden>Hidden icon</a>
    <a href="/wiki/Hidden" style="display:none">Hidden article</a>
    <a href="/wiki/Visible">Visible article</a>
  </main>`);
  t.after(() => page.close());
  const link = await firstWikipediaArticleLink(page);
  assert.equal(await link.getAttribute('href'), '/wiki/Visible');
});

test('rejects other origins, namespace pages, empty titles, and malformed escapes', async t => {
  const page = await fixture(`<main id="mw-content-text">
    <a href="https://en.wiktionary.org/wiki/Visible">Other wiki</a>
    <a href="//elsewhere.invalid/wiki/Visible">Other origin</a>
    <a href="/wiki/Help:Contents">Help</a>
    <a href="/wiki/File%3AMap.svg">Encoded namespace</a>
    <a href="/wiki/">Empty title</a>
    <a href="/wiki/%ZZ">Malformed escape</a>
    <a href="/wiki/First">First valid article</a>
    <a href="/wiki/Second">Second valid article</a>
  </main>`);
  t.after(() => page.close());
  const link = await firstWikipediaArticleLink(page);
  assert.equal(await link.getAttribute('href'), '/wiki/First', 'preserves DOM order among eligible links');
});

for (const href of ['/wiki/Next', '//en.wikipedia.org/wiki/Next', 'https://en.wikipedia.org/wiki/Next']) {
  test(`supports same-origin article href ${href}`, async t => {
    const page = await fixture(`<main id="mw-content-text"><a href="${href}">Next article</a></main>`);
    t.after(() => page.close());
    const link = await firstWikipediaArticleLink(page);
    await link.click();
    assert.equal(page.url(), 'https://en.wikipedia.org/wiki/Next');
  });
}

test('reports a missing eligible link without clicking a namespace or leaving the wiki', async t => {
  const page = await fixture(`<main id="mw-content-text">
    <a href="/wiki/File:Map.svg">Map</a>
    <a href="https://en.wiktionary.org/wiki/Other">Other site</a>
    <a href="/wiki/Hidden" hidden>Hidden article</a>
  </main>`);
  t.after(() => page.close());
  await assert.rejects(firstWikipediaArticleLink(page), /No visible same-origin article body link/);
  assert.equal(page.url(), sourceUrl);
});
