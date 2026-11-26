const journalKey = 'masluli-portable-v2';
const databaseMarker = 'hayiti:indexeddb:1';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('hayiti-portable', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readPortable(): Promise<string | null> {
  const saved = localStorage.getItem(journalKey);
  if (saved !== databaseMarker) return saved;
  const database = await openDatabase();
  try {
    return await new Promise<string>((resolve, reject) => {
      const request = database.transaction('journal').objectStore('journal').get('current');
      request.onsuccess = () => {
        if (typeof request.result === 'string') resolve(request.result);
        else reject(new Error('Journal unavailable'));
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function writePortable(serialized: string): Promise<void> {
  const migrated = localStorage.getItem(journalKey) === databaseMarker;
  if (!migrated) {
    try {
      localStorage.setItem(journalKey, serialized);
      return;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
    }
  }
  // Commit the full journal before replacing the original copy with a pointer.
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('journal', 'readwrite');
      transaction.objectStore('journal').put(serialized, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    if (!migrated) localStorage.setItem(journalKey, databaseMarker);
  } finally {
    database.close();
  }
}
