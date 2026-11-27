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

function accessGuestRecord(page: Page, patch?: Record<string, unknown>): Promise<GuestRecord | null> {
  return page.evaluate(patch => new Promise<GuestRecord | null>((resolve, reject) => {
    let database: IDBDatabase | undefined, transaction: IDBTransaction | undefined;
    let settled = false, initialized = false, blocked = false;
    let phase = 'opening database', recordState = 'not read';
    let result: GuestRecord | null = null;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        try { transaction?.abort(); } catch {}
      }
      database?.close();
      if (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reject(Error((patch === undefined ? 'Read' : 'Patch') + ' guest IndexedDB failed during ' + phase
          + ' (initialized=' + initialized + ', blocked=' + blocked + ', record=' + recordState + '): ' + reason));
      } else resolve(result);
    };
    const timeout = setTimeout(() => finish(Error('Timed out after 10 seconds')), 10000);
    let open: IDBOpenDBRequest;
    try { open = indexedDB.open('hayiti-guest', 1); }
    catch (error) { finish(error); return; }
    open.onupgradeneeded = () => {
      database = open.result;
      phase = 'unexpected database initialization';
      // Only the app may initialize its database. Do not conceal a failed migration in the helper.
      open.transaction?.abort();
      finish(Error('The app has not initialized its guest database'));
    };
    open.onerror = () => finish(open.error ?? Error('Database open failed'));
    open.onblocked = () => {
      blocked = true;
      finish(Error('Database open was blocked by another connection'));
    };
    open.onsuccess = () => {
      database = open.result;
      if (settled) { database.close(); return; }
      initialized = database.objectStoreNames.contains('journal');
      phase = 'starting transaction';
      try {
        transaction = database.transaction('journal', patch === undefined ? 'readonly' : 'readwrite');
        transaction.oncomplete = () => finish();
        transaction.onabort = () => finish(transaction?.error ?? Error('Transaction aborted'));
        const store = transaction.objectStore('journal');
        const request = store.get('current');
        phase = 'reading canonical record';
        request.onerror = () => finish(request.error ?? Error('Record read failed'));
        request.onsuccess = () => {
          recordState = request.result === undefined ? 'missing' : 'present';
          result = request.result ?? null;
          if (patch === undefined) return;
          phase = 'patching canonical record';
          try {
            if (request.result === undefined) throw Error('The app has not saved a canonical guest record');
            const write = store.put({ ...request.result, ...patch, version: crypto.randomUUID() }, 'current');
            write.onerror = () => finish(write.error ?? Error('Record patch failed'));
          } catch (error) { finish(error); }
        };
      } catch (error) { finish(error); }
    };
  }), patch);
}

export function readGuestRecord(page: Page): Promise<GuestRecord | null> {
  return accessGuestRecord(page);
}

export async function guestTitles(page: Page): Promise<string[]> {
  return (await readGuestRecord(page))?.trips.map(trip => trip.title).sort() ?? [];
}

export async function patchGuestRecord(page: Page, patch: Record<string, unknown>): Promise<void> {
  await accessGuestRecord(page, patch);
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
