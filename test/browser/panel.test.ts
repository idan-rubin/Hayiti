import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { journalSchemaVersion } from '../../src/domain/journal-schema.ts';
import { restSheet } from './journal-controls.ts';

// An https origin keeps the page a secure context, as the hosted journal is.
const origin = 'https://hayiti.test';
const types: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', ico: 'image/x-icon', json: 'application/json'
};

// Serves the built hosted journal with one signed-in trip, or to a guest when there is none.
async function hostTrip(page: Page, trip: object | null) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/api/')) {
      return trip ? route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }) : route.fulfill({ status: 401 });
    }
    try {
      const body = await readFile(new URL('../../dist/web' + pathname, import.meta.url));
      await route.fulfill({ body, contentType: types[pathname.split('.').at(-1) ?? ''] ?? 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto(origin + '/journal.html?lang=en');
}

await test('a long day note scrolls with the stops and leaves them within reach on a short screen', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 }, hasTouch: true });
    const date = '2026-06-14';
    const note = 'Walked the long way round the harbor. '.repeat(20).slice(0, 700);
    await hostTrip(page, {
      id: 'note', title: 'Harbor day', start: date, end: date,
      stops: [{ id: 'a', name: 'Market', date, xy: [51.92, 4.48] }, { id: 'b', name: 'Museum', date, xy: [51.925, 4.47] }],
      dayNotes: { [date]: note }
    });
    await page.locator('.listbody #dayNote').filter({ hasText: 'Walked the long way' }).waitFor();
    await restSheet(page, 'full');
    const stop = page.locator('#stops .stopname').last();
    await stop.scrollIntoViewIfNeeded();
    const list = await page.locator('.listbody').boundingBox();
    const row = await stop.boundingBox();
    assert.ok(list && row);
    // The note is taller than the list, and the last stop still shows inside it.
    assert.ok((await page.locator('#dayNote').boundingBox())!.height > list.height);
    assert.ok(row.y >= list.y - 1 && row.y + row.height <= list.y + list.height + 1);
  } finally {
    await browser.close();
  }
});

await test('a popup bound before the window turned sideways opens clear of the panel', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, {
      id: 'turn', title: 'Turning trip', start: date, end: date,
      stops: [
        { id: 'west', name: 'West gate of the old harbor market', date, time: '09:00', xy: [51.92, 4.4] },
        { id: 'middle', name: 'Bridge', date, time: '11:00', xy: [51.92, 4.45] },
        { id: 'east', name: 'East pier', date, time: '13:00', xy: [51.92, 4.5] }
      ]
    });
    await page.locator('.leaflet-marker-icon').nth(2).waitFor();
    // Turned sideways, the window is wide enough for the panel to sit beside the route.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.getElementById('panel')!.getBoundingClientRect().width === 400);
    await page.locator('.leaflet-marker-icon[title^="West gate"]').click();
    await page.locator('.leaflet-popup').filter({ hasText: 'West gate' }).waitFor();
    await page.waitForFunction(() => {
      const popup = document.querySelector('.leaflet-popup-content-wrapper')!.getBoundingClientRect();
      return popup.left >= document.getElementById('panel')!.getBoundingClientRect().right;
    });
  } finally {
    await browser.close();
  }
});

await test('the arrow keys move the sheet through three heights, the route stays above it and a full sheet takes the map out of reach', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const date = '2026-06-15';
    await hostTrip(page, {
      id: 'sheet', title: 'North to south', start: '2026-06-14', end: date,
      stops: [
        { id: 'arrival', name: 'Station', date: '2026-06-14', xy: [51.93, 4.48] },
        { id: 'north', name: 'North park', date, time: '09:00', xy: [51.96, 4.48] },
        { id: 'middle', name: 'Bridge', date, time: '11:00', xy: [51.93, 4.48] },
        { id: 'south', name: 'South pier', date, time: '13:00', xy: [51.9, 4.48] }
      ]
    });
    await page.locator('#tripDate').selectOption('2026-06-14');
    await page.locator('.leaflet-marker-icon').waitFor();
    const handle = page.locator('#sheetHandle');
    const map = page.locator('.mapcard');
    // The sheet has stopped moving and every pin shows above it.
    const routeClear = () => page.waitForFunction(() => {
      const sheet = document.getElementById('panel')!.getBoundingClientRect();
      const settled = Math.abs(sheet.height - parseFloat(document.documentElement.style.getPropertyValue('--sheet'))) < 1;
      return settled && [...document.querySelectorAll('.leaflet-marker-icon')].every(pin => pin.getBoundingClientRect().bottom <= sheet.top);
    });
    const rests = async (key: string, stop: string) => {
      await handle.press(key);
      assert.equal(await page.locator('body').getAttribute('data-sheet'), stop);
    };
    await rests('ArrowDown', 'peek');
    await rests('ArrowDown', 'peek');
    // Choosing a day fits its route to the tall strip of map the lowered sheet leaves.
    await page.locator(`#dayStrip [data-day="${date}"]`).click();
    await page.locator('.leaflet-marker-icon').nth(2).waitFor();
    await routeClear();
    // Raised again, the sheet would cover the southern stops if the route kept that fit.
    await rests('ArrowUp', 'half');
    await routeClear();
    assert.equal(await map.evaluate(element => (element as HTMLElement).inert), false);
    await rests('ArrowUp', 'full');
    assert.equal(await map.evaluate(element => (element as HTMLElement).inert), true);
    await rests('ArrowUp', 'full');
    await rests('ArrowDown', 'half');
    assert.equal(await map.evaluate(element => (element as HTMLElement).inert), false);
    // Beside the route on a wide screen, the panel covers nothing that has to leave the tab order.
    await rests('ArrowUp', 'full');
    await page.setViewportSize({ width: 1200, height: 844 });
    await page.waitForFunction(() => !(document.querySelector('.mapcard') as HTMLElement).inert);
  } finally {
    await browser.close();
  }
});

await test('a day with only a Google Pin or a note is marked in the day strip and gains no stop count', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await hostTrip(page, {
      id: 'dots', title: 'Four days', start: '2026-06-14', end: '2026-06-17',
      stops: [{ id: 'a', name: 'Market', date: '2026-06-14', xy: [51.92, 4.48] }],
      googlePins: [{ id: 'park', name: 'Saved park', date: '2026-06-15', xy: [51.925, 4.47] }],
      dayNotes: { '2026-06-16': 'A slow day by the river.' }
    });
    const strip = page.locator('#dayStrip');
    await strip.locator('button').nth(3).waitFor();
    assert.deepEqual(await strip.locator('[data-recorded]').evaluateAll(days => days.map(day => (day as HTMLElement).dataset.day)),
      ['2026-06-14', '2026-06-15', '2026-06-16']);
    // Only the day with a stop carries a count in the list of dates.
    assert.deepEqual(await page.locator('#tripDate option').evaluateAll(options => options.map(option => option.textContent.includes('·'))),
      [true, false, false, false]);
    assert.match(await strip.locator('[data-day="2026-06-15"]').getAttribute('aria-label') ?? '', /Google Pin/);
    assert.match(await strip.locator('[data-day="2026-06-16"]').getAttribute('aria-label') ?? '', /Note/);
    assert.doesNotMatch(await strip.locator('[data-day="2026-06-17"]').getAttribute('aria-label') ?? '', /Google Pin|Note/);
  } finally {
    await browser.close();
  }
});

await test('a phone held sideways shows the panel beside the map, with the route clear of it and every stop within reach', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 }, hasTouch: true });
    const date = '2026-06-14';
    const names = ['North park', 'Old mill', 'Bridge', 'Market hall', 'Museum', 'South pier'];
    await hostTrip(page, {
      id: 'side', title: 'Sideways', start: date, end: date,
      stops: names.map((name, index) => ({ id: 'stop' + index, name, date, time: `${String(9 + index).padStart(2, '0')}:00`, xy: [51.94 - index * .004, 4.48 - index * .002] }))
    });
    await page.locator('.leaflet-marker-icon').nth(5).waitFor();
    for (const lang of ['en', 'he']) {
      await page.locator('#languageSwitch').selectOption(lang);
      // No sheet: the panel is a column on the side where reading starts, narrower than half the window.
      assert.equal(await page.locator('#sheetHandle').isVisible(), false);
      const panel = (await page.locator('#panel').boundingBox())!;
      assert.ok(panel.width <= 667 / 2 && panel.height > 375 / 2, `${lang}: the panel is a column`);
      assert.ok(lang === 'he' ? panel.x + panel.width > 667 - 16 : panel.x < 16, `${lang}: the panel sits where reading starts`);
      // The whole route is drawn on the part of the map beside it, under the bar.
      await page.waitForFunction(() => {
        const column = document.getElementById('panel')!.getBoundingClientRect();
        const bar = document.querySelector('header nav')!.getBoundingClientRect();
        return [...document.querySelectorAll('.leaflet-marker-icon')].every(pin => {
          const box = pin.getBoundingClientRect();
          const beside = document.documentElement.dir === 'rtl' ? box.right <= column.left && box.left >= 0 : box.left >= column.right && box.right <= innerWidth;
          return beside && box.top >= bar.bottom && box.bottom <= innerHeight;
        });
      });
      // With so little height the legend is put away, and the map style shares the bar's row without touching it.
      assert.equal(await page.locator('.legend').isVisible(), false);
      const style = (await page.locator('#mapStyle').boundingBox())!;
      const bar = await page.locator('.brand, header nav > *').evaluateAll(parts => parts.filter(part => part.checkVisibility()).map(part => {
        const { left, right, top, bottom } = part.getBoundingClientRect();
        return { left, right, top, bottom };
      }));
      assert.ok(bar.length >= 4);
      for (const part of bar) {
        assert.ok(style.y < part.bottom && part.top < style.y + style.height, `${lang}: the map style is in the bar's row`);
        assert.ok(style.x >= part.right || style.x + style.width <= part.left, `${lang}: the map style is clear of the bar`);
      }
      // The panel scrolls as a whole: the last stop comes into view above the day's actions, which stay at its foot.
      const last = page.locator('#stops .stopname').last();
      await last.scrollIntoViewIfNeeded();
      const row = (await last.boundingBox())!;
      const actions = (await page.locator('.toolbar').boundingBox())!;
      assert.ok(Math.abs(actions.y + actions.height - (panel.y + panel.height)) <= 2, `${lang}: the actions stay at the foot of the panel`);
      assert.ok(row.y >= panel.y && row.y + row.height <= actions.y + 1, `${lang}: the last stop shows above the actions`);
      // Choosing a pin brings its row into that same clear part of the panel.
      await page.locator('#panel').evaluate(element => { element.scrollTop = 0; });
      await page.locator(`.leaflet-marker-icon[title^="South pier"]`).click();
      await page.waitForFunction(() => {
        const chosen = document.querySelector('.activeStop')?.getBoundingClientRect();
        const column = document.getElementById('panel')!.getBoundingClientRect();
        const foot = document.querySelector('.toolbar')!.getBoundingClientRect();
        return !!chosen && chosen.top >= column.top - 1 && chosen.bottom <= foot.top + 1;
      });
    }
  } finally {
    await browser.close();
  }
});

await test('the buttons of the bar never cover the map style, at any width or in either language', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // A guest's bar is the widest: it adds the sign-in button.
    await hostTrip(page, null);
    await page.locator('#login').waitFor();
    for (const lang of ['en', 'he']) {
      await page.locator('#languageSwitch').selectOption(lang);
      assert.equal(await page.locator('header nav > *').evaluateAll(parts => parts.filter(part => part.checkVisibility()).length), 4);
      for (const height of [800, 390]) {
        for (const width of [560, 667, 821, 844, 900, 932, 1000, 1001, 1100, 1280]) {
          await page.setViewportSize({ width, height });
          const style = (await page.locator('#mapStyle').boundingBox())!;
          const parts = await page.locator('.brand, header nav > *').evaluateAll(elements => elements.filter(element => element.checkVisibility()).map(element => {
            const { left, right, top, bottom } = element.getBoundingClientRect();
            return { id: element.id || element.className, left, right, top, bottom };
          }));
          for (const part of parts) {
            const apart = style.x >= part.right || style.x + style.width <= part.left || style.y >= part.bottom || style.y + style.height <= part.top;
            assert.ok(apart, `${lang} ${width}x${height}: the map style is clear of ${part.id}`);
          }
          assert.ok(style.x >= 0 && style.x + style.width <= width, `${lang} ${width}x${height}: the map style is on screen`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});

await test('tabbing past the days of a lowered sheet raises it, so focus is never out of sight', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, {
      id: 'tab', title: 'Tabbing', start: date, end: date,
      stops: [{ id: 'a', name: 'Market', date, xy: [51.92, 4.48] }, { id: 'b', name: 'Museum', date, xy: [51.925, 4.47] }]
    });
    await page.locator('.leaflet-marker-icon').nth(1).waitFor();
    await page.locator('#sheetHandle').press('ArrowDown');
    assert.equal(await page.locator('body').getAttribute('data-sheet'), 'peek');
    // The days still show in the lowered sheet, and reaching them leaves it lowered.
    await page.locator('#tripDate').focus();
    assert.equal(await page.locator('body').getAttribute('data-sheet'), 'peek');
    await page.keyboard.press('Tab');
    await page.locator('body[data-sheet="half"]').waitFor();
    await page.waitForFunction(() => {
      const focused = document.activeElement!.getBoundingClientRect();
      return document.activeElement !== document.body && focused.height > 0 && focused.top >= 0 && focused.bottom <= innerHeight;
    });
    assert.equal(await page.evaluate(() => document.getElementById('panel')!.contains(document.activeElement)), true);
  } finally {
    await browser.close();
  }
});
