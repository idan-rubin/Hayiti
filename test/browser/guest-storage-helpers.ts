import type { Page } from 'playwright-core';
import type { Trip } from '../../src/domain/core.ts';

export interface GuestRecord {
  schemaVersion: number;
  version: string;
  trips: Trip[];
  attempts?: unknown;
  importedTabs?: string[];
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
