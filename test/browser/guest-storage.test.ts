import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, type Page, type Route } from 'playwright-core';
import { build } from 'esbuild';
import { journalAPI } from '../../src/server/journal-api.ts';
import { loadState, storeState } from '../../src/server/storage.ts';
import { legacyGuestMarker, temporaryGuestKey } from '../../src/web/guest-storage.ts';
import { MemoryBucket } from '../memory-bucket.ts';
import { guestTitles, patchGuestRecord, readGuestRecord, readLegacyGuestSources, replaceLegacyGuestAfterCommit, seedLegacyGuestOnce } from './guest-storage-helpers.ts';

const origin = 'https://hayiti.test';
const legacyKey = 'hayiti-unsigned-journal';
const date = '2026-06-14';
const trip = (id: string, title = id) => ({ id, title, start: date, end: date, stops: [] });

async function createTemporaryTrip(page: Page, title: string) {
  await page.locator('#newTrip').click();
  await page.locator('#tripForm [name=title]').fill(title);
  await page.locator('#tripForm .primary').click();
  await page.locator('#config').waitFor({ state: 'hidden' });
}

async function hostGuest(page: Page, api: (route: Route) => Promise<void> = route => route.fulfill({ status: 401 })) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/')) return api(route);
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

await test('a trip added by an older localStorage client survives alongside canonical changes after reload', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const original = trip('legacy', 'Legacy trip');
    await seedLegacyGuestOnce(page, { local: JSON.stringify({ trips: [original] }) });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Legacy trip' }).waitFor();
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Canonical trip');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    const oldTab = await context.newPage();
    await oldTab.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Older client</title>' }));
    await oldTab.goto(origin + '/older-client.html');
    const later = JSON.stringify({ trips: [original, trip('old-tab-added', 'Added in the old tab')] });
    await oldTab.evaluate(({ key, source }) => localStorage.setItem(key, source), {
      key: legacyKey, source: later
    });
    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Added in the old tab' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Added in the old tab', 'Canonical trip', 'Legacy trip']);
    assert.equal((await readLegacyGuestSources(page)).local, legacyGuestMarker);
    const before = await readGuestRecord(page);
    await oldTab.evaluate(({ key, source }) => localStorage.setItem(key, source), { key: legacyKey, source: later });
    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Added in the old tab' }).waitFor({ state: 'attached' });
    assert.deepEqual(await readGuestRecord(page), before);
    assert.equal((await readLegacyGuestSources(page)).local, legacyGuestMarker);
  } finally {
    await browser.close();
  }
});

await test('the old main guest reader keeps its visible trip and refuses a stale save after a migration marker', async () => {
  const built = await build({
    entryPoints: [new URL('../fixtures/legacy-guest-client.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'iife', target: 'es2022'
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const oldTab = await context.newPage();
    const source = JSON.stringify({ trips: [trip('legacy-visible', 'Still visible in the old tab')] });
    await seedLegacyGuestOnce(oldTab, { local: source });
    await oldTab.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body:
      '<div id="legacy-trips"></div><div id="legacy-status" role="alert"></div><button id="legacy-edit">Edit old trip</button>' }));
    await oldTab.goto(origin + '/older-client.html');
    await oldTab.addScriptTag({ content: built.outputFiles[0].text });
    assert.equal(await oldTab.locator('#legacy-trips').innerText(), 'Still visible in the old tab');

    const current = await context.newPage();
    await hostGuest(current);
    await current.goto(origin + '/journal.html?lang=en');
    await current.locator('#title').filter({ hasText: 'Still visible in the old tab' }).waitFor();
    await oldTab.getByRole('alert').filter({ hasText: 'guest draft in this browser could not be read' }).waitFor();
    assert.equal(await oldTab.locator('#legacy-trips').innerText(), 'Still visible in the old tab');
    assert.equal((await readLegacyGuestSources(current)).local, legacyGuestMarker);
    assert.doesNotMatch(legacyGuestMarker, /Still visible|legacy-visible/);
    await oldTab.locator('#legacy-edit').click();
    assert.equal(await oldTab.locator('#legacy-trips').innerText(), 'Still visible in the old tab');
    assert.equal((await readLegacyGuestSources(current)).local, legacyGuestMarker);
    assert.deepEqual(await guestTitles(current), ['Still visible in the old tab']);
    assert.equal(await oldTab.evaluate(() => (window as unknown as { legacyUpgradeReview: { starts: () => number } }).legacyUpgradeReview.starts()), 0);

    await current.reload();
    await current.locator('#title').filter({ hasText: 'Still visible in the old tab' }).waitFor();
    assert.equal(await current.locator('#discardDraft').isVisible(), false);
    assert.deepEqual(await guestTitles(current), ['Still visible in the old tab']);
  } finally {
    await browser.close();
  }
});

await test('successful migration removes local and tab plaintext only after committing both drafts and their retry metadata', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const local = trip('browser-source', 'Browser source'), tab = trip('tab-source', 'Tab source');
    const localAttempt = { guestId: local.id, targetId: local.id, before: '', sent: 'browser-fingerprint' };
    const tabAttempt = { guestId: tab.id, targetId: tab.id, before: '', sent: 'tab-fingerprint' };
    await seedLegacyGuestOnce(page, {
      local: JSON.stringify({ trips: [local] }), tab: JSON.stringify({ trips: [tab] }),
      localAttempts: JSON.stringify([localAttempt]), tabAttempts: JSON.stringify([tabAttempt])
    });
    await page.addInitScript(marker => {
      const state = { committed: false, removedBeforeCommit: false };
      Object.assign(window, { migrationCleanupReview: state });
      const written = new WeakSet<IDBTransaction>();
      const transact = IDBDatabase.prototype.transaction;
      // Observe commit before the app's handler resumes its cleanup promise.
      IDBDatabase.prototype.transaction = function (stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
        const transaction = transact.call(this, stores, mode, options);
        if (this.name === 'hayiti-guest') transaction.addEventListener('complete', () => {
          if (written.has(transaction)) state.committed = true;
        }, { once: true });
        return transaction;
      };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name === 'hayiti-guest') written.add(this.transaction);
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
      const remove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key: string) {
        if (['hayiti-unsigned-journal', 'hayiti-guest-merge'].includes(key) && !state.committed) state.removedBeforeCommit = true;
        remove.call(this, key);
      };
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'hayiti-unsigned-journal' && value === marker && !state.committed) state.removedBeforeCommit = true;
        set.call(this, key, value);
      };
    }, legacyGuestMarker);
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#trips option').filter({ hasText: 'Tab source' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Browser source', 'Tab source']);
    const saved = await readGuestRecord(page);
    assert.deepEqual(saved?.attempts, [localAttempt, tabAttempt]);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
    const cleanup = await page.evaluate(() => (window as unknown as Window & {
      migrationCleanupReview: { committed: boolean; removedBeforeCommit: boolean }
    }).migrationCleanupReview);
    assert.deepEqual(cleanup, { committed: true, removedBeforeCommit: false });
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
      await seedLegacyGuestOnce(page, {
        local: JSON.stringify({ trips: [trip('local', 'Browser legacy')] }),
        tab: JSON.stringify({ trips: [trip('tab-' + index, 'Tab legacy ' + index)] })
      });
    }
    await Promise.all(pages.map(page => page.goto(origin + '/journal.html?lang=en')));
    for (const page of pages) await page.locator('#newTrip:not([disabled])').waitFor();
    assert.deepEqual(await guestTitles(pages[0]), ['Browser legacy', 'Tab legacy 0', 'Tab legacy 1']);
    for (const page of pages) assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
    await Promise.all(pages.map(page => page.reload()));
    for (const page of pages) await page.locator('#newTrip:not([disabled])').waitFor();
    assert.deepEqual(await guestTitles(pages[0]), ['Browser legacy', 'Tab legacy 0', 'Tab legacy 1']);
    await context.close();
  } finally {
    await browser.close();
  }
});

await test('an aborted first migration retains both local and tab originals until a successful retry', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const sources = {
      local: JSON.stringify({ trips: [trip('legacy', 'Keep browser original')] }),
      tab: JSON.stringify({ trips: [trip('tab', 'Keep tab original')] }),
      localAttempts: '[]', tabAttempts: '[]'
    };
    await seedLegacyGuestOnce(page, sources);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('migration-retry') === 'yes') return;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name === 'hayiti-guest') {
          this.transaction.abort();
          throw new DOMException('Migration aborted', 'AbortError');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#retryLoad').waitFor();
    assert.deepEqual(await readLegacyGuestSources(page), sources);
    assert.equal(await readGuestRecord(page), null);
    assert.equal(await page.locator('#newTrip').isDisabled(), true);
    await page.evaluate(() => sessionStorage.setItem('migration-retry', 'yes'));
    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Keep tab original' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Keep browser original', 'Keep tab original']);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
  } finally {
    await browser.close();
  }
});

await test('a legacy source changed after commit survives cleanup and is reconciled on the next reload', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const a = trip('a', 'Browser original'), b = trip('b', 'Tab original');
    const changed = {
      local: JSON.stringify({ trips: [a, trip('c', 'Browser added after commit')] }),
      tab: JSON.stringify({ trips: [b, trip('d', 'Tab added after commit')] }),
      localAttempts: JSON.stringify([{ guestId: 'c', targetId: 'c', before: '', sent: 'new-browser-attempt' }]),
      tabAttempts: JSON.stringify([{ guestId: 'd', targetId: 'd', before: '', sent: 'new-tab-attempt' }])
    };
    await seedLegacyGuestOnce(page, {
      local: JSON.stringify({ trips: [a] }), tab: JSON.stringify({ trips: [b] }),
      localAttempts: '[]', tabAttempts: '[]'
    });
    await replaceLegacyGuestAfterCommit(page, changed);
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#trips option').filter({ hasText: 'Tab original' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Browser original', 'Tab original']);
    assert.deepEqual(await readLegacyGuestSources(page), changed);

    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Tab added after commit' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Browser added after commit', 'Browser original', 'Tab added after commit', 'Tab original']);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
  } finally {
    await browser.close();
  }
});

await test('cleanup also retains a newer retry fingerprint when its legacy trip bytes did not change', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const local = JSON.stringify({ trips: [trip('a', 'Browser trip')] });
    const tab = JSON.stringify({ trips: [trip('b', 'Tab trip')] });
    const localAttempt = { guestId: 'a', targetId: 'a', before: '', sent: 'new-browser-attempt' };
    const tabAttempt = { guestId: 'b', targetId: 'b', before: '', sent: 'new-tab-attempt' };
    const changed = { local, tab, localAttempts: JSON.stringify([localAttempt]), tabAttempts: JSON.stringify([tabAttempt]) };
    await seedLegacyGuestOnce(page, { local, tab, localAttempts: '[]', tabAttempts: '[]' });
    await replaceLegacyGuestAfterCommit(page, changed);
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#trips option').filter({ hasText: 'Tab trip' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Browser trip', 'Tab trip']);
    assert.deepEqual(await readLegacyGuestSources(page), changed);
    assert.deepEqual((await readGuestRecord(page))?.attempts, []);

    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Tab trip' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Browser trip', 'Tab trip']);
    assert.deepEqual((await readGuestRecord(page))?.attempts, [localAttempt, tabAttempt]);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
  } finally {
    await browser.close();
  }
});

await test('replayed legacy snapshots cannot resurrect a deleted trip or duplicate a conflicting edit', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const a = trip('a', 'Delete this trip'), b = trip('b', 'Browser B');
    const first = JSON.stringify({ trips: [a, b] });
    await seedLegacyGuestOnce(page, { local: first, tab: first, localAttempts: '[]', tabAttempts: '[]' });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#trips option').filter({ hasText: 'Browser B' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Browser B', 'Delete this trip']);
    await page.locator('#trips').selectOption('a');
    await page.locator('#settings').click();
    await page.locator('#deleteTrip').click();
    await page.locator('#confirmYes').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.deepEqual(await guestTitles(page), ['Browser B']);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });

    await page.locator('#settings').click();
    await page.locator('#tripForm [name=title]').fill('Canonical B edited');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.evaluate(({ key, source }) => {
      localStorage.setItem(key, source);
      sessionStorage.setItem(key, source);
    }, { key: legacyKey, source: first });
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Canonical B edited' }).waitFor();
    assert.deepEqual(await guestTitles(page), ['Canonical B edited']);

    const legacyEdit = { ...b, title: 'Legacy B edited' };
    await page.evaluate(({ key, source }) => localStorage.setItem(key, source), {
      key: legacyKey, source: JSON.stringify({ trips: [a, legacyEdit] })
    });
    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Legacy B edited' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Canonical B edited', 'Legacy B edited']);
    const imported = (await readGuestRecord(page))?.trips.find(item => item.title === 'Legacy B edited');
    assert.ok(imported && imported.id !== 'b');

    await page.evaluate(({ key, source }) => sessionStorage.setItem(key, source), {
      key: legacyKey, source: JSON.stringify({ trips: [a, legacyEdit, trip('c', 'Unrelated later trip')] })
    });
    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Unrelated later trip' }).waitFor({ state: 'attached' });
    assert.deepEqual(await guestTitles(page), ['Canonical B edited', 'Legacy B edited', 'Unrelated later trip']);
    const repeated = (await readGuestRecord(page))?.trips.filter(item => item.title === 'Legacy B edited');
    assert.deepEqual(repeated, [imported]);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
  } finally {
    await browser.close();
  }
});

await test('sign-in removes migrated legacy plaintext and replaying its old snapshot never restores a retired draft', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const bucket = new MemoryBucket();
    let signedIn = false, writes = 0;
    const source = JSON.stringify({ trips: [trip('signed-in-trip', 'Keep in the account')] });
    await seedLegacyGuestOnce(page, { local: source, tab: source, localAttempts: '[]', tabAttempts: '[]' });
    await hostGuest(page, async route => {
      const request = route.request();
      if (request.method() === 'POST') writes++;
      const response = await journalAPI(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postData()
      }), bucket, 'web', signedIn ? 'traveler' : null);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Keep in the account' }).waitFor();
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
    signedIn = true;
    await page.reload();
    await page.locator('#confirmText').filter({ hasText: 'Keep in the account' }).waitFor();
    await page.locator('#confirmYes').click();
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 1);
    assert.deepEqual((await loadState(bucket, 'traveler')).trips.map(item => item.title), ['Keep in the account']);
    assert.deepEqual(await guestTitles(page), []);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });

    await page.evaluate(({ key, old }) => {
      localStorage.setItem(key, old);
      sessionStorage.setItem(key, old);
      localStorage.setItem('hayiti-guest-merge', '[]');
      sessionStorage.setItem('hayiti-guest-merge', '[]');
    }, { key: legacyKey, old: source });
    await page.reload();
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(writes, 1);
    assert.deepEqual(await guestTitles(page), []);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });
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

await test('unavailable IndexedDB permits isolated temporary drafts without changing saved legacy trips', async () => {
  const browser = await chromium.launch();
  try {
    for (const missing of [false, true]) {
      const context = await browser.newContext();
      await context.addInitScript(absent => {
        if (absent) Object.defineProperty(window, 'indexedDB', { value: undefined });
        else IDBFactory.prototype.open = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
      }, missing);
      const page = await context.newPage();
      const serialized = JSON.stringify({ trips: [trip('retained', 'Retained saved trip')] });
      await seedLegacyGuestOnce(page, { local: serialized });
      await hostGuest(page);
      await page.goto(origin + '/journal.html?lang=en');
      await page.locator('#newTrip:not([disabled])').waitFor();
      assert.match(await page.locator('#status').innerText(), /temporary|this tab/i);
      assert.equal(await page.locator('#import').isEnabled(), true);
      await createTemporaryTrip(page, 'First temporary trip');
      assert.match(await page.locator('#status[data-tone="warning"]').innerText(), /this tab|back up/i);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), serialized);
      const saved = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).trips, temporaryGuestKey);
      assert.deepEqual(saved.map((entry: { title: string }) => entry.title), ['First temporary trip']);
      await page.reload();
      await page.locator('#title').filter({ hasText: 'First temporary trip' }).waitFor();

      const second = await context.newPage();
      await hostGuest(second);
      await second.goto(origin + '/journal.html?lang=en');
      await second.locator('#newTrip:not([disabled])').waitFor();
      assert.equal(await second.locator('#trips option').count(), 0);
      await createTemporaryTrip(second, 'Other tab temporary trip');
      await page.reload();
      await page.locator('#title').filter({ hasText: 'First temporary trip' }).waitFor();
      assert.deepEqual(await page.locator('#trips option').allTextContents(), ['First temporary trip']);
      assert.equal(await second.locator('#title').textContent(), 'Other tab temporary trip');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), serialized);

      const download = page.waitForEvent('download');
      await page.locator('#export').click();
      const path = await (await download).path();
      assert.ok(path);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).trip.title, 'First temporary trip');
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

await test('an isolated temporary draft keeps sign-in retry fingerprints until a lost reply is reconciled', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
    const bucket = new MemoryBucket();
    let signedIn = false, writes = 0;
    await hostGuest(page, async route => {
      const request = route.request();
      const response = await journalAPI(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postData()
      }), bucket, 'web', signedIn ? 'traveler' : null);
      if (request.method() === 'POST' && ++writes === 1) return route.abort();
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip:not([disabled])').waitFor();
    await createTemporaryTrip(page, 'Temporary before sign-in');
    const draft = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).trips[0], temporaryGuestKey);
    await storeState(bucket, 'traveler', [{ ...draft, title: 'Already saved account trip' }], '');
    await page.evaluate(() => {
      const login = document.getElementById('login')!;
      login.addEventListener('click', event => event.preventDefault(), { once: true });
      login.click();
    });
    signedIn = true;
    await page.reload();
    await page.locator('#status').filter({ hasText: 'confirm the save' }).waitFor();
    assert.equal(writes, 1);
    const pending = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), temporaryGuestKey);
    assert.equal(pending.trips.length, 1);
    assert.equal(pending.attempts.length, 1);
    await page.reload();
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(writes, 1);
    assert.deepEqual((await loadState(bucket, 'traveler')).trips.map(entry => entry.title),
      ['Already saved account trip', 'Temporary before sign-in (before sign-in)']);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), temporaryGuestKey), null);
  } finally {
    await browser.close();
  }
});

await test('a persisted temporary draft rejects failed edits and deletions without changing its last saved copy', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip:not([disabled])').waitFor();
    await createTemporaryTrip(page, 'Last saved temporary trip');
    const saved = await page.evaluate(key => sessionStorage.getItem(key), temporaryGuestKey);
    assert.ok(saved);
    await page.evaluate(key => {
      const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (name: string, value: string) {
        if (this === sessionStorage && name === key) throw new DOMException('Storage full', 'QuotaExceededError');
        set.call(this, name, value);
      };
      Storage.prototype.removeItem = function (name: string) {
        if (this === sessionStorage && name === key) throw new DOMException('Storage blocked', 'SecurityError');
        remove.call(this, name);
      };
    }, temporaryGuestKey);

    await page.locator('#settings').click();
    await page.locator('#tripForm [name=title]').fill('Rejected edit');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: 'could not save the edit' }).waitFor();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), temporaryGuestKey), saved);
    assert.equal(await page.locator('#title').textContent(), 'Last saved temporary trip');
    await page.locator('#config [data-close]').click();

    await page.locator('#settings').click();
    await page.locator('#deleteTrip').click();
    await page.locator('#confirmYes').click();
    await page.locator('#confirmBox').waitFor({ state: 'hidden' });
    await page.locator('#config .form-error').filter({ hasText: 'could not save the edit' }).waitFor();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), temporaryGuestKey), saved);
    assert.equal(await page.locator('#title').textContent(), 'Last saved temporary trip');

    await page.reload();
    await page.locator('#title').filter({ hasText: 'Last saved temporary trip' }).waitFor();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), temporaryGuestKey), saved);
  } finally {
    await browser.close();
  }
});

await test('a memory-only guest draft warns before leaving and keeps sign-in behind a backup', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined });
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Tab storage blocked', 'SecurityError'); } });
    });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip:not([disabled])').waitFor();
    await createTemporaryTrip(page, 'Memory-only trip');
    assert.match(await page.locator('#status[data-tone="warning"]').innerText(), /memory|tab|back up/i);
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), true);
    assert.equal(await page.evaluate(() => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.getElementById('login')!.dispatchEvent(event);
      return event.defaultPrevented;
    }), true);
    assert.match(await page.locator('#status').innerText(), /back up/i);
    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    const path = await (await download).path();
    assert.ok(path);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).trip.title, 'Memory-only trip');
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }), false);
  } finally {
    await browser.close();
  }
});

await test('a future isolated guest format stays untouched and cannot become an empty writable draft', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const future = JSON.stringify({ schemaVersion: 99, version: 'future', trips: [trip('future')], attempts: [], importedTabs: [], futureField: 'keep' });
    await page.addInitScript(({ key, value }) => {
      Object.defineProperty(window, 'indexedDB', { value: undefined });
      sessionStorage.setItem(key, value);
    }, { key: temporaryGuestKey, value: future });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#retryLoad, #discardDraft').filter({ visible: true }).first().waitFor();
    assert.equal(await page.locator('#newTrip').isDisabled(), true);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), temporaryGuestKey), future);
  } finally {
    await browser.close();
  }
});

await test('an unreadable or future legacy draft stays protected when IndexedDB is unavailable', async () => {
  const browser = await chromium.launch();
  try {
    for (const source of ['{broken', JSON.stringify({ schemaVersion: 99, trips: [trip('future')], futureField: 'keep' })]) {
      const page = await browser.newPage();
      await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
      await seedLegacyGuestOnce(page, { local: source });
      await hostGuest(page);
      await page.goto(origin + '/journal.html?lang=en');
      await page.locator('#retryLoad, #discardDraft').filter({ visible: true }).first().waitFor();
      assert.equal(await page.locator('#newTrip').isDisabled(), true);
      assert.equal(await page.locator('#import').isDisabled(), true);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), source);
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), temporaryGuestKey), null);
      await page.close();
    }
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

await test('discarding a broken tab draft migrates an ID-less browser trip once and preserves it on replay', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const local = JSON.stringify({ trips: [{ title: 'Keep the browser trip', start: date, end: date, stops: [] }] });
    await seedLegacyGuestOnce(page, { local, tab: '{broken' });
    await hostGuest(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#discardDraft').waitFor();
    assert.equal(await readGuestRecord(page), null);
    assert.deepEqual(await readLegacyGuestSources(page), { local, tab: '{broken', localAttempts: null, tabAttempts: null });

    await page.locator('#discardDraft').click();
    await page.locator('#confirmYes').click();
    await page.locator('#title').filter({ hasText: 'Keep the browser trip' }).waitFor();
    assert.deepEqual(await guestTitles(page), ['Keep the browser trip']);
    const before = await readGuestRecord(page);
    assert.deepEqual(await readLegacyGuestSources(page), { local: legacyGuestMarker, tab: null, localAttempts: null, tabAttempts: null });

    await page.evaluate(({ key, source }) => localStorage.setItem(key, source), { key: legacyKey, source: local });
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Keep the browser trip' }).waitFor();
    assert.deepEqual((await readGuestRecord(page))?.trips, before?.trips);
    assert.deepEqual(await guestTitles(page), ['Keep the browser trip']);
    assert.equal((await readLegacyGuestSources(page)).local, legacyGuestMarker);
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
