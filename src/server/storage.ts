import { cleanTrip, isRecord, journalCharacterLimit, type Journal } from '../domain/core.ts';
export interface ObjectInfo {
  key: string;
  etag: string;
  customMetadata?: Record<string, string>;
}
export interface StoredObject extends ObjectInfo {
  text(): Promise<string>;
}
export interface WriteOptions {
  onlyIf?: {
    etagMatches: string;
  } | {
    etagDoesNotMatch: '*';
  };
  customMetadata?: Record<string, string>;
}
export interface Bucket {
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectInfo | null>;
  put(key: string, body: string, options?: WriteOptions): Promise<ObjectInfo | null>;
  list(options: {
    prefix: string;
    include: ['customMetadata'];
    cursor?: string;
  }): Promise<{
    objects: ObjectInfo[];
    truncated: boolean;
    cursor?: string;
  }>;
}
export interface Bindings {
  BUCKET: Bucket;
  PUBLISHER_ORIGIN: string;
  RELAY_ORIGIN?: string;
  HAYITI_SHARE_RELAY?: string;
}
const journalKey = (owner: string) => 'journal/' + encodeURIComponent(owner);
export async function loadState(bucket: Bucket, owner: string): Promise<Journal> {
  const object = await bucket.get(journalKey(owner));
  if (!object) return {
    trips: [],
    rev: ''
  };
  const stored: unknown = JSON.parse(await object.text());
  if (!isRecord(stored) || !Array.isArray(stored.trips)) throw Error('Invalid journal');
  return {
    trips: stored.trips.map(cleanTrip),
    rev: object.etag
  };
}
export async function storeState(bucket: Bucket, owner: string, trips: unknown, rev: unknown): Promise<string> {
  if (typeof rev !== 'string' || !Array.isArray(trips) || trips.length > 60) throw Error('Invalid journal');
  const clean = trips.map(cleanTrip);
  if (new Set(clean.map(t => t.id)).size !== clean.length) throw Error('טיול כפול');
  const body = JSON.stringify({
    trips: clean
  });
  if (body.length > journalCharacterLimit) throw Error('היומן גדול מדי');
  const object = await bucket.put(journalKey(owner), body, {
    onlyIf: rev ? {
      etagMatches: rev
    } : {
      etagDoesNotMatch: '*'
    }
  });
  if (!object) throw Error('CONFLICT');
  return object.etag;
}
