import type { Page } from 'playwright-core';
import type { Trip } from '../../src/domain/core.ts';

export interface GuestRecord {
  schemaVersion: number;
  version: string;
  trips: Trip[];
  attempts?: unknown;
  importedTabs?: string[];
}

export interface LegacyGuestSources {
  local: string | null;
  tab: string | null;
  localAttempts: string | null;
  tabAttempts: string | null;
}

/** Seed the old client once; a reload must not manufacture another write from an old tab. */
export async function seedLegacyGuestOnce(page: Page, sources: Partial<LegacyGuestSources>): Promise<void> {
  await page.addInitScript(sources => {
    const marker = 'test-legacy-guest-seeded';
    if (sessionStorage.getItem(marker) === 'yes') return;
    sessionStorage.setItem(marker, 'yes');
    for (const [storage, values] of [
      [localStorage, [sources.local, sources.localAttempts]],
      [sessionStorage, [sources.tab, sources.tabAttempts]]
    ] as const) {
      for (const [index, value] of values.entries()) {
        if (typeof value === 'string') storage.setItem(index ? 'hayiti-guest-merge' : 'hayiti-unsigned-journal', value);
      }
    }
  }, sources);
}

export function readLegacyGuestSources(page: Page): Promise<LegacyGuestSources> {
  return page.evaluate(() => ({
    local: localStorage.getItem('hayiti-unsigned-journal'),
    tab: sessionStorage.getItem('hayiti-unsigned-journal'),
    localAttempts: localStorage.getItem('hayiti-guest-merge'),
    tabAttempts: sessionStorage.getItem('hayiti-guest-merge')
  }));
}

/** Simulate an old client writing after a migration commits and before its source cleanup runs. */
export async function replaceLegacyGuestAfterCommit(page: Page, sources: Required<LegacyGuestSources>): Promise<void> {
  await page.addInitScript(next => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
    if (sessionStorage.getItem('test-cleanup-race-ran') === 'yes') return;
    const put = IDBObjectStore.prototype.put;
    let scheduled = false;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (!scheduled && this.transaction.db.name === 'hayiti-guest') {
        scheduled = true;
        this.transaction.addEventListener('complete', () => {
          sessionStorage.setItem('test-cleanup-race-ran', 'yes');
          for (const [storage, values] of [
            [localStorage, [next.local, next.localAttempts]],
            [sessionStorage, [next.tab, next.tabAttempts]]
          ] as const) {
            for (const [index, value] of values.entries()) {
              const key = index ? 'hayiti-guest-merge' : 'hayiti-unsigned-journal';
              if (value === null) storage.removeItem(key);
              else storage.setItem(key, value);
            }
          }
        }, { once: true, capture: true });
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  }, sources);
}

export function readGuestRecord(page: Page): Promise<GuestRecord | null> {
  return page.evaluate(() => new Promise<GuestRecord | null>((resolve, reject) => {
    const open = indexedDB.open('hayiti-guest', 1);
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

export async function guestTitles(page: Page): Promise<string[]> {
  return (await readGuestRecord(page))?.trips.map(trip => trip.title).sort() ?? [];
}

export function patchGuestRecord(page: Page, patch: Record<string, unknown>): Promise<void> {
  return page.evaluate(patch => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('hayiti-guest', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('journal', 'readwrite');
      const store = transaction.objectStore('journal');
      const request = store.get('current');
      request.onsuccess = () => store.put({ ...request.result, ...patch, version: crypto.randomUUID() }, 'current');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), patch);
}

export function refuseGuestWrites(page: Page): Promise<void> {
  return page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.transaction.db.name === 'hayiti-guest') throw new DOMException('Storage full', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
}
