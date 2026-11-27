import { cleanTrip, isRecord, type Trip } from '../domain/core.ts';
import { journalSchemaVersion, JournalSchemaError, requireJournalSchema } from '../domain/journal-schema.ts';

const legacyKey = 'masluli-portable-v2';
const legacyDatabaseMarker = 'hayiti:indexeddb:1';
const legacyRecordKey = 'current';
const currentRecordKey = 'current-v3';
const upgradeMarker = JSON.stringify({ hayitiUpgradeRequired: true });

export interface PortableDraft {
  version: string;
  trips: Trip[];
}
export interface PortableRecord extends PortableDraft {
  schemaVersion: typeof journalSchemaVersion;
  imported: string[];
}
export interface LoadedPortableDraft extends PortableDraft {
  recoveredTripIds?: ReadonlySet<string>;
}
export class PortableStorageUnavailable extends Error {
  constructor() { super('Browser storage is unavailable. Keep this file open and download a backup to keep your changes.'); }
}
export class PortableRecordMissing extends Error {}
export class PortableConflict extends Error {
  readonly draft: LoadedPortableDraft;
  constructor(draft: LoadedPortableDraft) {
    super('The portable journal changed. Reload its latest version before saving again.');
    this.draft = draft;
  }
}
class MigrationChanged extends Error {}

function unavailable(error: unknown): Error {
  return error instanceof DOMException && error.name === 'VersionError' ? new JournalSchemaError() : new PortableStorageUnavailable();
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new PortableStorageUnavailable()); return; }
    let failed = false;
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open('hayiti-portable', 1); }
    catch (error) { reject(unavailable(error)); return; }
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onerror = () => reject(unavailable(request.error));
    request.onblocked = () => { failed = true; reject(new PortableStorageUnavailable()); };
    request.onsuccess = () => {
      if (failed) request.result.close();
      else resolve(request.result);
    };
  });
}
function readLegacyDatabase(database: IDBDatabase): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('journal');
    const request = transaction.objectStore('journal').get(legacyRecordKey);
    transaction.oncomplete = () => {
      if (request.result === undefined) resolve(null);
      else if (typeof request.result === 'string') resolve(request.result);
      else reject(new JournalSchemaError());
    };
    transaction.onabort = () => reject(transaction.error ?? new PortableStorageUnavailable());
  });
}
function cleanTrips(value: unknown, legacy: boolean): Trip[] {
  requireJournalSchema(isRecord(value) ? value.schemaVersion : undefined, legacy);
  if (!isRecord(value) || !Array.isArray(value.trips)) throw Error('This portable journal could not be read. Keep the original file and try its backup.');
  return value.trips.map(cleanTrip);
}
function currentRecord(value: unknown): PortableRecord {
  const trips = cleanTrips(value, false);
  if (!isRecord(value) || typeof value.version !== 'string' || !value.version || !Array.isArray(value.imported)
    || !value.imported.every((receipt: unknown) => typeof receipt === 'string')) throw new JournalSchemaError();
  return { schemaVersion: journalSchemaVersion, version: value.version, imported: value.imported, trips };
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
interface LegacySnapshot {
  raw: string;
  receipt: string;
  trips: Array<{ trip: Trip; receipt: string }>;
}
async function snapshot(raw: string, source: string): Promise<LegacySnapshot> {
  const value: unknown = JSON.parse(raw);
  const trips = cleanTrips(value, true);
  const originals = (value as { trips: unknown[] }).trips;
  const records = await Promise.all(trips.map(async (trip, index) => {
    const original = originals[index];
    const stableIds = isRecord(original) && typeof original.id === 'string' && original.id.trim()
      && (!Array.isArray(original.stops) || original.stops.every((stop: unknown) => isRecord(stop) && typeof stop.id === 'string' && stop.id.trim()));
    return { trip, receipt: 'trip:' + await digest(JSON.stringify(stableIds ? trip : original)) };
  }));
  return { raw, receipt: source + ':' + await digest(raw), trips: records };
}
function isUpgradeMarker(raw: string | null) {
  return raw === upgradeMarker;
}
function migrate(record: PortableRecord, sources: LegacySnapshot[]) {
  const receipts = new Set(record.imported);
  let changed = false;
  for (const source of sources) {
    for (const { trip, receipt } of source.trips) {
      if (receipts.has(receipt)) continue;
      const same = record.trips.find(other => other.id === trip.id);
      if (!same) record.trips.push(trip);
      else if (JSON.stringify(same) !== JSON.stringify(trip)) {
        const id = 'legacy-' + receipt.slice('trip:'.length);
        if (!record.trips.some(other => other.id === id)) record.trips.push({ ...trip, id });
      }
      receipts.add(receipt);
      changed = true;
    }
    if (!receipts.has(source.receipt)) {
      receipts.add(source.receipt);
      changed = true;
    }
  }
  if (changed) {
    record.imported = [...receipts];
    record.version = crypto.randomUUID();
  }
  return changed;
}
function blockLegacyReader(expected: string | null) {
  try {
    if (localStorage.getItem(legacyKey) === expected) localStorage.setItem(legacyKey, upgradeMarker);
  } catch {}
}

// Old files know only the legacy key and record. Their writes are imports, never canonical saves.
async function updatePortable<T>(operation: (record: PortableRecord) => { result: T; write?: boolean }, recovery?: Trip[]): Promise<T> {
  const database = await openDatabase();
  try {
    for (let retry = 0; retry < 3; retry++) {
      let localRaw: string | null;
      try { localRaw = localStorage.getItem(legacyKey); }
      catch { throw new PortableStorageUnavailable(); }
      const databaseRaw = await readLegacyDatabase(database);
      const sources = await Promise.all([
        ...(localRaw !== null && localRaw !== legacyDatabaseMarker && !isUpgradeMarker(localRaw) ? [snapshot(localRaw, 'local')] : []),
        ...(databaseRaw !== null ? [snapshot(databaseRaw, 'database')] : [])
      ]);
      try {
        const result = await new Promise<T>((resolve, reject) => {
          const transaction = database.transaction('journal', 'readwrite');
          const store = transaction.objectStore('journal');
          const request = store.get(currentRecordKey);
          let result: T;
          let failure: unknown;
          request.onsuccess = () => {
            const old = store.get(legacyRecordKey);
            old.onsuccess = () => {
              try {
                const record: PortableRecord = request.result === undefined
                  ? { schemaVersion: journalSchemaVersion, version: crypto.randomUUID(), trips: [], imported: [] }
                  : currentRecord(request.result);
                if (localStorage.getItem(legacyKey) !== localRaw || (old.result ?? null) !== databaseRaw) throw new MigrationChanged();
                const missing = request.result === undefined && (isUpgradeMarker(localRaw) || (localRaw === legacyDatabaseMarker && databaseRaw === null));
                if (missing && !recovery) throw new PortableRecordMissing();
                if (recovery) {
                  if (!missing) {
                    if (request.result === undefined) throw new PortableRecordMissing();
                    throw new PortableConflict(portableDraft(record));
                  }
                  record.trips = recovery.map(cleanTrip);
                }
                const migrated = migrate(record, sources);
                const next = operation(record);
                result = next.result;
                if (request.result === undefined || migrated || next.write) store.put(record, currentRecordKey);
                if (databaseRaw !== null) store.delete(legacyRecordKey);
              } catch (error) {
                failure = error;
                transaction.abort();
              }
            };
          };
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = () => reject(failure ?? transaction.error ?? new PortableStorageUnavailable());
        });
        blockLegacyReader(localRaw);
        return result;
      } catch (error) {
        if (!(error instanceof MigrationChanged)) throw error;
      }
    }
    throw Error('An older file changed the portable journal during migration. Reload and try again.');
  } finally { database.close(); }
}

function portableDraft(record: PortableRecord): LoadedPortableDraft {
  const receipts = new Set(record.imported);
  const recoveredTripIds = new Set(record.trips.flatMap(({ id }) =>
    id.startsWith('legacy-') && receipts.has('trip:' + id.slice('legacy-'.length)) ? [id] : []));
  return { version: record.version, trips: record.trips, recoveredTripIds };
}

export function readPortable(): Promise<LoadedPortableDraft> {
  return updatePortable(record => ({ result: portableDraft(record) }));
}
export async function writePortable(trips: Trip[], expectedVersion: string): Promise<LoadedPortableDraft> {
  const result = await updatePortable(record => {
    if (record.version !== expectedVersion) return { result: { conflict: true, draft: portableDraft(record) } };
    record.trips = trips.map(cleanTrip);
    record.version = crypto.randomUUID();
    return { write: true, result: { conflict: false, draft: portableDraft(record) } };
  });
  if (result.conflict) throw new PortableConflict(result.draft);
  return result.draft;
}

export function recoverPortable(trips: Trip[]) {
  if (!trips.length) throw Error('Choose a trip to recover.');
  return updatePortable(record => ({ result: portableDraft(record) }), trips);
}
