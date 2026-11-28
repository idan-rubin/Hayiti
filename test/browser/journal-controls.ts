import type { Page } from 'playwright-core';

/** Back up trip and Sign out sit in the menu at the end of the bar. */
export async function openMenu(page: Page) {
  await page.locator('#menuButton').click();
  await page.locator('#menu').waitFor();
}

/** Whole trip is a row of the menu. While the whole trip shows, the same row leads back to the day. */
export async function toggleWholeTrip(page: Page) {
  await openMenu(page);
  await page.locator('#wholeTrip').click();
}

export async function backUpTrip(page: Page) {
  await openMenu(page);
  await page.locator('#export').click();
}

/** On a phone the list is a sheet over the map. The handle raises it over the map and lowers it again. */
export async function restSheet(page: Page, stop: 'half' | 'full') {
  if (await page.locator('body').getAttribute('data-sheet') !== stop) await page.locator('#sheetHandle').click();
  await page.locator(`body[data-sheet="${stop}"]`).waitFor();
}
