import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { cleanTrip } from '../../src/domain/core.ts';
import { oldPortableClientHTML, type OldPortableClient } from './old-portable-client-fixture.ts';
import { patchPortableRecord, readPortableRecord } from './portable-storage-helpers.ts';

const origin = 'https://portable.test';
const legacyKey = 'masluli-portable-v2';
const date = '2026-06-14';
const seedTrip = () => cleanTrip({
  id: 'trip', title: 'Original journal', start: date, end: date,
  stops: [
    { id: 'market', name: 'Market', date, xy: [51.92, 4.48] },
    { id: 'purchase', name: 'Purchase', date, kind: 'uncertain', sources: ['card'], reviewReason: 'Branch not confirmed' }
  ],
  googlePins: [{ id: 'saved', name: 'Saved gallery', date, xy: [51.921, 4.481] }],
  removedGooglePinIds: ['removed-bookmark']
});
type OldWindow = Window & { oldPortableClient: OldPortableClient };

async function host(page: Page) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/old.html') return route.fulfill({ contentType: 'text/html', body: oldPortableClientHTML });
    if (path === '/new.html') return route.fulfill({ contentType: 'text/html', body: await readFile(new URL('../../dist/web/Hayiti.html', import.meta.url)) });
    return route.fulfill({ status: 404 });
  });
}

async function legacyRecord(page: Page): Promise<string | null> {
  return page.evaluate(() => new Promise<string | null>((resolve, reject) => {
    const open = indexedDB.open('hayiti-portable', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('journal');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('journal');
      const request = transaction.objectStore('journal').get('current');
      transaction.oncomplete = () => { database.close(); resolve(request.result ?? null); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

async function seedLegacy(page: Page, raw: string, storage: 'local' | 'database') {
  await page.evaluate(({ raw, storage, key }) => {
    if (storage === 'local') { localStorage.setItem(key, raw); return; }
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('hayiti-portable', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('journal');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('journal', 'readwrite');
        transaction.objectStore('journal').put(raw, 'current');
        transaction.oncomplete = () => { database.close(); localStorage.setItem(key, 'hayiti:indexeddb:1'); resolve(); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
  }, { raw, storage, key: legacyKey });
}

async function saveOld(page: Page, title: string, storage: 'local' | 'database') {
  return page.evaluate(async ({ title, storage }) => {
    const old = (window as unknown as OldWindow).oldPortableClient;
    old.rename(title);
    if (storage === 'database') old.forceLocalQuota();
    try { await old.save(); return null; }
    catch (error) { return error instanceof DOMException ? error.name : String(error); }
  }, { title, storage });
}

await test('historical readers cannot see canonical pins and cached old writes become stable recoverable copies', async () => {
  assert.doesNotMatch(oldPortableClientHTML, /current-v3|googlePins|removedGooglePinIds/);
  const browser = await chromium.launch();
  try {
    for (const storage of ['local', 'database'] as const) {
      const context = await browser.newContext();
      const old = await context.newPage(), current = await context.newPage(), freshOld = await context.newPage();
      for (const page of [old, current, freshOld]) await host(page);
      await old.goto(origin + '/old.html');
      const original = seedTrip();
      await seedLegacy(old, JSON.stringify({ trips: [original] }), storage);
      const historical = await old.evaluate(() => (window as unknown as OldWindow).oldPortableClient.read());
      assert.equal(Object.hasOwn(historical.trips[0], 'googlePins'), false);
      assert.doesNotMatch(JSON.stringify(historical), /reviewReason|Branch not confirmed/);
      await current.goto(origin + '/new.html?lang=en');
      await current.locator('#title').filter({ hasText: original.title }).waitFor();
      assert.deepEqual((await readPortableRecord(current))?.trips[0].googlePins, original.googlePins);
      assert.equal(await legacyRecord(current), null);
      assert.deepEqual(await current.evaluate(key => JSON.parse(localStorage.getItem(key)!), legacyKey), { hayitiUpgradeRequired: true });

      await freshOld.goto(origin + '/old.html');
      const blocked = await freshOld.evaluate(async () => {
        try { await (window as unknown as OldWindow).oldPortableClient.read(); return false; }
        catch { return true; }
      });
      assert.equal(blocked, true);
      await current.locator('#settings').click();
      await current.locator('#tripForm [name=title]').fill('New journal edit');
      await current.locator('#tripForm .primary').click();
      await current.locator('#config').waitFor({ state: 'hidden' });

      const result = await saveOld(old, 'Old cached edit', storage);
      assert.equal(result, storage === 'database' ? 'QuotaExceededError' : null);
      await current.reload();
      await current.locator('#trips option').filter({ hasText: 'Old cached edit' }).waitFor({ state: 'attached' });
      const merged = await readPortableRecord(current);
      assert.ok(merged);
      assert.equal(merged.trips.length, 2);
      const kept = merged.trips.find(trip => trip.id === original.id);
      const recovered = merged.trips.find(trip => trip.id !== original.id);
      assert.equal(kept?.title, 'New journal edit');
      assert.deepEqual(kept?.googlePins, original.googlePins);
      assert.deepEqual(kept?.removedGooglePinIds, original.removedGooglePinIds);
      assert.equal(kept?.stops.find(stop => stop.id === 'purchase')?.reviewReason, 'Branch not confirmed');
      assert.equal(recovered?.title, 'Old cached edit');
      assert.equal(recovered?.googlePins, undefined);
      assert.equal(await legacyRecord(current), null);
      const ids = merged.trips.map(trip => trip.id);
      await current.reload();
      await current.locator('#trips option').filter({ hasText: 'Old cached edit' }).waitFor({ state: 'attached' });
      assert.deepEqual((await readPortableRecord(current))?.trips.map(trip => trip.id), ids);

      assert.ok(recovered);
      await current.locator('#trips').selectOption(recovered.id);
      await current.locator('#settings').click();
      await current.locator('#deleteTrip').click();
      await current.locator('#confirmYes').click();
      await current.locator('#config').waitFor({ state: 'hidden' });
      await saveOld(old, 'Old cached edit', storage);
      await current.reload();
      await current.locator('#title').filter({ hasText: 'New journal edit' }).waitFor();
      assert.deepEqual((await readPortableRecord(current))?.trips.map(trip => trip.id), [original.id]);
      assert.deepEqual((await readPortableRecord(current))?.trips[0].googlePins, original.googlePins);
      await context.close();
    }
  } finally { await browser.close(); }
});

await test('the trip picker distinguishes recovered copies that have the same title in either language', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await host(page);
    await page.goto(origin + '/old.html');
    const original = { ...seedTrip(), title: 'Tel Aviv' };
    const ordinary = { ...original, id: 'legacy-' + '0'.repeat(64), title: 'Haifa' };
    await seedLegacy(page, JSON.stringify({ trips: [original, ordinary] }), 'local');
    await page.goto(origin + '/new.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Tel Aviv' }).waitFor();
    for (const home of ['Hotel', 'Apartment']) {
      await seedLegacy(page, JSON.stringify({ trips: [{ ...original, home }] }), 'local');
      await page.reload();
      const copyLabel = home === 'Hotel' ? 'Recovered copy' : 'Recovered copy 2';
      await page.locator('#trips option').filter({ hasText: 'Tel Aviv (' + copyLabel + ')' }).waitFor({ state: 'attached' });
    }
    const options = page.locator('#trips option');
    assert.deepEqual(await options.allTextContents(), ['Tel Aviv', 'Haifa', 'Tel Aviv (Recovered copy)', 'Tel Aviv (Recovered copy 2)']);
    await page.locator('#languageSwitch').selectOption('he');
    await page.reload();
    await options.filter({ hasText: 'Tel Aviv (עותק משוחזר 2)' }).waitFor({ state: 'attached' });
    assert.deepEqual(await options.allTextContents(), ['Tel Aviv', 'Haifa', 'Tel Aviv (עותק משוחזר)', 'Tel Aviv (עותק משוחזר 2)']);
    await page.locator('#trips').selectOption({ label: 'Tel Aviv (עותק משוחזר)' });
    assert.equal(await page.locator('#title').textContent(), 'Tel Aviv (עותק משוחזר)');
    await page.locator('#settings').click();
    assert.equal(await page.locator('#tripForm [name=title]').inputValue(), 'Tel Aviv');
  } finally { await browser.close(); }
});

await test('a legacy write arriving during a modern edit causes a visible conflict and preserves both versions on retry', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const old = await context.newPage(), current = await context.newPage();
    for (const page of [old, current]) await host(page);
    await old.goto(origin + '/old.html');
    const original = seedTrip();
    await seedLegacy(old, JSON.stringify({ trips: [original] }), 'local');
    await old.evaluate(() => (window as unknown as OldWindow).oldPortableClient.read());
    await current.goto(origin + '/new.html?lang=en');
    await current.locator('#title').filter({ hasText: original.title }).waitFor();
    await current.locator('#settings').click();
    await current.locator('#tripForm [name=title]').fill('Modern form edit');
    await saveOld(old, 'Old edit arrived', 'local');
    await current.locator('#tripForm .primary').click();
    await current.locator('#config .form-error').filter({ hasText: /changed|latest version/i }).waitFor();
    assert.equal(await current.locator('#tripForm [name=title]').inputValue(), 'Modern form edit');
    assert.deepEqual((await readPortableRecord(current))?.trips.map(trip => trip.title).sort(), ['Old edit arrived', 'Original journal']);
    await current.locator('#tripForm .primary').click();
    await current.locator('#config').waitFor({ state: 'hidden' });
    const saved = await readPortableRecord(current);
    assert.deepEqual(saved?.trips.map(trip => trip.title).sort(), ['Modern form edit', 'Old edit arrived']);
    assert.deepEqual(saved?.trips.find(trip => trip.id === original.id)?.googlePins, original.googlePins);
    await context.close();
  } finally { await browser.close(); }
});

await test('future canonical and legacy portable schemas are retained without opening an editable empty journal', async () => {
  const browser = await chromium.launch();
  try {
    for (const storage of ['canonical', 'local', 'database'] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await host(page);
      await page.goto(origin + '/old.html');
      const future = { schemaVersion: 2, trips: [{ ...seedTrip(), futureField: { keep: 'exactly' } }] };
      if (storage === 'canonical') {
        await seedLegacy(page, JSON.stringify({ trips: [seedTrip()] }), 'local');
        await page.goto(origin + '/new.html?lang=en');
        await page.locator('#title').filter({ hasText: 'Original journal' }).waitFor();
        await patchPortableRecord(page, future);
      } else await seedLegacy(page, JSON.stringify(future), storage);
      const before = storage === 'canonical' ? await readPortableRecord(page) : JSON.stringify(future);
      await page.goto(origin + '/new.html?lang=en');
      await page.locator('#retryLoad').waitFor();
      assert.equal(await page.locator('#newTrip').isDisabled(), true);
      assert.equal(await page.locator('#import').isDisabled(), true);
      assert.match(await page.locator('#status').innerText(), /different app version|Reload/i);
      if (storage === 'canonical') assert.deepEqual(await readPortableRecord(page), before);
      else if (storage === 'local') assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), before);
      else assert.equal(await legacyRecord(page), before);
      await context.close();
    }
  } finally { await browser.close(); }
});

await test('aborted portable migration preserves both legacy addresses until a successful retry commits', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await host(page);
    await page.goto(origin + '/old.html');
    const raw = JSON.stringify({ trips: [seedTrip()] });
    await seedLegacy(page, raw, 'database');
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: legacyKey, raw });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('portable-migration-retry') === 'yes') return;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name === 'hayiti-portable' && key === 'current-v3') {
          this.transaction.abort();
          throw new DOMException('Migration aborted', 'AbortError');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    });
    await page.goto(origin + '/new.html?lang=en');
    await page.locator('#retryLoad').waitFor();
    assert.equal(await readPortableRecord(page), null);
    assert.equal(await legacyRecord(page), raw);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), raw);
    await page.evaluate(() => sessionStorage.setItem('portable-migration-retry', 'yes'));
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Original journal' }).waitFor();
    assert.deepEqual((await readPortableRecord(page))?.trips[0].googlePins, seedTrip().googlePins);
    assert.equal(await legacyRecord(page), null);
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), legacyKey), { hayitiUpgradeRequired: true });
    await context.close();
  } finally { await browser.close(); }
});

await test('simultaneous local and database legacy writes retain stable copies beside newer canonical edits', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const old = await context.newPage(), current = await context.newPage();
    for (const page of [old, current]) await host(page);
    await old.goto(origin + '/old.html');
    const original = seedTrip();
    await seedLegacy(old, JSON.stringify({ trips: [original] }), 'local');
    await current.goto(origin + '/new.html?lang=en');
    await current.locator('#title').filter({ hasText: original.title }).waitFor();
    await current.locator('#settings').click();
    await current.locator('#tripForm [name=title]').fill('Canonical edit');
    await current.locator('#tripForm .primary').click();
    await current.locator('#config').waitFor({ state: 'hidden' });
    const local = JSON.stringify({ trips: [{ ...original, title: 'Local legacy edit' }] });
    const database = JSON.stringify({ trips: [{ ...original, title: 'Database legacy edit' }] });
    const replay = async () => {
      await seedLegacy(old, database, 'database');
      await seedLegacy(old, local, 'local');
      await current.reload();
      await current.locator('#trips option').filter({ hasText: 'Local legacy edit' }).waitFor({ state: 'attached' });
    };
    await replay();
    const combined = await readPortableRecord(current);
    assert.deepEqual(combined?.trips.map(trip => trip.title).sort(), ['Canonical edit', 'Database legacy edit', 'Local legacy edit']);
    assert.deepEqual(combined?.trips.find(trip => trip.id === original.id)?.googlePins, original.googlePins);
    const ids = combined?.trips.map(trip => trip.id);
    await replay();
    assert.deepEqual((await readPortableRecord(current))?.trips.map(trip => trip.id), ids);
    assert.equal(await legacyRecord(current), null);
    await context.close();
  } finally { await browser.close(); }
});

await test('an explicit backup restore recovers the missing journal and keeps surviving legacy trips', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage(), stale = await context.newPage();
    for (const tab of [page, stale]) await host(tab);
    await page.goto(origin + '/old.html');
    const trip = seedTrip();
    const original = JSON.stringify({ trips: [trip, { ...trip, id: 'other', title: 'Only in the old file' }] });
    const marker = JSON.stringify({ hayitiUpgradeRequired: true });
    await seedLegacy(page, original, 'database');
    await page.evaluate(({ key, marker }) => localStorage.setItem(key, marker), { key: legacyKey, marker });
    for (const tab of [page, stale]) {
      await tab.goto(origin + '/new.html?lang=en');
      await tab.locator('#status').filter({ hasText: 'saved portable journal is missing' }).waitFor();
    }
    await stale.locator('#newTrip').click();
    await stale.locator('#tripForm [name=title]').fill('Stale save');
    await page.locator('#import').click();
    const upload = (contents: string) => page.locator('#file').setInputFiles({
      name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(contents)
    });
    await upload('{');
    await page.locator('#preview').filter({ hasText: /./ }).waitFor();
    assert.equal(await page.locator('#preview button').count(), 0);
    const backup = { ...trip, title: 'Restored backup', googlePins: [] };
    await upload(JSON.stringify({ format: 'hayiti/1', trip: backup }));
    await page.getByRole('button', { name: 'Load trip' }).waitFor();
    assert.equal(await readPortableRecord(page), null);
    assert.equal(await legacyRecord(page), original);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), marker);
    await page.getByRole('button', { name: 'Load trip' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    await page.reload();
    await page.locator('#title').filter({ hasText: backup.title }).waitFor();
    const saved = await readPortableRecord(page);
    assert.deepEqual(saved?.trips.map(t => t.title).sort(), ['Only in the old file', 'Original journal', 'Restored backup']);
    assert.equal(saved?.trips.find(t => t.id === trip.id)?.title, backup.title);
    assert.deepEqual(saved?.trips.find(t => t.title === trip.title)?.googlePins, trip.googlePins);
    assert.equal(await legacyRecord(page), null);

    await stale.locator('#tripForm .primary').click();
    await stale.locator('#config .form-error').filter({ hasText: /changed/ }).waitFor();
    assert.deepEqual(await readPortableRecord(page), saved);
  } finally { await browser.close(); }
});

await test('a missing portable journal can start a new trip without a backup', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await host(page);
    await page.goto(origin + '/old.html');
    await page.evaluate(key => localStorage.setItem(key, 'hayiti:indexeddb:1'), legacyKey);
    await page.goto(origin + '/new.html?lang=he');
    await page.locator('#status').filter({ hasText: 'היומן השמור בדפדפן חסר' }).waitFor();
    await page.locator('#newTrip').click();
    assert.equal(await readPortableRecord(page), null);
    await page.locator('#tripForm [name=title]').fill('Starting again');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Starting again' }).waitFor();
    assert.deepEqual((await readPortableRecord(page))?.trips.map(t => t.title), ['Starting again']);
  } finally { await browser.close(); }
});
