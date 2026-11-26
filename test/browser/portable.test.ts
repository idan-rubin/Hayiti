import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { chromium, type Page } from 'playwright-core';

// Reads the single HTML file out of a ZIP that the Share dialog offers for download.
async function offeredFile(page: Page, link: string) {
  await page.waitForFunction(id => document.querySelector<HTMLAnchorElement>(id)?.href.startsWith('blob:'), link);
  const bytes = await page.evaluate(async id => {
    const response = await fetch(document.querySelector<HTMLAnchorElement>(id)!.href);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, link);
  const [[name, content]] = Object.entries(unzipSync(Uint8Array.from(bytes)));
  return { name, html: strFromU8(content) };
}
await test('a traveler imports a trip offline, sees its pins, reloads it and exports a shareable route', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    const asset = (relative: string) => new URL(relative, import.meta.url);
    await page.goto(asset('../../dist/web/Hayiti.html').href);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#languageSwitch').inputValue(), 'en');
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles(fileURLToPath(asset('../../public/sample-trip.json')));
    await page.locator('#preview button').click();
    await page.locator('#title').filter({
      hasText: 'A Thursday in Tel Aviv'
    }).waitFor();
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
    await page.reload();
    await page.locator('#title').filter({
      hasText: 'A Thursday in Tel Aviv'
    }).waitFor();
    await page.locator('#share').click();
    await page.waitForFunction(() => document.querySelector<HTMLAnchorElement>('#downloadTrip')?.href.startsWith('blob:'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

await test('the journal honors language preferences and the public pages stay in English', async () => {
  const browser = await chromium.launch();
  try {
    for (const locale of ['en-IL', 'fr-FR', 'he', 'he-IL']) {
      const hebrew = locale.startsWith('he');
      const page = await browser.newPage({ locale });
      await page.route('https://**/*', route => route.abort());
      const web = new URL('../../dist/web/', import.meta.url);
      await page.goto(new URL('Hayiti.html', web).href);
      assert.equal(await page.locator('html').getAttribute('lang'), hebrew ? 'he' : 'en');
      assert.equal(await page.locator('#languageSwitch').inputValue(), hebrew ? 'he' : 'en');
      assert.equal(await page.locator('.brand-signature').getAttribute('alt'), 'hayiti');
      assert.equal(await page.locator('.brand').innerText(), '');
      if (!hebrew) assert.doesNotMatch(await page.locator('body').innerText(), /\p{Script=Hebrew}/u);
      await page.locator('#languageSwitch').selectOption(hebrew ? 'en' : 'he');
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('lang'), hebrew ? 'en' : 'he');
      for (const name of ['support.html', 'privacy.html', 'terms.html']) {
        await page.goto(new URL(name, web).href);
        assert.equal(await page.locator('html').getAttribute('lang'), 'en');
        assert.equal(await page.locator('#languageSwitch').count(), 0);
        assert.doesNotMatch(await page.locator('body').innerText(), /\p{Script=Hebrew}/u);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('an empty search, a missing payment account and a disconnected source have distinct guidance', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    for (const [source, status, summary, detail] of [
      ['finances', 'no_transactions', 'No transactions for these dates', 'receipts from Gmail'],
      ['finances', 'no_accounts', 'Link a payment account', 'credit card or a checking account'],
      ['gmail', 'disconnected', '1 source disconnected', 'Connect this source in ChatGPT']
    ] as const) {
      await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
      await page.locator('#import').click();
      await page.locator('[data-tab="files"]').click();
      const date = '2026-06-14';
      const trip = {
        id: status, title: status, start: date, end: date, stops: [],
        checks: { [source]: { status, start: date, end: date, at: date + 'T12:00:00Z' } }
      };
      await page.locator('#file').setInputFiles({
        name: 'fictional-trip.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip }))
      });
      await page.locator('#preview button').click();
      await page.getByRole('button', { name: summary, exact: true }).click();
      await page.getByText(detail, { exact: false }).waitFor();
      await page.locator('#sources [data-close]').click();
    }
  } finally {
    await browser.close();
  }
});

await test('editing the default home preserves a separate overnight stop', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const trip = {
      id: 'hotels', title: 'Two hotels', start: '2026-06-14', end: '2026-06-15',
      home: 'Hotel A', homeXY: [51, 4],
      stops: [
        { id: 'a', date: '2026-06-14', kind: 'origin', name: 'Hotel A', xy: [51, 4] },
        { id: 'b', date: '2026-06-15', kind: 'origin', name: 'Hotel B', address: 'East road', xy: [52, 5] }
      ]
    };
    await page.addInitScript(data => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [data] })), trip);
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.locator('#settings').click();
    await page.locator('#tripForm [name=home]').fill('New home');
    await page.locator('#tripForm [name=coords]').fill('53, 6');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('masluli-portable-v2')!).trips[0]);
    assert.equal(saved.stops[0].name, 'New home');
    assert.deepEqual(saved.stops[0].xy, [53, 6]);
    assert.equal(saved.stops[1].name, 'Hotel B');
    assert.deepEqual(saved.stops[1].xy, [52, 5]);
    assert.equal(saved.stops[1].address, 'East road');
  } finally {
    await browser.close();
  }
});

await test('refresh keeps an in-memory trip when portable storage is unavailable', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    });
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles(fileURLToPath(new URL('../../public/sample-trip.json', import.meta.url)));
    await page.locator('#preview button').click();
    await page.locator('#import').click();
    await page.locator('[data-tab="connected"]').click();
    await page.locator('#reload').click();
    await page.locator('#sources [data-close]').click();
    assert.equal(await page.locator('#title').textContent(), 'A Thursday in Tel Aviv');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
  } finally {
    await browser.close();
  }
});

await test('retrying a failed import applies the selected records exactly once', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles(fileURLToPath(new URL('../fixtures/rotterdam.json', import.meta.url)));
    await page.locator('#preview button').click();
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({
      name: 'stops.csv', mimeType: 'text/csv', buffer: Buffer.from('date,merchant\n2026-06-14,Ferry Terminal')
    });
    await page.evaluate(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function () {
        Storage.prototype.setItem = write;
        throw new Error('Transient write failure');
      };
    });
    await page.locator('#preview button').click();
    await page.locator('#sources .form-error').filter({ hasText: /could not save the edit/ }).waitFor();
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByRole('button', { name: 'Ferry Terminal', exact: true }).waitFor();
    assert.equal(await page.locator('#stops .stopname').count(), 3);
  } finally {
    await browser.close();
  }
});

await test('a photo-heavy portable journal survives localStorage quota and reload', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const photo = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(280000);
    const stops = Array.from({ length: 24 }, (_, index) => ({
      id: 'photo-' + index, name: 'Visit ' + index, date: '2026-06-14', photos: [photo]
    }));
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'photos.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: {
        id: 'photos', title: 'Photo trip', start: '2026-06-14', end: '2026-06-14', stops
      } }))
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => localStorage.getItem('masluli-portable-v2')), 'hayiti:indexeddb:1');
    await page.reload();
    await page.getByRole('button', { name: 'Visit 23', exact: true }).click();
    assert.equal(await page.locator('#photoPanel img').getAttribute('src'), photo);
    await page.locator('#editForm [name=name]').fill('Edited after migration');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByRole('button', { name: 'Edited after migration', exact: true }).waitFor();
    assert.equal(await page.locator('#stops .stopname').count(), 24);
  } finally {
    await browser.close();
  }
});

await test('missing sources and the last removed photo show Not recorded', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const date = '2026-06-14';
    const stops = [
      { id: 'a', date, name: 'Park' },
      { id: 'b', date, name: 'Beach', sources: ['photo'], photos: ['data:image/jpeg;base64,/9j/AAAA'] }
    ];
    await page.addInitScript(trip => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [trip] })),
      { id: 'trip', title: 'Day out', start: date, end: date, stops });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const source = page.locator('#editForm [name=source]');
    const selected = source.locator('option:checked');
    await page.getByRole('button', { name: 'Park', exact: true }).click();
    assert.deepEqual(await selected.allTextContents(), ['Not recorded']);
    await source.selectOption('manual');
    await source.selectOption('');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Beach', exact: true }).click();
    await page.locator('#photoPanel button').click();
    assert.deepEqual(await selected.allTextContents(), ['Not recorded']);
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('masluli-portable-v2')!).trips[0]);
    assert.deepEqual(saved.stops.map((stop: { sources: string[] }) => stop.sources), [[], []]);
    await page.getByRole('button', { name: 'Beach', exact: true }).click();
    assert.deepEqual(await selected.allTextContents(), ['Not recorded']);
  } finally {
    await browser.close();
  }
});

await test('correcting a stop\'s source replaces the old one and keeps corroborating sources', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const trip = {
      id: 'sources', title: 'Sources', start: '2026-06-14', end: '2026-06-14',
      stops: [
        { id: 'a', date: '2026-06-14', name: 'Markthal', sources: ['card', 'email'], refs: ['a'] },
        { id: 'b', date: '2026-06-14', name: 'Beach', sources: ['photo'], photos: ['data:image/jpeg;base64,/9j/AAAA'] }
      ]
    };
    await page.addInitScript(data => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [data] })), trip);
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.getByRole('button', { name: 'Markthal', exact: true }).click();
    assert.equal(await page.locator('#editForm [name=source]').inputValue(), 'card');
    await page.locator('#editForm [name=source]').selectOption('manual');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Beach', exact: true }).click();
    assert.equal(await page.locator('#editForm [name=source]').inputValue(), 'photo');
    await page.locator('#editForm [name=notes]').fill('Evening visit');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('masluli-portable-v2')!).trips[0]);
    assert.deepEqual(saved.stops[0].sources, ['manual', 'email']);
    assert.deepEqual(saved.stops[1].sources, ['photo']);
    assert.equal(saved.stops[1].notes, 'Evening visit');
  } finally {
    await browser.close();
  }
});

await test('untitled backups follow the display language and traveler-written titles stay verbatim', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const trip = { id: 'untitled', start: '2026-06-14', end: '2026-06-14', stops: [] };
    const importBackup = async (record: typeof trip & { title?: string }) => {
      await page.locator('#import').click();
      await page.locator('[data-tab="files"]').click();
      await page.locator('#file').setInputFiles({
        name: 'trip.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: record }))
      });
      await page.locator('#preview button').click();
      await page.locator('#sources').waitFor({ state: 'hidden' });
    };
    await importBackup(trip);
    assert.equal(await page.locator('#title').textContent(), 'My trip');
    await page.locator('#settings').click();
    assert.equal(await page.locator('#tripForm [name=title]').inputValue(), '');
    await page.locator('#tripForm [name=home]').fill('Hotel');
    await page.locator('#tripForm .primary').click();
    // Offline, the address cannot be looked up. The form says so, and saving again keeps it without a pin.
    await page.locator('#config .form-error').filter({ hasText: 'Address search is unavailable right now.' }).waitFor();
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.locator('#languageSwitch').selectOption('he');
    assert.equal(await page.locator('#title').textContent(), 'הטיול שלי');
    await page.locator('#languageSwitch').selectOption('en');
    await importBackup({ ...trip, id: 'named', title: 'הטיול שלי' });
    await page.reload();
    await page.locator('#trips option').first().waitFor({ state: 'attached' });
    assert.deepEqual(await page.locator('#trips option').allTextContents(), ['My trip', 'הטיול שלי']);
    await page.locator('#trips').selectOption('named');
    assert.equal(await page.locator('#title').textContent(), 'הטיול שלי');
  } finally {
    await browser.close();
  }
});

await test('an empty journal opens the sample trip in one step and links each stop to its pin', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.getByRole('button', { name: 'Try the sample trip' }).click();
    await page.locator('#title').filter({ hasText: 'A Thursday in Tel Aviv' }).waitFor();
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
    assert.equal(await page.locator('#welcome').isVisible(), false);

    await page.locator('.leaflet-marker-icon').first().click();
    assert.equal(await page.locator('#stops .activeStop .stopname').textContent(), 'Café Sonder');
    await page.getByRole('button', { name: 'Show on map: Anita Gelato' }).click();
    await page.locator('.leaflet-popup').filter({ hasText: 'Anita Gelato' }).getByRole('button', { name: 'Edit details' }).click();
    assert.equal(await page.locator('#editForm [name=name]').inputValue(), 'Anita Gelato');
  } finally {
    await browser.close();
  }
});

await test('reordering keeps keyboard focus, and Suggest walking order explains a day it cannot sort', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.getByRole('button', { name: 'Try the sample trip' }).click();
    await page.getByRole('button', { name: 'Move later: Café Sonder' }).click();
    await page.locator('#stops .stop').nth(1).filter({ hasText: 'Café Sonder' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Move later: Café Sonder');

    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Empty day');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.locator('#organize').click();
    await page.locator('#status').filter({ hasText: 'Add at least two stops' }).waitFor();
    assert.equal(await page.locator('#confirmBox').getAttribute('open'), null);
    assert.deepEqual(dialogs, []);
  } finally {
    await browser.close();
  }
});

await test('Escape cancels choosing a point on the map and returns to the stop being edited', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.getByRole('button', { name: 'Try the sample trip' }).click();
    await page.locator('#add').click();
    await page.locator('#editForm [name=name]').fill('Half-written stop');
    await page.locator('#pick').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.locator('#edit').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#edit').getAttribute('open'), '');
    assert.equal(await page.locator('#editForm [name=name]').inputValue(), 'Half-written stop');
    // A second Escape is the ordinary way to close the editor.
    await page.keyboard.press('Escape');
    await page.locator('#edit').waitFor({ state: 'hidden' });
  } finally {
    await browser.close();
  }
});

await test('a journal that lives only in its tab asks before leaving until the trip is backed up', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    });
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    const asksBeforeLeaving = () => page.evaluate(() => {
      const leaving = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    });
    assert.equal(await asksBeforeLeaving(), false);
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Kept in memory');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#status').getAttribute('data-tone'), 'warning');
    assert.equal(await asksBeforeLeaving(), true);
    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    await download;
    assert.equal(await asksBeforeLeaving(), false);
  } finally {
    await browser.close();
  }
});

await test('a journal file makes an exact copy of the blank app and a route file that opens with its pins', async () => {
  const browser = await chromium.launch();
  const folder = await mkdtemp(join(tmpdir(), 'hayiti-route-'));
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const built = new URL('../../dist/web/Hayiti.html', import.meta.url);
    await page.goto(built.href);
    await page.getByRole('button', { name: 'Try the sample trip' }).click();
    await page.locator('#share').click();

    // The file stores its code once, and still reproduces itself character for character.
    const app = await offeredFile(page, '#downloadApp');
    const original = await readFile(built, 'utf8');
    assert.equal(app.html.length, original.length);
    assert.ok(app.html === original, 'the blank app made from a running journal matches the built file');
    assert.equal(original.split('data-part="street-map">').length, 2);

    const route = await offeredFile(page, '#downloadTrip');
    const saved = join(folder, route.name);
    await writeFile(saved, route.html);
    const viewer = await browser.newPage(),
      errors: string[] = [];
    viewer.on('pageerror', error => errors.push(error.message));
    await viewer.route('https://**/*', request => request.abort());
    await viewer.goto(pathToFileURL(saved).href);
    await viewer.locator('#title').filter({ hasText: 'A Thursday in Tel Aviv' }).waitFor();
    assert.equal(await viewer.locator('.leaflet-marker-icon').count(), 7);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(folder, { recursive: true });
  }
});

await test('without a connection the map says the streets could not load and still shows the pins', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.getByRole('button', { name: 'Try the sample trip' }).click();
    await page.locator('#map[data-note]').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'The street map could not load. Pins and routes still appear.');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);

    // The streets arrive when the connection returns, drawn by the worker the file carries.
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } }] }
    }));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#map canvas.maplibregl-canvas').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), null);
  } finally {
    await browser.close();
  }
});

await test('a browser that cannot draw the street map says so and still shows the pins', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind.startsWith('webgl') ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.getByRole('button', { name: 'Try the sample trip' }).click();
    await page.locator('#map[data-note]').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'This browser cannot draw the street map. Pins and routes still appear.');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
  } finally {
    await browser.close();
  }
});

// Where each pin of the sample trip is drawn, on load and after zooming in twice.
async function samplePins(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route('https://**/*', route => route.abort());
  await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } }] }
  }));
  await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
  await page.getByRole('button', { name: 'Try the sample trip' }).click();
  await page.locator('#map[data-note]').waitFor();
  const places = () => page.evaluate(() => Array.from(document.querySelectorAll('.leaflet-marker-icon'), pin => {
    const box = pin.getBoundingClientRect();
    return [Math.round(box.x), Math.round(box.y)];
  }));
  await page.waitForTimeout(800);
  const loaded = await places();
  for (let step = 0; step < 2; step++) {
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForTimeout(800);
  }
  return { note: await page.locator('#map').getAttribute('data-note'), loaded, zoomed: await places(), layers: await page.locator('.leaflet-gl-layer').count() };
}

await test('a browser whose street map cannot start keeps every pin where a browser without WebGL shows it', async () => {
  const browser = await chromium.launch();
  try {
    // The reference: no WebGL at all, so the street map is never tried.
    const plain = await browser.newPage();
    await plain.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind.startsWith('webgl') ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    const expected = await samplePins(plain);
    assert.equal(expected.loaded.length, 7);
    assert.notDeepEqual(expected.zoomed, expected.loaded);

    // An older browser has the first version of WebGL only.
    const older = await browser.newPage(),
      olderErrors: string[] = [];
    older.on('pageerror', error => olderErrors.push(error.message));
    await older.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind === 'webgl2' ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    assert.deepEqual(await samplePins(older), expected);
    assert.deepEqual(olderErrors, []);

    // A browser can also offer WebGL and then refuse it to the map itself.
    const refusing = await browser.newPage(),
      refusingErrors: string[] = [];
    refusing.on('pageerror', error => refusingErrors.push(error.message));
    await refusing.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind.startsWith('webgl') && this.className.includes('maplibregl') ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    assert.deepEqual(await samplePins(refusing), expected);
    assert.deepEqual(refusingErrors, []);
  } finally {
    await browser.close();
  }
});

await test('streets that fail to load after the style say so and load when the connection returns', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        version: 8,
        sources: { streets: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
        layers: [
          { id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } },
          { id: 'roads', type: 'line', source: 'streets', 'source-layer': 'transportation' }
        ]
      }
    }));
    let connected = false,
      described = 0,
      tiles = 0;
    await page.route('https://tiles.openfreemap.org/planet', route => {
      if (!connected) return route.abort();
      described++;
      return route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: { tilejson: '2.2.0', tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 }
      });
    });
    await page.route('https://tiles.openfreemap.org/planet/**', route => {
      tiles++;
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.getByRole('button', { name: 'Try the sample trip' }).click();
    await page.locator('#map canvas.maplibregl-canvas').waitFor();
    await page.locator('#map[data-note]').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'The street map could not load. Pins and routes still appear.');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);

    connected = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#map:not([data-note]) canvas.maplibregl-canvas').waitFor();
    await page.waitForTimeout(1500);
    assert.equal(described, 1);
    assert.ok(tiles > 0, 'the street tiles are requested after the connection returns');
    assert.equal(await page.locator('#map').getAttribute('data-note'), null);
    assert.equal(await page.locator('#map canvas.maplibregl-canvas').count(), 1);
  } finally {
    await browser.close();
  }
});
