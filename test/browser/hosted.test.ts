import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, type Page, type Route } from 'playwright-core';
import { journalAPI } from '../../src/server/journal-api.ts';
import { MemoryBucket } from '../memory-bucket.ts';

// An https origin keeps the page a secure context, as the hosted journal is.
const origin = 'https://hayiti.test';
const types: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', ico: 'image/x-icon', json: 'application/json'
};

// Serves the built hosted journal from a fictional origin and lets each test answer the API calls.
async function hostJournal(page: Page, api: (route: Route) => Promise<void> | void) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/api/')) return api(route);
    try {
      const body = await readFile(new URL('../../dist/web' + pathname, import.meta.url));
      await route.fulfill({ body, contentType: types[pathname.split('.').at(-1) ?? ''] ?? 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
}

await test('a trip started before signing in is added to the journal after sign-in', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const bucket = new MemoryBucket();
    let writes = 0;
    await hostJournal(page, async route => {
      const request = route.request();
      if (request.method() === 'POST') writes++;
      const response = await journalAPI(new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postData()
      }), bucket, 'web', signedIn ? 'traveler' : null);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Before sign-in');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });

    await page.reload();
    await page.locator('#title').filter({ hasText: 'Before sign-in' }).waitFor();

    signedIn = true;
    await page.reload();
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Before sign-in');
    assert.equal(writes, 1);

    await page.reload();
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Before sign-in');
    assert.equal(writes, 1);
  } finally {
    await browser.close();
  }
});

await test('a shared route stays on screen through a temporary failure and clears when revoked', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let status = 200;
    const snapshot = {
      id: 'shared', title: 'Shared day', start: '2026-06-14', end: '2026-06-15',
      stops: [{ id: 'a', date: '2026-06-15', name: 'Markthal', xy: [51.92, 4.4867] }]
    };
    await hostJournal(page, route => status === 200 && route.request().method() === 'GET'
      ? route.fulfill({ json: snapshot })
      : route.fulfill({ status }));
    await page.goto(origin + '/journal.html?lang=en#route=fictional');
    await page.locator('body.route-ready').waitFor();
    const recheck = async () => {
      const answered = page.waitForResponse(response => response.url().endsWith('/api/route-links'));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await answered;
    };

    status = 503;
    await recheck();
    assert.equal(await page.locator('#title').textContent(), 'Shared day');
    assert.equal(await page.locator('body.route-ready').count(), 1);

    status = 404;
    await recheck();
    await page.locator('body:not(.route-ready)').waitFor();
    await page.getByRole('heading', { name: 'This shared route isn’t available' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Start your own trip journal' }).isVisible(), true);
  } finally {
    await browser.close();
  }
});

const draftKey = 'hayiti-unsigned-journal';
async function openConnectedAccounts(page: Page) {
  await page.locator('#import').click();
  await page.locator('[data-tab="connected"]').click();
}
async function refreshJournal(page: Page) {
  await openConnectedAccounts(page);
  await page.locator('#reload').click();
  await page.locator('#sources [data-close]').click();
}
async function createTrip(page: Page, title: string, date?: string) {
  await page.locator('#newTrip').click();
  await page.locator('#tripForm [name=title]').fill(title);
  if (date) for (const name of ['start', 'end']) await page.locator('#tripForm [name=' + name + ']').fill(date);
  await page.locator('#tripForm .primary').click();
  await page.locator('#config').waitFor({ state: 'hidden' });
}

await test('an account journal leaves the tab when its session ends and never becomes a guest draft', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = true;
    const account = { id: 'account', title: 'Account trip', start: '2026-06-14', end: '2026-06-14', stops: [] };
    await hostJournal(page, route => signedIn
      ? route.fulfill({ json: { trips: [account], rev: 'r1' } })
      : route.fulfill({ status: 401, json: { error: 'Authentication required' } }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Account trip' }).waitFor();

    signedIn = false;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'You are signed out' }).waitFor();
    assert.notEqual(await page.locator('#title').textContent(), 'Account trip');

    await createTrip(page, 'Guest trip');
    const draft = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), draftKey);
    assert.deepEqual(draft.trips.map((trip: { title: string }) => trip.title), ['Guest trip']);
  } finally {
    await browser.close();
  }
});

await test('guest edits to an untitled account trip get a distinct name in the picker', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const first = { id: 'a', date: '2026-06-14', name: 'Markthal' };
    const trip = { id: 'rotterdam', title: '', start: '2026-06-14', end: '2026-06-14', stops: [first] };
    const saved: { trips: { title: string; stops: unknown[] }[] }[] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: [trip], rev: 'r1' } });
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { rev: 'r2' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'rotterdam.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: {
        ...trip, stops: [first, { id: 'b', date: '2026-06-14', name: 'Cube Houses' }]
      } }))
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });

    signedIn = true;
    await page.reload();
    await page.locator('#status').filter({ hasText: 'kept as a separate copy' }).waitFor();
    assert.deepEqual(saved.map(body => body.trips.map(item => [item.title, item.stops.length])),
      [[['', 1], ['My trip (before sign-in)', 2]]]);
    assert.deepEqual(await page.locator('#trips option').allTextContents(), ['My trip', 'My trip (before sign-in)']);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
  } finally {
    await browser.close();
  }
});

await test('a save that fails after the session ended does not bring the account journal back', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = true,
      release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const account = { id: 'account', title: 'Account trip', start: '2026-06-14', end: '2026-06-14', stops: [] };
    const signedOut = { status: 401, json: { error: 'Authentication required' } };
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        await held;
        return route.fulfill(signedOut);
      }
      return route.fulfill(signedIn ? { json: { trips: [account], rev: 'r1' } } : signedOut);
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Account trip' }).waitFor();

    const saving = page.waitForRequest(request => request.method() === 'POST');
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('In flight');
    await page.locator('#tripForm .primary').click();
    await saving;
    signedIn = false;
    await page.evaluate(() => document.getElementById('reload')!.click());
    await page.locator('#status').filter({ hasText: 'You are signed out' }).waitFor();
    const failed = page.waitForResponse(response => response.request().method() === 'POST');
    release();
    await page.locator('#config .form-error').filter({ hasText: /edit was not saved/i }).waitFor();
    await (await failed).finished();

    assert.notEqual(await page.locator('#title').textContent(), 'Account trip');
    assert.equal(await page.locator('#trips option').count(), 0);
    await page.locator('#config [data-close]').click();
    await createTrip(page, 'Guest trip');
    const draft = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), draftKey);
    assert.deepEqual(draft.trips.map((trip: { title: string }) => trip.title), ['Guest trip']);
  } finally {
    await browser.close();
  }
});

await test('retrying sign-in after a lost reply does not add the guest copy twice', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const first = { id: 'a', date: '2026-06-14', name: 'Markthal' };
    const trip = { id: 'rotterdam', title: 'Rotterdam', start: '2026-06-14', end: '2026-06-14', stops: [first] };
    let account: { title: string }[] = [trip],
      posts = 0;
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: account, rev: 'r' + posts } });
      account = route.request().postDataJSON().trips;
      // The server stores the first save, but its reply never reaches the browser.
      return ++posts === 1 ? route.abort() : route.fulfill({ json: { rev: 'r' + posts } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'rotterdam.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: {
        ...trip, stops: [first, { id: 'b', date: '2026-06-14', name: 'Cube Houses' }]
      } }))
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });

    signedIn = true;
    const lost = page.waitForEvent('requestfailed', request => request.method() === 'POST');
    await page.reload();
    await lost;
    await page.locator('#status').filter({ hasText: 'Choose Refresh journal to check' }).waitFor();
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(posts, 1);
    assert.deepEqual(account.map(item => item.title), ['Rotterdam', 'Rotterdam (before sign-in)']);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
  } finally {
    await browser.close();
  }
});

await test('a guest edit the tab cannot store fails, and the stored trip is untouched', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, route => route.fulfill({ status: 401, json: { error: 'Authentication required' } }));
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Small trip');
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
    });
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Does not fit');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: /could not save the edit/ }).waitFor();
    assert.equal(await page.locator('#config').getAttribute('open'), '');
    assert.equal(await page.locator('#title').textContent(), 'Small trip');

    await page.reload();
    await page.locator('#title').filter({ hasText: 'Small trip' }).waitFor();
    assert.equal(await page.locator('#trips option').count(), 1);
  } finally {
    await browser.close();
  }
});

await test('refreshing after signing in elsewhere adds the guest trip with its stops', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const saved: { trips: { stops: { name: string }[] }[] }[] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: [], rev: '' } });
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { rev: 'r1' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip', '2026-06-14');
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({
      name: 'stops.csv', mimeType: 'text/csv', buffer: Buffer.from('date,merchant\n2026-06-14,Ferry Terminal')
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });

    signedIn = true;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.deepEqual(saved.map(body => body.trips.map(trip => trip.stops.map(stop => stop.name))), [[['Ferry Terminal']]]);
    await page.getByRole('button', { name: 'Ferry Terminal', exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('a refused guest merge keeps the selected trip and day', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const trips = [
      { id: 'a', title: 'First trip', start: '2026-05-01', end: '2026-05-01', stops: [] },
      { id: 'b', title: 'Second trip', start: '2026-06-14', end: '2026-06-16', stops: [] }
    ];
    await page.addInitScript(({ key, trips }) => sessionStorage.setItem(key, JSON.stringify({ trips })), { key: draftKey, trips });
    let signedIn = false;
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: [], rev: '' } });
      return route.fulfill({ status: 400, json: { error: 'Invalid journal' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#trips').selectOption('b');
    await page.locator('#dayReel').press('End');
    assert.equal(await page.locator('#tripDate').inputValue(), trips[1].end);
    signedIn = true;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'Invalid journal' }).waitFor();
    assert.equal(await page.locator('#trips').inputValue(), 'b');
    assert.equal(await page.locator('#tripDate').inputValue(), trips[1].end);
  } finally {
    await browser.close();
  }
});

await test('when the journal cannot take a guest trip, the traveler can back it up or delete it and then open the journal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const account = { id: 'account', title: 'Account trip', start: '2026-06-14', end: '2026-06-14', stops: [] };
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: [account], rev: 'r1' } });
      return route.fulfill({ status: 400, json: { error: 'Invalid journal' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    signedIn = true;
    await page.reload();
    await page.locator('#status').filter({ hasText: 'could not take the trips from this tab (Invalid journal)' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Guest trip');
    assert.equal(await page.locator('#export').isDisabled(), false);

    await page.locator('#settings').click();
    await page.locator('#deleteTrip').click();
    await page.locator('#confirmYes').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await refreshJournal(page);
    await page.locator('#title').filter({ hasText: 'Account trip' }).waitFor();
    assert.equal(await page.locator('#status').textContent(), 'Your journal is up to date.');
  } finally {
    await browser.close();
  }
});

await test('overlapping refreshes share one load: one save, one status, and the journal stays editable', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false,
      rev = 0,
      reads = 0,
      account: { title: string }[] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') {
        reads++;
        return route.fulfill({ json: { trips: account, rev: 'r' + rev } });
      }
      const body = route.request().postDataJSON();
      if (body.rev !== 'r' + rev) return route.fulfill({ status: 409, json: { error: 'CONFLICT' } });
      account = body.trips;
      return route.fulfill({ json: { rev: 'r' + ++rev } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    signedIn = true;
    await page.evaluate(() => {
      document.getElementById('reload')!.click();
      document.getElementById('reload')!.click();
    });
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(reads, 1);
    assert.equal(rev, 1);
    assert.equal(await page.locator('#status').textContent(), 'The trip you started before signing in is now in your journal.');
    await createTrip(page, 'Second trip');
    assert.deepEqual(account.map(item => item.title), ['Guest trip', 'Second trip']);
  } finally {
    await browser.close();
  }
});

await test('a refresh started before a save keeps the saved trip and revision', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0, rev = 'r1';
    let trips = [{ title: 'First', id: 'first', start: '2026-06-14', end: '2026-06-14', stops: [] }];
    await hostJournal(page, async route => {
      if (route.request().method() === 'GET') {
        const snapshot = { trips, rev };
        if (++reads === 2) await held;
        return route.fulfill({ json: snapshot });
      }
      const body = route.request().postDataJSON();
      assert.equal(body.rev, rev);
      trips = body.trips;
      rev = 'r' + trips.length;
      return route.fulfill({ json: { rev } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'First' }).waitFor();
    await openConnectedAccounts(page);
    const requested = page.waitForRequest(request => request.url().endsWith('/api/journal'));
    const refresh = page.locator('#reload').evaluate((button: HTMLButtonElement) => button.onclick?.(new PointerEvent('click')));
    await requested;
    await page.locator('#sources [data-close]').click();
    await createTrip(page, 'Second');
    release();
    await refresh;
    assert.equal(await page.locator('#title').textContent(), 'Second');
    await createTrip(page, 'Third');
    assert.deepEqual(trips.map(trip => trip.title), ['First', 'Second', 'Third']);
  } finally {
    await browser.close();
  }
});

await test('failed sign-in preparation keeps the draft available for backup and sends no save', async () => {
  const browser = await chromium.launch();
  try {
    for (const failure of ['corrupt', 'full'] as const) {
      const page = await browser.newPage();
      let signedIn = false, writes = 0;
      await hostJournal(page, route => {
        if (route.request().method() === 'POST') writes++;
        return route.fulfill(signedIn ? { json: { trips: [], rev: 'r1' } } : { status: 401 });
      });
      await page.goto(origin + '/journal.html?lang=en');
      await createTrip(page, 'Guest trip');
      await page.evaluate(failure => {
        const key = 'hayiti-guest-merge';
        if (failure === 'corrupt') sessionStorage.setItem(key, '{broken');
        else {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (keyToWrite, value) {
            if (keyToWrite === key) throw new DOMException('Storage full', 'QuotaExceededError');
            set.call(this, keyToWrite, value);
          };
        }
      }, failure);
      signedIn = true;
      await refreshJournal(page);
      await page.locator('#status').filter({ hasText: 'No trips were sent this time' }).waitFor();
      assert.match(await page.locator('#status').innerText(), /Back up trip/);
      const downloaded = page.waitForEvent('download');
      await page.locator('#export').click();
      const path = await (await downloaded).path();
      assert.ok(path);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).trip.title, 'Guest trip');
      assert.equal(writes, 0);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('a non-JSON sign-in failure leaves the guest backup available and refresh retries the save', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false, writes = 0;
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: [], rev: '' } });
      if (++writes === 1) return route.fulfill({ status: 503, contentType: 'text/html', body: '<p>Unavailable</p>' });
      assert.equal(route.request().postDataJSON().trips[0].title, 'Guest trip');
      return route.fulfill({ json: { rev: 'r1' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    signedIn = true;
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Guest trip' }).waitFor();
    assert.match(await page.locator('#status').innerText(), /couldn’t confirm the save/);
    const downloaded = page.waitForEvent('download');
    await page.locator('#export').click();
    const backup = await (await downloaded).path();
    assert.ok(backup);
    assert.equal(JSON.parse(await readFile(backup, 'utf8')).trip.title, 'Guest trip');
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 2);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
  } finally {
    await browser.close();
  }
});

await test('a sign-in conflict keeps the guest draft until the traveler chooses Refresh journal', async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    let signedIn = false, writes = 0;
    await hostJournal(page, async route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: [], rev: writes ? 'r2' : 'r1' } });
      if (++writes === 1) {
        await held;
        return route.fulfill({ status: 409 });
      }
      const body = route.request().postDataJSON();
      assert.equal(body.rev, 'r2');
      assert.equal(body.trips[0].title, 'Guest trip');
      return route.fulfill({ json: { rev: 'r3' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    signedIn = true;
    const merging = page.waitForRequest(request => request.method() === 'POST');
    await refreshJournal(page);
    await merging;

    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Another trip');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: /try this edit again/i }).waitFor();
    assert.equal(await page.locator('#tripForm [name=title]').inputValue(), 'Another trip');
    await page.locator('#config [data-close]').click();

    release();
    await page.locator('#status').filter({ hasText: 'Your journal changed during sign-in' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Guest trip');
    assert.equal(writes, 1);
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 2);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
  } finally {
    release();
    await browser.close();
  }
});

await test('an import acknowledged after refresh closes the dialog and reports its counts', async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    let trips = [{ id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-14', stops: [] }];
    let writes = 0;
    await hostJournal(page, async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips, rev: writes ? 'newer' : 'original' } });
      const body = route.request().postDataJSON();
      trips = body.trips;
      if (++writes === 1) {
        await held;
        return route.fulfill({ json: { rev: 'imported' } });
      }
      assert.equal(body.rev, 'newer');
      return route.fulfill({ json: { rev: 'next' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Tel Aviv' }).waitFor();
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({
      name: 'stops.csv', mimeType: 'text/csv', buffer: Buffer.from('date,merchant\n2026-06-14,Cafe')
    });
    const posted = page.waitForRequest(request => request.method() === 'POST');
    await page.locator('#preview button').click();
    await posted;
    await page.locator('[data-tab="connected"]').click();
    await page.locator('#reload').click();
    await page.getByRole('button', { name: 'Cafe', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    release();
    await page.locator('#sources').waitFor({ state: 'hidden', timeout: 4000 });
    assert.match(await page.locator('#status').innerText(), /Added: 1/);
    await createTrip(page, 'Next trip');
    assert.equal(writes, 2);
  } finally {
    release();
    await browser.close();
  }
});

await test('a conflicting edit reads past a stale refresh before reporting the latest version', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let release = () => {};
    const stale = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const writes: string[] = [];
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        writes.push(route.request().postDataJSON().rev);
        return writes.length === 1 ? route.fulfill({ status: 409 }) : route.fulfill({ json: { rev: 'r3' } });
      }
      const read = ++reads;
      if (read === 2) await stale;
      const title = read < 3 ? 'Old title' : 'New title';
      return route.fulfill({ json: { rev: read < 3 ? 'r1' : 'r2', trips: [
        { id: 'trip', title, start: '2026-06-14', end: '2026-06-14', stops: [] }
      ] } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Old title' }).waitFor();
    const requested = page.waitForRequest(request => request.url().endsWith('/api/journal'));
    await refreshJournal(page);
    await requested;
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('My edit');
    const rejected = page.waitForResponse(response => response.status() === 409);
    await page.locator('#tripForm .primary').click();
    await (await rejected).finished();
    release();
    await page.locator('#config .form-error').filter({ hasText: /latest version/i }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'New title');
    assert.deepEqual(writes, ['r1']);
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.deepEqual(writes, ['r1', 'r2']);
  } finally {
    await browser.close();
  }
});

await test('a guest can edit after a lost sign-in reply and refresh the same account trip', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const saves: { id: string; title: string }[][] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: saves.at(-1) ?? [], rev: 'r' + saves.length } });
      saves.push(route.request().postDataJSON().trips);
      return saves.length === 1 ? route.abort() : route.fulfill({ json: { rev: 'r2' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    signedIn = true;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'couldn’t confirm the save' }).waitFor();
    assert.doesNotMatch(await page.locator('#status').innerText(), /delet/i);
    await page.locator('#settings').click();
    await page.locator('#tripForm [name=title]').fill('Edited guest trip');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.reload();
    await page.locator('#status').filter({ hasText: 'now in your journal' }).waitFor();
    assert.deepEqual(saves.map(trips => trips.map(trip => trip.title)), [['Guest trip'], ['Edited guest trip']]);
    assert.equal(saves[0][0].id, saves[1][0].id);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
  } finally {
    await browser.close();
  }
});

await test('an unreadable guest draft is retained until the traveler confirms discarding it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let posts = 0;
    await hostJournal(page, route => {
      if (route.request().method() === 'POST') posts++;
      return route.fulfill({ json: { trips: [], rev: 'r1' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.evaluate(key => sessionStorage.setItem(key, '{broken'), draftKey);
    await page.reload();
    const discard = page.getByRole('button', { name: 'Discard unreadable draft' });
    const newTrip = page.getByRole('button', { name: 'New trip', exact: true });
    await discard.waitFor();
    assert.equal(await page.locator('#status').innerText(),
      'This tab’s guest draft could not be read. Choose Discard unreadable draft to continue.');
    assert.equal(await newTrip.isDisabled(), true);
    assert.equal(await page.locator('#import').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="files"]').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="paste"]').isDisabled(), true);
    await discard.click();
    await page.locator('#confirmNo').click();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), '{broken');
    assert.equal(await newTrip.isDisabled(), true);
    await discard.click();
    await page.locator('#confirmYes').click();
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(await discard.isVisible(), false);
    assert.equal(await newTrip.isEnabled(), true);
    assert.equal(await page.locator('#import').isEnabled(), true);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
    assert.equal(posts, 0);
  } finally {
    await browser.close();
  }
});

await test('a failed first load blocks import until Try again opens the journal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let available = false;
    await hostJournal(page, route => route.fulfill({ status: available ? 401 : 503 }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'Choose Try again' }).waitFor();
    assert.equal(await page.locator('#import').isDisabled(), true);
    assert.equal(await page.locator('#trySample').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="files"]').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="paste"]').isDisabled(), true);
    available = true;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.locator('#retryLoad').waitFor({ state: 'hidden' });
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
        format: 'hayiti/1', trip: { id: 'recovered', title: 'Recovered trip', start: '2026-06-14', end: '2026-06-14', stops: [] }
      }))
    });
    await page.getByRole('button', { name: 'Load trip' }).click();
    await page.locator('#title').filter({ hasText: 'Recovered trip' }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('a backup exceeding actual guest storage is rejected in the preview', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, route => route.fulfill({ status: 401 }));
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Small trip');
    const previous = await page.evaluate(key => sessionStorage.getItem(key), draftKey);
    const photo = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(280000);
    const date = '2026-06-14';
    const stops = Array.from({ length: 24 }, (_, i) => ({ id: 'p' + i, name: 'Visit ' + i, date, photos: [photo] }));
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({ name: 'photos.json', mimeType: 'application/json', buffer: Buffer.from(
      JSON.stringify({ format: 'hayiti/1', trip: { id: 'photos', title: 'Photo trip', start: date, end: date, stops } })
    ) });
    await page.locator('#preview').filter({ hasText: 'This tab cannot store the imported backup' }).waitFor();
    assert.equal(await page.locator('#preview button').count(), 0);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), previous);
  } finally {
    await browser.close();
  }
});

await test('a places CSV uses Name for stops when the traveler chooses the date order', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, route => route.fulfill({ status: 401 }));
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'June day', '2026-06-05');
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({ name: 'places.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Date,Name,Description\n06/05/2026,Beach,Afternoon swim') });
    const preview = page.locator('#preview');
    await preview.getByRole('button', { name: 'Month / day / year' }).click();
    await preview.locator('button').click();
    await page.getByRole('button', { name: 'Beach', exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('double-clicking Save in trip settings submits once without an alert', async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    const titles: string[] = [], alerts: string[] = [];
    page.on('dialog', dialog => { alerts.push(dialog.message()); void dialog.dismiss(); });
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        titles.push(route.request().postDataJSON().trips[0].title);
        await held;
        return route.fulfill({ json: { rev: 'r2' } });
      }
      return route.fulfill({ json: { rev: 'r1', trips: [
        { id: 'ta', title: 'My trip', start: '2026-06-14', end: '2026-06-14', stops: [] }
      ] } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    await page.locator('#settings').click();
    await page.locator('#tripForm [name=title]').fill('Tel Aviv');
    await page.locator('#tripForm .primary').dblclick();
    release();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#title').textContent(), 'Tel Aviv');
    assert.deepEqual(titles, ['Tel Aviv']);
    assert.deepEqual(alerts, []);
    assert.equal(await page.locator('.form-error').count(), 0);
  } finally {
    release();
    await browser.close();
  }
});

const guestAPI = (route: Route) => route.fulfill({ status: 401, json: { error: 'Authentication required' } });

await test('a phone-width journal with two trips keeps every control on screen', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Lisbon with a deliberately long trip name that wraps');
    await createTrip(page, 'Porto');
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.equal(fits, true);
    for (const id of ['#trips', '#settings', '#newTrip', '#add']) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, id + ' is on screen');
    }
  } finally {
    await browser.close();
  }
});

await test('leaving a tab-only journal asks first until the trip is backed up', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    const asksBeforeLeaving = () => page.evaluate(() => {
      const leaving = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    });
    assert.equal(await asksBeforeLeaving(), false);
    await createTrip(page, 'Guest trip');
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

await test('an end date before the start date is explained inside trip settings', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Backwards');
    await page.locator('#tripForm [name=end]').fill('2026-05-03');
    await page.locator('#tripForm [name=start]').evaluate((input: HTMLInputElement) => { input.value = '2026-05-12'; });
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: 'The end date cannot be before the start date.' }).waitFor();
    assert.equal(await page.locator('#config').getAttribute('open'), '');
    assert.deepEqual(dialogs, []);
  } finally {
    await browser.close();
  }
});

await test('stops saved elsewhere appear when the traveler returns to the tab', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const trip = { id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-14', stops: [] as unknown[] };
    let rev = 'r1';
    await hostJournal(page, route => route.fulfill({ json: { trips: [trip], rev } }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(await page.locator('#stops .stopname').count(), 0);

    trip.stops = [{ id: 'a', date: '2026-06-14', name: 'Added in ChatGPT', xy: [32.07, 34.78] }];
    rev = 'r2';
    const read = page.waitForResponse(response => response.url().endsWith('/api/journal'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await read;
    await page.getByRole('button', { name: 'Added in ChatGPT', exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});
