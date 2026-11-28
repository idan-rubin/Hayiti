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

// Serves the built hosted journal with one signed-in trip.
async function hostTrip(page: Page, trip: object) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/api/')) return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } });
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
