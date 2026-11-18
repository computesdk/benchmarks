import type { Page } from 'playwright-core';

/**
 * Download/upload fixture sites for the browser-file-transfer benchmark.
 *
 * Primary fixture is the-internet.herokuapp.com (a long-running Selenium demo
 * site): /download serves a directory listing of small files and /upload
 * echoes an uploaded file's name. httpbin.org is the fallback when the
 * primary is unreachable: /bytes/<n>?seed=<s> serves deterministic bytes and
 * /post echoes a multipart upload's content.
 *
 * Expected bytes verified by curl on 2026-10-27:
 *   curl -sL https://the-internet.herokuapp.com/download/some-file.txt
 *     -> 307 bytes, sha256 2455fa1239e9bda350b6071b17582cbd461051428019e629dd073cb53ad4ab6f
 *   curl -s 'https://httpbin.org/bytes/1024?seed=42'
 *     -> 1024 bytes, sha256 1ba43bf584f5492eee63d3e590e65f1e1cdaf93dd988686d958f053713b7782f
 */

const NAV_TIMEOUT_MS = 30_000;
const ECHO_TIMEOUT_MS = 30_000;

export interface DownloadFixture {
  /** Expected downloaded file name (provider APIs do not always preserve it — match on sha first). */
  fileName: string;
  /** Expected size in bytes. */
  expectedBytes: number;
  /** Expected sha256 hex digest of the downloaded bytes. */
  expectedSha256: string;
  /**
   * Load the fixture download page and return the selector to click to start
   * the download. Throws when the fixture is unreachable.
   */
  prepare(page: Page): Promise<string>;
}

export interface UploadFixture {
  /** Selector of the <input type="file"> to fill. */
  fileInputSelector: string;
  /** Selector of the submit control. */
  submitSelector: string;
  /** Load the upload UI. Throws when the fixture is unreachable. */
  prepare(page: Page): Promise<void>;
  /**
   * Assert the page echoes the upload. `marker` is a unique string baked into
   * the uploaded content; fixtures that only echo the file name check
   * `fileName` instead. Throws on a missing or wrong echo.
   */
  assertEcho(page: Page, fileName: string, marker: string): Promise<void>;
}

export interface TransferFixture {
  name: string;
  download: DownloadFixture;
  upload: UploadFixture;
}

const theInternet: TransferFixture = {
  name: 'the-internet.herokuapp.com',
  download: {
    fileName: 'some-file.txt',
    expectedBytes: 307,
    expectedSha256: '2455fa1239e9bda350b6071b17582cbd461051428019e629dd073cb53ad4ab6f',
    prepare: async (page) => {
      await page.goto('https://the-internet.herokuapp.com/download', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      const selector = 'a[href$="some-file.txt"]';
      await page.waitForSelector(selector, { timeout: NAV_TIMEOUT_MS });
      return selector;
    },
  },
  upload: {
    fileInputSelector: '#file-upload',
    submitSelector: '#file-submit',
    prepare: async (page) => {
      await page.goto('https://the-internet.herokuapp.com/upload', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForSelector('#file-upload', { timeout: NAV_TIMEOUT_MS });
    },
    assertEcho: async (page, fileName) => {
      // /upload renders "File Uploaded!" plus the file name inside
      // #uploaded-files.
      const el = await page.waitForSelector('#uploaded-files', { timeout: ECHO_TIMEOUT_MS });
      const text = (await el?.textContent()) ?? '';
      if (!text.includes(fileName)) {
        throw new Error(`upload echo missing file name: got "${text.trim().slice(0, 200)}"`);
      }
    },
  },
};

const httpbin: TransferFixture = {
  name: 'httpbin.org',
  download: {
    fileName: 'file-transfer-1024.bin',
    expectedBytes: 1024,
    expectedSha256: '1ba43bf584f5492eee63d3e590e65f1e1cdaf93dd988686d958f053713b7782f',
    prepare: async (page) => {
      // httpbin has no download page — load the index (liveness check) then
      // inject a link with a `download` attribute that forces a download of
      // the deterministic /bytes payload under our expected file name.
      await page.goto('https://httpbin.org/', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      await page.setContent(
        '<a id="bft-dl" href="https://httpbin.org/bytes/1024?seed=42" download="file-transfer-1024.bin">download</a>',
      );
      return '#bft-dl';
    },
  },
  upload: {
    fileInputSelector: '#bft-file',
    submitSelector: '#bft-submit',
    prepare: async (page) => {
      await page.goto('about:blank');
      await page.setContent(
        '<form method="post" action="https://httpbin.org/post" enctype="multipart/form-data">' +
          '<input id="bft-file" name="file" type="file"/>' +
          '<button id="bft-submit" type="submit">Upload</button>' +
          '</form>',
      );
    },
    assertEcho: async (page, _fileName, marker) => {
      // httpbin /post renders the parsed request as JSON in the body; files
      // arrive as `files.file`, either raw or as a data: URL.
      await page.waitForSelector('body', { timeout: ECHO_TIMEOUT_MS });
      const text = (await page.textContent('body')) ?? '';
      let echoed = '';
      try {
        const json = JSON.parse(text) as { files?: { file?: string } };
        echoed = json.files?.file ?? '';
      } catch {
        throw new Error(`httpbin echo was not JSON: "${text.slice(0, 200)}"`);
      }
      const decoded = echoed.startsWith('data:')
        ? Buffer.from(echoed.split(',', 2)[1] ?? '', 'base64').toString('utf8')
        : echoed;
      if (!decoded.includes(marker)) {
        throw new Error(`upload echo missing marker: got "${decoded.slice(0, 200)}"`);
      }
    },
  },
};

/** Primary first, fallbacks after — the task tries each in order. */
export const TRANSFER_FIXTURES: TransferFixture[] = [theInternet, httpbin];
