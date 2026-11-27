import { cleanTrip, isRecord, type Trip } from '../domain/core.ts';
import { journalSchemaVersion, requireJournalSchema } from '../domain/journal-schema.ts';

export const guestKey = 'hayiti-unsigned-journal';
const attemptsKey = 'hayiti-guest-merge';
const changeKey = 'hayiti-guest-updated';
const channelName = 'hayiti-guest';
let unreadableTarget: { canonical?: string; local?: string; tab?: string } | undefined;

export interface GuestDraft {
  version: string;
  trips: Trip[];
}
export interface GuestRecord extends GuestDraft {
  schemaVersion: typeof journalSchemaVersion;
  attempts: unknown;
  importedTabs: string[];
}
export class UnreadableDraft extends Error {
  constructor() { super('לא ניתן לקרוא את טיוטת הטיול בדפדפן הזה.'); }
}
export class GuestConflict extends Error {
  readonly draft: GuestDraft;
  constructor(draft: GuestDraft) {
    super('The saved draft changed in another tab.');
    this.draft = draft;
  }
}

function parseTrips(value: unknown): Trip[] {
  if (!isRecord(value) || !Array.isArray(value.trips)) throw new UnreadableDraft();
  try { return value.trips.map(cleanTrip); }
  catch { throw new UnreadableDraft(); }
}
function legacyTrips(raw: string): Trip[] {
  try { return parseTrips(JSON.parse(raw)); }
  catch { throw new UnreadableDraft(); }
}
function recordOf(value: unknown): GuestRecord {
  requireJournalSchema(isRecord(value) ? value.schemaVersion : undefined);
  if (!isRecord(value) || typeof value.version !== 'string' || !value.version || !Array.isArray(value.importedTabs)
    || !value.importedTabs.every((item: unknown) => typeof item === 'string')) {
    unreadableTarget = { canonical: JSON.stringify(value) };
    throw new UnreadableDraft();
  }
  try {
    return { schemaVersion: journalSchemaVersion, version: value.version, trips: parseTrips(value), attempts: value.attempts, importedTabs: value.importedTabs };
  } catch (error) {
    unreadableTarget = { canonical: JSON.stringify(value) };
    throw error;
  }
}
function legacyRecord(): GuestRecord {
  const raw = localStorage.getItem(guestKey);
  const attempts = localStorage.getItem(attemptsKey);
  let parsed: unknown = [];
  if (attempts !== null) {
    try { parsed = JSON.parse(attempts); }
    catch { parsed = attempts; }
  }
  let trips: Trip[] = [];
  if (raw !== null) {
    try { trips = legacyTrips(raw); }
    catch (error) {
      unreadableTarget = { local: raw };
      throw error;
    }
  }
  return { schemaVersion: journalSchemaVersion, version: crypto.randomUUID(), trips, attempts: parsed, importedTabs: [] };
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('hayiti-guest', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onerror = () => reject(request.error ?? Error('Draft storage unavailable'));
    request.onblocked = () => reject(Error('Draft storage is blocked by another tab. Reload the other tabs and try again.'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function tabMigration() {
  const raw = sessionStorage.getItem(guestKey);
  if (raw === null) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const attempts = sessionStorage.getItem(attemptsKey);
  let parsed: unknown = [];
  if (attempts !== null) {
    try { parsed = JSON.parse(attempts); }
    catch { parsed = attempts; }
  }
  return { raw, id, attempts: parsed };
}
function notifyChange(version: string) {
  try {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(version);
    channel.close();
  } catch {}
  try { localStorage.setItem(changeKey, version); } catch {}
}

// The version check and write share one IndexedDB transaction, even without Web Locks or storage events.
export async function updateGuest<T>(operation: (record: GuestRecord) => { result: T; write?: boolean }): Promise<T> {
  const migration = await tabMigration();
  const database = await openDatabase();
  let committedVersion: string | undefined;
  try {
    const result = await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('journal', 'readwrite');
      const store = transaction.objectStore('journal');
      const request = store.get('current');
      let answer: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const record = request.result === undefined ? legacyRecord() : recordOf(request.result);
          let migrated = request.result === undefined;
          if (migration && !record.importedTabs.includes(migration.id)) {
            let trips: Trip[];
            try { trips = legacyTrips(migration.raw); }
            catch (error) {
              unreadableTarget = { tab: migration.raw };
              throw error;
            }
            for (const [index, trip] of trips.entries()) {
              const same = record.trips.find(other => other.id === trip.id);
              if (!same) record.trips.push(trip);
              else if (JSON.stringify(same) !== JSON.stringify(trip)) {
                record.trips.push({ ...trip, id: 'legacy-' + migration.id + '-' + index });
              }
            }
            if (Array.isArray(record.attempts) && Array.isArray(migration.attempts)) {
              const seen = new Set(record.attempts.map(item => JSON.stringify(item)));
              record.attempts.push(...migration.attempts.filter(item => !seen.has(JSON.stringify(item))));
            } else if (Array.isArray(record.attempts) && !record.attempts.length) record.attempts = migration.attempts;
            record.importedTabs.push(migration.id);
            record.version = crypto.randomUUID();
            migrated = true;
          }
          const next = operation(record);
          answer = next.result;
          if (migrated || next.write) {
            store.put(record, 'current');
            committedVersion = record.version;
          }
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(answer);
      transaction.onabort = () => reject(failure ?? transaction.error ?? Error('Draft storage unavailable'));
    });
    if (migration) {
      try {
        if (sessionStorage.getItem(guestKey) === migration.raw) {
          sessionStorage.removeItem(guestKey);
          sessionStorage.removeItem(attemptsKey);
        }
      } catch {}
    }
    if (committedVersion) notifyChange(committedVersion);
    return result;
  } finally {
    database.close();
  }
}

export function readGuestRecord(): Promise<GuestRecord> {
  return updateGuest(record => ({ result: record }));
}
export async function readGuest(): Promise<GuestDraft> {
  const { version, trips } = await readGuestRecord();
  return { version, trips };
}
export async function discardUnreadableGuest() {
  const target = unreadableTarget;
  if (!target) throw Error('The draft changed. Reload it before discarding.');
  const database = await openDatabase();
  let version: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('journal', 'readwrite');
      const store = transaction.objectStore('journal');
      const request = store.get('current');
      let failure: unknown;
      request.onsuccess = () => {
        try {
          if (request.result !== undefined) {
            requireJournalSchema(isRecord(request.result) ? request.result.schemaVersion : undefined);
            if (target.canonical !== JSON.stringify(request.result)) return;
          } else if (target.canonical !== undefined) return;
          if (request.result === undefined || target.canonical !== undefined) {
            const empty: GuestRecord = { schemaVersion: journalSchemaVersion, version: crypto.randomUUID(), trips: [], attempts: [], importedTabs: [] };
            const fresh = request.result !== undefined || (target.local !== undefined && localStorage.getItem(guestKey) === target.local)
              ? empty : legacyRecord();
            version = fresh.version;
            store.put(fresh, 'current');
          }
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? Error('Draft storage unavailable'));
    });
    if (target.local !== undefined && localStorage.getItem(guestKey) === target.local) localStorage.removeItem(guestKey);
    if (target.tab !== undefined && sessionStorage.getItem(guestKey) === target.tab) sessionStorage.removeItem(guestKey);
    unreadableTarget = undefined;
    if (version) notifyChange(version);
  } finally { database.close(); }
}
export function onGuestChange(changed: () => void): () => void {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(channelName);
    channel.onmessage = changed;
  } catch {}
  const storage = (event: StorageEvent) => {
    if (event.key === changeKey) changed();
  };
  window.addEventListener('storage', storage);
  return () => {
    channel?.close();
    window.removeEventListener('storage', storage);
  };
}
