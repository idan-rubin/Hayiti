import type { Page } from 'playwright-core';
import type { Trip } from '../../src/domain/core.ts';

export interface PortableRecord {
  schemaVersion: number;
  version: string;
  trips: Trip[];
  imported: string[];
}

export function readPortableRecord(page: Page): Promise<PortableRecord | null> {
  return page.evaluate(() => new Promise<PortableRecord | null>((resolve, reject) => {
    const open = indexedDB.open('hayiti-portable', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('journal');
      const request = transaction.objectStore('journal').get('current-v3');
      transaction.oncomplete = () => { database.close(); resolve(request.result ?? null); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

export function patchPortableRecord(page: Page, patch: Record<string, unknown>): Promise<void> {
  return page.evaluate(patch => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('hayiti-portable', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('journal', 'readwrite');
      const store = transaction.objectStore('journal');
      const request = store.get('current-v3');
      request.onsuccess = () => store.put({ ...request.result, ...patch, version: crypto.randomUUID() }, 'current-v3');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), patch);
}

export function waitForPortableTrip(page: Page, expected: { googlePinCount?: number; removedPinId?: string; edgeCount?: number }): Promise<unknown> {
  return page.waitForFunction(expected => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('hayiti-portable', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('journal');
      const request = transaction.objectStore('journal').get('current-v3');
      transaction.oncomplete = () => {
        database.close();
        const trip = (request.result as PortableRecord | undefined)?.trips[0];
        resolve(!!trip && (expected.googlePinCount === undefined || (trip.googlePins?.length ?? 0) === expected.googlePinCount)
          && (expected.removedPinId === undefined || trip.removedGooglePinIds?.includes(expected.removedPinId) === true)
          && (expected.edgeCount === undefined || trip.edges.length === expected.edgeCount));
      };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), expected);
}
