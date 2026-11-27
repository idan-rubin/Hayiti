import { cleanTrip, isRecord, type Trip } from '../domain/core.ts';
import { JournalSchemaError, journalSchemaVersion, requireJournalSchema } from '../domain/journal-schema.ts';

export const guestKey = 'hayiti-unsigned-journal';
export const legacyGuestMarker = '{"hayitiUpgradeRequired":true}';
export const temporaryGuestKey = 'hayiti-guest-tab-v1';
const attemptsKey = 'hayiti-guest-merge';
const changeKey = 'hayiti-guest-updated';
const channelName = 'hayiti-guest';
let unreadableTarget: { canonical?: string; local?: string; tab?: string; temporary?: string } | undefined;
let temporaryRecord: LoadedGuestRecord | undefined;
let temporaryPersisted = false;
let temporaryStorageUnavailable = false;

export interface GuestDraft {
  version: string;
  trips: Trip[];
}
export interface GuestRecord extends GuestDraft {
  schemaVersion: typeof journalSchemaVersion;
  attempts: unknown;
  importedTabs: string[];
}
export type LoadedGuestDraft = GuestDraft & { persistence?: 'tab' | 'memory' };
type LoadedGuestRecord = GuestRecord & { persistence?: 'tab' | 'memory' };
export class UnreadableDraft extends Error {
  constructor() { super('לא ניתן לקרוא את טיוטת הטיול בדפדפן הזה.'); }
}
export class GuestConflict extends Error {
  readonly draft: LoadedGuestDraft;
  constructor(draft: LoadedGuestDraft) {
    super('The saved draft changed in another tab.');
    this.draft = draft;
  }
}
class GuestStorageUnavailable extends Error {}

export function guestPersistence(): 'shared' | 'tab' | 'memory' {
  return temporaryRecord?.persistence ?? 'shared';
}

function emptyRecord(): GuestRecord {
  return { schemaVersion: journalSchemaVersion, version: crypto.randomUUID(), trips: [], attempts: [], importedTabs: [] };
}

function readTemporary(): LoadedGuestRecord | undefined {
  if (temporaryRecord) return temporaryRecord;
  let raw: string | null;
  try { raw = sessionStorage.getItem(temporaryGuestKey); }
  catch { temporaryStorageUnavailable = true; return; }
  if (raw === null) return;
  try {
    const record = recordOf(JSON.parse(raw));
    temporaryRecord = { ...record, persistence: 'tab' };
    temporaryPersisted = true;
    return temporaryRecord;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof UnreadableDraft) {
      unreadableTarget = { temporary: raw };
      throw new UnreadableDraft();
    }
    throw error;
  }
}

function storeTemporary(record: LoadedGuestRecord) {
  if (temporaryRecord?.persistence === 'memory' || temporaryStorageUnavailable) {
    record.persistence = 'memory';
    temporaryRecord = record;
    return;
  }
  record.persistence = 'tab';
  try {
    const stored = { ...record };
    delete stored.persistence;
    if (record.trips.length) sessionStorage.setItem(temporaryGuestKey, JSON.stringify(stored));
    else sessionStorage.removeItem(temporaryGuestKey);
    temporaryPersisted = record.trips.length > 0;
  } catch (error) {
    // An existing copy must not reappear after a supposedly successful edit or deletion.
    if (temporaryPersisted) throw error;
    record.persistence = 'memory';
  }
  temporaryRecord = record;
}

function updateTemporary<T>(operation: (record: GuestRecord) => { result: T; write?: boolean }): T {
  const record = structuredClone(temporaryRecord ?? emptyRecord());
  const next = operation(record);
  if (next.write || !temporaryRecord) storeTemporary(record);
  return next.result;
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
    let settled = false;
    const unavailable = () => {
      settled = true;
      reject(new GuestStorageUnavailable('Saved drafts could not be opened. A separate temporary trip is available in this tab.'));
    };
    if (typeof indexedDB === 'undefined') {
      unavailable();
      return;
    }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open('hayiti-guest', 1); }
    catch { unavailable(); return; }
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onerror = () => {
      if (request.error?.name === 'VersionError') { settled = true; reject(new JournalSchemaError()); }
      else unavailable();
    };
    request.onblocked = unavailable;
    request.onsuccess = () => {
      if (settled) request.result.close();
      else { settled = true; resolve(request.result); }
    };
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
  if (raw === null || raw === legacyGuestMarker) return source;
  let value: unknown;
  let trips: Trip[];
  try {
    value = JSON.parse(raw);
    requireJournalSchema(isRecord(value) ? value.schemaVersion : undefined, true);
    trips = parseTrips(value);
  } catch (error) {
    if (error instanceof JournalSchemaError) throw error;
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
    if (source.raw === null || source.raw === legacyGuestMarker) continue;
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
  if (source.raw === null || source.raw === legacyGuestMarker) return;
  try {
    if (source.storage.getItem(guestKey) === source.raw && source.storage.getItem(attemptsKey) === source.attemptsRaw) {
      // Old open tabs reject this non-data marker and keep their visible trip instead of adopting an empty list.
      if (source.kind === 'local') source.storage.setItem(guestKey, legacyGuestMarker);
      else source.storage.removeItem(guestKey);
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
  if (temporaryRecord) return updateTemporary(operation);
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

export async function readGuestRecord(): Promise<LoadedGuestRecord> {
  const isolated = readTemporary();
  if (isolated) return structuredClone(isolated);
  try { return await updateGuest(record => ({ result: record })); }
  catch (error) {
    if (!(error instanceof GuestStorageUnavailable)) throw error;
    // An unavailable store permits a separate draft; readable damaged or newer data still needs recovery.
    for (const kind of ['local', 'tab'] as const) {
      try { await legacySource(kind, kind === 'local' ? localStorage : sessionStorage); }
      catch (legacyError) {
        if (legacyError instanceof UnreadableDraft || legacyError instanceof JournalSchemaError) throw legacyError;
      }
    }
    storeTemporary(emptyRecord());
    return structuredClone(temporaryRecord!);
  }
}
export async function readGuest(): Promise<LoadedGuestDraft> {
  const { version, trips, persistence } = await readGuestRecord();
  return { version, trips, ...(persistence ? { persistence } : {}) };
}
export async function discardUnreadableGuest() {
  const target = unreadableTarget;
  if (!target) throw Error('The draft changed. Reload it before discarding.');
  if (target.temporary !== undefined) {
    if (sessionStorage.getItem(temporaryGuestKey) === target.temporary) sessionStorage.removeItem(temporaryGuestKey);
    temporaryRecord = undefined;
    temporaryPersisted = false;
    unreadableTarget = undefined;
    return;
  }
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
