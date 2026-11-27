import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { readGuest, readGuestRecord } from '../src/web/guest-storage.ts';
import { prepareGuestMerge, writeGuest } from '../src/web/guest-draft.ts';

await test('missing browser storage permits an isolated memory draft without replacing a saved legacy journal', async () => {
  const keys = ['indexedDB', 'localStorage', 'sessionStorage'] as const;
  const original = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const legacy = JSON.stringify({ trips: [{ id: 'old', title: 'Saved legacy trip', start: '2026-06-14', end: '2026-06-14', stops: [] }] });
  let writes = 0;
  Object.defineProperties(globalThis, {
    indexedDB: { configurable: true, value: undefined },
    localStorage: { configurable: true, value: {
      getItem: (key: string) => key === 'hayiti-unsigned-journal' ? legacy : null,
      setItem: () => { writes++; }, removeItem: () => { writes++; }
    } },
    sessionStorage: { configurable: true, get: () => { throw new DOMException('Storage blocked', 'SecurityError'); } }
  });
  try {
    const draft = await readGuest();
    assert.equal(draft.persistence, 'memory');
    assert.deepEqual(draft.trips, []);
    const trip = cleanTrip({ id: 'temporary', title: 'Temporary trip', start: '2026-06-14', end: '2026-06-14', stops: [] });
    await writeGuest([trip], draft.version);
    assert.deepEqual((await readGuest()).trips, [trip]);
    const account: typeof trip[] = [];
    await prepareGuestMerge(account, [trip], title => title);
    assert.deepEqual(account, [trip]);
    assert.ok(Array.isArray((await readGuestRecord()).attempts));
    assert.equal(writes, 0);
    assert.equal(localStorage.getItem('hayiti-unsigned-journal'), legacy);
  } finally {
    for (const [index, key] of keys.entries()) {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
