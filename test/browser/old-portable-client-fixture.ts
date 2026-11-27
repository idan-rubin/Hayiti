export interface OldPortableClient {
  read(): Promise<{ trips: { id: string; title: string }[] }>;
  rename(title: string): void;
  save(): Promise<void>;
  forceLocalQuota(): void;
}

// The pre-bookmark protocol uses only its historical allowlist and storage addresses.
export const oldPortableClientHTML = `<!doctype html><html><head><title>Historical portable client</title></head><body><script>
const key = 'masluli-portable-v2';
const marker = 'hayiti:indexeddb:1';
let cache;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const cleanStop = value => pick(value, ['id','name','date','address','time','xy','notes','band','sources','refs','kind','count','rank','slot','photos','approx']);
const cleanTrip = value => ({ ...pick(value, ['id','title','start','end','home','homeXY','rules','edges','dayNotes','checks']), stops: value.stops.map(cleanStop) });
const database = () => new Promise((resolve, reject) => {
  const open = indexedDB.open('hayiti-portable', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('journal');
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});
async function readOldDatabase() {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('journal').objectStore('journal').get('current');
    request.onsuccess = () => typeof request.result === 'string' ? resolve(request.result) : reject(Error('Journal unavailable'));
    request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
async function writeOldDatabase(serialized) {
  const db = await database();
  try { await new Promise((resolve, reject) => {
    const transaction = db.transaction('journal', 'readwrite');
    transaction.objectStore('journal').put(serialized, 'current');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  }); } finally { db.close(); }
}
window.oldPortableClient = {
  async read() {
    let raw = localStorage.getItem(key);
    if (raw === marker) raw = await readOldDatabase();
    const value = raw ? JSON.parse(raw) : { trips: [] };
    cache = { trips: value.trips.map(cleanTrip) };
    return cache;
  },
  rename(title) { cache.trips[0].title = title; },
  async save() {
    const serialized = JSON.stringify(cache);
    const migrated = localStorage.getItem(key) === marker;
    if (!migrated) {
      try { localStorage.setItem(key, serialized); return; }
      catch (error) { if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error; }
    }
    await writeOldDatabase(serialized);
    if (!migrated) localStorage.setItem(key, marker);
  },
  forceLocalQuota() {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Storage full', 'QuotaExceededError');
      return set.call(this, name, value);
    };
  }
};
</script></body></html>`;
