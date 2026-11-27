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
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(Error('Saved drafts are unavailable in this browser. Enable browser storage and try again, or sign in to use your account journal.'));
      return;
    }
    const request = indexedDB.open('hayiti-guest', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onerror = () => reject(request.error ?? Error('Draft storage unavailable'));
    request.onblocked = () => reject(Error('Draft storage is blocked by another tab. Reload the other tabs and try again.'));
    request.onsuccess = () => resolve(request.result);
  });
}

interface LegacySource {
  kind: 'local' | 'tab';
  storage: Storage;
  raw: string | null;
  attemptsRaw: string | null;
  snapshot: string;
  previousReceipt: string;
  trips: Array<{ trip: Trip; receipt: string }>;
  attempts: unknown;
}
class MigrationChanged extends Error {}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function legacySource(kind: LegacySource['kind'], storage: Storage): Promise<LegacySource> {
  const raw = storage.getItem(guestKey), attemptsRaw = storage.getItem(attemptsKey);
  const source: LegacySource = { kind, storage, raw, attemptsRaw, snapshot: '', previousReceipt: '', trips: [], attempts: [] };
  if (raw === null) return source;
  let value: unknown;
  let trips: Trip[];
  try {
    value = JSON.parse(raw);
    trips = parseTrips(value);
  } catch (error) {
    unreadableTarget = kind === 'local' ? { local: raw } : { tab: raw };
    throw error instanceof UnreadableDraft ? error : new UnreadableDraft();
  }
  const originals = (value as { trips: unknown[] }).trips;
  source.trips = await Promise.all(trips.map(async (trip, index) => {
    const original = originals[index];
    const stableIds = isRecord(original) && typeof original.id === 'string' && original.id.trim()
      && (!Array.isArray(original.stops) || original.stops.every((stop: unknown) => isRecord(stop) && typeof stop.id === 'string' && stop.id.trim()));
    return { trip, receipt: 'trip:' + await digest(JSON.stringify(stableIds ? trip : original)) };
  }));
  source.previousReceipt = await digest(raw);
  source.snapshot = kind + ':' + await digest(JSON.stringify([raw, attemptsRaw]));
  if (attemptsRaw !== null) {
    try { source.attempts = JSON.parse(attemptsRaw); }
    catch { source.attempts = attemptsRaw; }
  }
  return source;
}
function mergeLegacyAttempts(record: GuestRecord, incoming: unknown) {
  if (Array.isArray(record.attempts) && Array.isArray(incoming)) {
    const seen = new Set(record.attempts.map(item => JSON.stringify(item)));
    record.attempts.push(...incoming.filter(item => !seen.has(JSON.stringify(item))));
  } else if (Array.isArray(incoming) && !incoming.length) return;
  else if (Array.isArray(record.attempts) && !record.attempts.length) record.attempts = incoming;
  else if (JSON.stringify(record.attempts) !== JSON.stringify(incoming)) record.attempts = { canonical: record.attempts, legacy: incoming };
}
function migrateSources(record: GuestRecord, sources: LegacySource[]) {
  const receipts = new Set(record.importedTabs);
  let changed = false;
  for (const source of sources) {
    if (source.raw === null) continue;
    const snapshotImported = receipts.has(source.snapshot);
    const imported = snapshotImported || receipts.has(source.previousReceipt);
    for (const { trip, receipt } of source.trips) {
      if (receipts.has(receipt)) continue;
      if (!imported) {
        const same = record.trips.find(other => other.id === trip.id);
        if (!same) record.trips.push(trip);
        else if (JSON.stringify(same) !== JSON.stringify(trip)) {
          const id = 'legacy-' + receipt.slice('trip:'.length);
          if (!record.trips.some(other => other.id === id)) record.trips.push({ ...trip, id });
        }
      }
      receipts.add(receipt);
      changed = true;
    }
    if (!snapshotImported) mergeLegacyAttempts(record, source.attempts);
    if (!snapshotImported) {
      receipts.add(source.snapshot);
      changed = true;
    }
  }
  if (changed) {
    record.importedTabs = [...receipts];
    record.version = crypto.randomUUID();
  }
  return changed;
}
function clearMigratedSource(source: LegacySource) {
  if (source.raw === null) return;
  try {
    if (source.storage.getItem(guestKey) === source.raw && source.storage.getItem(attemptsKey) === source.attemptsRaw) {
      source.storage.removeItem(guestKey);
      source.storage.removeItem(attemptsKey);
    }
  } catch {}
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
  const database = await openDatabase();
  try {
    for (let retry = 0; retry < 3; retry++) {
      const sources = await Promise.all([legacySource('local', localStorage), legacySource('tab', sessionStorage)]);
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
              const record: GuestRecord = request.result === undefined
                ? { schemaVersion: journalSchemaVersion, version: crypto.randomUUID(), trips: [], attempts: [], importedTabs: [] }
                : recordOf(request.result);
              // Hashing runs before the transaction; recheck its source before applying any operation.
              for (const source of sources) {
                if (source.storage.getItem(guestKey) !== source.raw || source.storage.getItem(attemptsKey) !== source.attemptsRaw) throw new MigrationChanged();
              }
              const migrated = migrateSources(record, sources);
              const next = operation(record);
              answer = next.result;
              if (request.result === undefined || migrated || next.write) {
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
        for (const source of sources) clearMigratedSource(source);
        if (committedVersion) notifyChange(committedVersion);
        return result;
      } catch (error) {
        if (!(error instanceof MigrationChanged)) throw error;
      }
    }
    throw Error('The draft changed in another tab while it was being migrated. Reload and try again.');
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
            const fresh: GuestRecord = { schemaVersion: journalSchemaVersion, version: crypto.randomUUID(), trips: [], attempts: [], importedTabs: [] };
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
