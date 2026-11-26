import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
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
    await page.locator('#connections').click();
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
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#preview button').click();
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
