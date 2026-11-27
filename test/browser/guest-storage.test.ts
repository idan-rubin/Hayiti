import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { guestTitles, patchGuestRecord, readGuestRecord } from './guest-storage-helpers.ts';

const origin = 'https://hayiti.test';
const legacyKey = 'hayiti-unsigned-journal';
const date = '2026-06-14';
const trip = (id: string, title = id) => ({ id, title, start: date, end: date, stops: [] });

async function hostGuest(page: Page) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/')) return route.fulfill({ status: 401 });
    try {
      const body = await readFile(new URL('../../dist/web' + pathname, import.meta.url));
      const extension = pathname.split('.').at(-1) ?? '';
      const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', ico: 'image/x-icon' };
      return route.fulfill({ body, contentType: types[extension] ?? 'application/octet-stream' });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
}

await test('concurrent guest saves preserve every trip with and without Web Locks despite stale tab views', async () => {
  const browser = await chromium.launch();
  try {
    for (const locksUnavailable of [false, true]) {
      const context = await browser.newContext();
      await context.addInitScript(noLocks => {
        if (noLocks) Object.defineProperty(navigator, 'locks', { value: undefined });
        Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
        window.addEventListener('storage', event => event.stopImmediatePropagation(), true);
      }, locksUnavailable);
      const pages = [await context.newPage(), await context.newPage()];
      for (const page of pages) {
        await hostGuest(page);
        await page.goto(origin + '/journal.html?lang=en');
        await page.locator('#newTrip:not([disabled])').waitFor();
      }
      const expected: string[] = [];
      for (let round = 0; round < 6; round++) {
        const titles = pages.map((_, index) => 'Round ' + round + ' tab ' + index);
        await Promise.all(pages.map(async (page, index) => {
          await page.locator('#newTrip').click();
          await page.locator('#tripForm [name=title]').fill(titles[index]);
        }));
        await Promise.all(pages.map(page => page.locator('#tripForm .primary').click()));
        for (const page of pages) {
          for (let retry = 0; retry < 4; retry++) {
            await page.locator('#config:not([open]), #config .form-error').first().waitFor({ state: 'attached' });
            if (await page.locator('#config').getAttribute('open') === null) break;
            assert.match(await page.locator('#config .form-error').innerText(), /changed|latest version/i);
            await page.locator('#tripForm .primary').click();
          }
          await page.locator('#config').waitFor({ state: 'hidden' });
        }
        expected.push(...titles);
        assert.deepEqual(await guestTitles(pages[0]), [...expected].sort());
      }
      for (const page of pages) {
        await page.reload();
        await page.waitForFunction(count => document.querySelectorAll('#trips option').length === count, expected.length);
        assert.deepEqual((await page.locator('#trips option').allTextContents()).sort(), [...expected].sort());
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

await test('canonical guest data ignores later writes from an older localStorage client', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(({ key, seed }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ trips: [seed] }));
    }, { key: legacyKey, seed: trip('legacy', 'Legacy trip') });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Legacy trip' }).waitFor();
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Canonical trip');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    const before = await readGuestRecord(page);
    await page.evaluate(({ key, stale }) => localStorage.setItem(key, JSON.stringify({ trips: [stale] })), {
      key: legacyKey, stale: trip('stale', 'Old client replacement')
    });
    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Canonical trip' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Canonical trip', 'Legacy trip']);
    assert.deepEqual(await readGuestRecord(page), before);
  } finally {
    await browser.close();
  }
});

await test('simultaneous legacy migrations commit every tab draft once without Web Locks', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    const pages = [await context.newPage(), await context.newPage()];
    for (const [index, page] of pages.entries()) {
      await hostGuest(page);
      await page.addInitScript(({ key, local, tab }) => {
        localStorage.setItem(key, JSON.stringify({ trips: [local] }));
        sessionStorage.setItem(key, JSON.stringify({ trips: [tab] }));
      }, { key: legacyKey, local: trip('local', 'Browser legacy'), tab: trip('tab-' + index, 'Tab legacy ' + index) });
    }
    await Promise.all(pages.map(page => page.goto(origin + '/journal.html?lang=en')));
    for (const page of pages) await page.locator('#newTrip:not([disabled])').waitFor();
    assert.deepEqual(await guestTitles(pages[0]), ['Browser legacy', 'Tab legacy 0', 'Tab legacy 1']);
    await Promise.all(pages.map(page => page.reload()));
    for (const page of pages) await page.locator('#newTrip:not([disabled])').waitFor();
    assert.deepEqual(await guestTitles(pages[0]), ['Browser legacy', 'Tab legacy 0', 'Tab legacy 1']);
    await context.close();
  } finally {
    await browser.close();
  }
});

await test('an aborted first migration keeps its legacy source until a successful retry', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const serialized = JSON.stringify({ trips: [trip('legacy', 'Keep original')] });
    await page.addInitScript(({ key, source }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, source);
      if (sessionStorage.getItem('migration-retry') === 'yes') return;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name === 'hayiti-guest') {
          this.transaction.abort();
          throw new DOMException('Migration aborted', 'AbortError');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    }, { key: legacyKey, source: serialized });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#retryLoad').waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), serialized);
    assert.equal(await readGuestRecord(page), null);
    assert.equal(await page.locator('#newTrip').isDisabled(), true);
    await page.evaluate(() => sessionStorage.setItem('migration-retry', 'yes'));
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Keep original' }).waitFor();
    assert.deepEqual(await guestTitles(page), ['Keep original']);
  } finally {
    await browser.close();
  }
});

await test('an unsupported guest schema is preserved and cannot be replaced by an older client', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip:not([disabled])').waitFor();
    await patchGuestRecord(page, { schemaVersion: 2, trips: [{ ...trip('future'), futureField: { keep: 'exactly' } }] });
    const future = await readGuestRecord(page);
    await page.reload();
    await page.locator('#retryLoad, #discardDraft').filter({ visible: true }).first().waitFor();
    assert.equal(await page.locator('#newTrip').isDisabled(), true);
    assert.deepEqual(await readGuestRecord(page), future);
  } finally {
    await browser.close();
  }
});

await test('blocked IndexedDB leaves the legacy draft intact and never offers an unsaved guest journal as persisted', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const serialized = JSON.stringify({ trips: [trip('retained', 'Retained draft')] });
    await page.addInitScript(({ key, source }) => {
      localStorage.setItem(key, source);
      IDBFactory.prototype.open = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    }, { key: legacyKey, source: serialized });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#retryLoad').waitFor();
    assert.equal(await page.locator('#newTrip').isDisabled(), true);
    assert.equal(await page.locator('#import').isDisabled(), true);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), serialized);
    assert.doesNotMatch(await page.locator('#status').innerText(), /saved in this browser/i);
  } finally {
    await browser.close();
  }
});

await test('discarding an unreadable tab draft preserves the valid canonical journal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip:not([disabled])').waitFor();
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Keep canonical trip');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    const before = await readGuestRecord(page);
    await page.evaluate(key => sessionStorage.setItem(key, '{broken'), legacyKey);
    await page.reload();
    await page.locator('#discardDraft').waitFor();
    await page.locator('#discardDraft').click();
    await page.locator('#confirmNo').click();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), legacyKey), '{broken');
    assert.deepEqual(await readGuestRecord(page), before);
    await page.locator('#discardDraft').click();
    await page.locator('#confirmYes').click();
    await page.locator('#title').filter({ hasText: 'Keep canonical trip' }).waitFor();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), legacyKey), null);
    assert.deepEqual(await readGuestRecord(page), before);
  } finally {
    await browser.close();
  }
});

await test('a canonical journal repaired while discard confirmation is open is never deleted', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip:not([disabled])').waitFor();
    await patchGuestRecord(page, { trips: [null] });
    await page.reload();
    await page.locator('#discardDraft').waitFor();
    await page.locator('#discardDraft').click();
    await page.locator('#confirmBox').waitFor();
    await patchGuestRecord(page, { trips: [trip('recovered', 'Recovered in another tab')] });
    const repaired = await readGuestRecord(page);
    await page.locator('#confirmYes').click();
    await page.locator('#title').filter({ hasText: 'Recovered in another tab' }).waitFor();
    assert.deepEqual(await readGuestRecord(page), repaired);
    assert.deepEqual(await guestTitles(page), ['Recovered in another tab']);
  } finally {
    await browser.close();
  }
});
