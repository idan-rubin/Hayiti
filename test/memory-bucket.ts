import type { Bucket, StoredObject, WriteOptions } from '../src/server/storage.ts';

/** The conditional put mirrors R2's compare-and-swap behavior used by journal and link writes. */
export class MemoryBucket implements Bucket {
  private items = new Map<string, StoredObject>();
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
  async head(key: string) {
    return this.get(key);
  }
  async put(key: string, value: string, options: WriteOptions = {}) {
    const previous = this.items.get(key),
      condition = options.onlyIf;
    if (condition && ('etagMatches' in condition ? previous?.etag !== condition.etagMatches : !!previous)) return null;
    const item = {
      key,
      etag: crypto.randomUUID(),
      customMetadata: options.customMetadata,
      text: async () => value
    };
    this.items.set(key, item);
    return item;
  }
  async list({
    prefix
  }: {
    prefix: string;
  }) {
    return {
      objects: [...this.items.values()].filter(item => item.key.startsWith(prefix)),
      truncated: false
    };
  }
}
