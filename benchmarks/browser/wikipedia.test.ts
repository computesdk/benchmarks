import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { TaskContext } from '@benchsdk/runner';
import { seedWikipediaCookie } from './wikipedia.js';
import type { ConcurrentProviderConfig } from '../stealth/browser/concurrent-types.js';

// One round is sufficient to exercise the barrier, measurement, and cleanup.
process.env.CONCURRENT_ROUNDS_PER_LEVEL = '1';
process.env.CONCURRENT_LEVEL_COOLDOWN_MS = '0';
const originalSlug = process.env.BENCHMARK_SLUG;
process.env.BENCHMARK_SLUG = '';
const shared = await import('../stealth/browser/browser-concurrency.bench.js');
const publicEntry = await import('./browser-concurrent.bench.js');
if (originalSlug === undefined) delete process.env.BENCHMARK_SLUG;
else process.env.BENCHMARK_SLUG = originalSlug;

test('public concurrency uses the shared task and a nonempty default slug', () => {
  assert.equal(publicEntry.task, shared.task);
  assert.equal(publicEntry.config.benchmarkSlug, 'browser-concurrency');
});

test('cookie setup reports errors and bounds an unresponsive cookie jar', async t => {
  await assert.rejects(seedWikipediaCookie({ addCookies: async () => { throw 'CDP disconnected'; } }),
    /Wikipedia cookie setup failed: CDP disconnected/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = seedWikipediaCookie({ addCookies: () => new Promise(() => {}) });
  const rejected = assert.rejects(pending, /Wikipedia cookie setup failed: Wikipedia cookie setup timed out/);
  t.mock.timers.tick(5_000);
  await rejected;
});

for (const failSetup of [false, true]) {
  test(`concurrency ${failSetup ? 'aborts and cleans up after cookie failure' : 'prepares every session before the action barrier'}`, async t => {
    const sessions = 5;
    let created = 0;
    let prepared = 0;
    let closed = 0;
    let navigated = 0;
    const destroyed = new Set<string>();
    const steps: string[] = [];
    // A virtual clock makes exclusion of cookie setup from totalMs exact.
    let clock = 0;
    t.mock.method(performance, 'now', () => ++clock);
    t.mock.method(chromium, 'connectOverCDP', async (url: string) => {
      const index = Number(url.split('/').at(-1));
      let hasCookie = false;
      const context = {
        addCookies: async (cookies: Parameters<BrowserContext['addCookies']>[0]) => {
          // Different completion times expose a missing all-context barrier.
          await delay(index);
          clock += 100;
          assert.equal(navigated, 0, 'cookie installation sends no warm-up request');
          if (failSetup && index === 2) throw new Error('Cookie jar unavailable');
          assert.equal(cookies[0].domain, '.wikipedia.org');
          hasCookie = true;
          prepared++;
        },
        pages: () => [page],
      };
      const page = {
        context: () => context,
        goto: async () => {
          assert.equal(hasCookie, true, 'first navigation has a cookie');
          assert.equal(prepared, sessions, 'all contexts are ready before any action');
          navigated++;
        },
        waitForSelector: async () => ({}),
        screenshot: async () => Buffer.alloc(0),
        textContent: async () => 'Fixture',
        $$: async () => [{ getAttribute: async () => '/wiki/Next', click: async () => {} }],
        goBack: async () => {},
      };
      return { contexts: () => [context], close: async () => { closed++; } } as unknown as Browser;
    });
    const ctx = {
      participant: {
        name: `cookie-barrier-${failSetup}`, requiredEnvVars: [],
        createBrowserProvider: () => ({ session: {
          create: async () => {
            const sessionId = String(created++);
            return { sessionId, connectUrl: `http://fixture/${sessionId}` };
          },
          destroy: async (id: string) => { destroyed.add(id); },
        } }),
      },
      taskIndex: 0, phase: 'c5',
      step: async (name: string, fn: () => unknown) => { steps.push(name); return fn(); },
      measure: () => {}, log: () => {},
    } as unknown as TaskContext<ConcurrentProviderConfig>;
    if (failSetup) {
      await assert.rejects(Promise.resolve(shared.task(ctx)), /Wikipedia cookie setup failed: Cookie jar unavailable/);
      assert.equal(navigated, 0);
      assert.equal(steps.some(name => name.startsWith('actions-')), false);
    } else {
      const result = await shared.task(ctx);
      assert.ok(result);
      assert.equal(result.data?.sessionsAlive, sessions);
      assert.ok(navigated >= sessions);
      const rounds = result.data?.rounds as Array<{ totalMs: number }>;
      assert.ok(rounds[0].totalMs < 500, '500ms of cookie setup is excluded from round timing');
    }
    assert.equal(prepared, failSetup ? sessions - 1 : sessions);
    assert.equal(closed, sessions, 'every CDP connection is closed');
    assert.equal(destroyed.size, sessions, 'every provider session is destroyed');
  });
}

for (const failSetup of [false, true]) {
  test(`native throughput ${failSetup ? 'cleans up after cookie failure' : 'seeds before its 50 measured actions'}`, async t => {
    const { chromium: native } = await import('playwright-native-core');
    const { playwrightProviders } = await import('../stealth/browser/playwright-providers.js');
    // Satisfy import-time preflight only; this test uses a local stub provider.
    for (const participant of playwrightProviders) {
      for (const name of participant.requiredEnvVars) {
        if (!process.env[name]) {
          const previous = process.env[name];
          process.env[name] = 'fixture';
          t.after(() => {
            if (previous === undefined) delete process.env[name];
            else process.env[name] = previous;
          });
        }
      }
    }
    const { task } = await import('../stealth/browser/browser-playwright-throughput.bench.js');
    let prepared = false;
    let contextClosed = false;
    let browserClosed = false;
    let released = false;
    let navigations = 0;
    const steps: string[] = [];
    const context = {
      addCookies: async () => {
        assert.equal(navigations, 0);
        if (failSetup) throw new Error('Cookie jar unavailable');
        prepared = true;
      },
      newPage: async () => page,
      setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
      close: async () => { contextClosed = true; },
    };
    const page = {
      context: () => context,
      goto: async () => { assert.ok(prepared); navigations++; return { status: () => 200 }; },
      waitForSelector: async () => ({}), screenshot: async () => Buffer.alloc(0),
      textContent: async () => 'Fixture', goBack: async () => {},
      $$: async () => [{ getAttribute: async () => '/wiki/Next', click: async () => {} }],
    };
    t.mock.method(native, 'connect', async () => ({
      version: () => 'fixture', newContext: async () => context,
      close: async () => { browserClosed = true; },
    }));
    const ctx = {
      participant: {
        name: `native-cookie-${failSetup}`, requiredEnvVars: [],
        session: () => ({
          metadata: {}, provision: async () => ({ endpoint: 'http://fixture', headers: {} }),
          cleanup: async () => { released = true; },
        }),
      },
      taskIndex: 0,
      step: async (name: string, fn: () => unknown) => {
        steps.push(name);
        if (name === 'actions') assert.ok(prepared);
        return fn();
      },
      measure: () => {}, log: () => {},
    } as unknown as Parameters<typeof task>[0];
    if (failSetup) {
      await assert.rejects(Promise.resolve(task(ctx)), /Wikipedia cookie setup failed: Cookie jar unavailable/);
      assert.equal(steps.includes('actions'), false);
      assert.equal(navigations, 0);
    } else {
      const result = await task(ctx);
      assert.ok(result);
      assert.equal(result.data?.actionsCompleted, 50);
      assert.equal(navigations, 5);
    }
    assert.ok(contextClosed && browserClosed && released);
  });
}
