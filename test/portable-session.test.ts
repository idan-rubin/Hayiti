import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { JournalSchemaError } from '../src/domain/journal-schema.ts';
import { JournalSession } from '../src/web/journal-session.ts';
import { journalStorage } from '../src/web/journal-storage.ts';
import { PortableConflict, PortableRecordMissing } from '../src/web/portable-storage.ts';

const trip = () => cleanTrip({
  id: 'trip', title: 'Weekend', start: '2026-06-14', end: '2026-06-15',
  googlePins: [{ id: 'bookmark', name: 'Saved place', xy: [51.9, 4.4] }],
  stops: [{ id: 'purchase', name: 'Purchase', date: '2026-06-14', kind: 'uncertain', reviewReason: 'Branch not yet confirmed' }]
});

await test('a future portable format never becomes an empty writable journal or replaces the last usable view', async () => {
  const saved = trip();
  let future = false;
  const session = new JournalSession({ ...journalStorage,
    readPortable: async () => {
      if (future) throw new JournalSchemaError();
      return { version: 'current', trips: structuredClone([saved]) };
    },
    writePortable: async () => { throw new JournalSchemaError(); }
  });
  await session.load(true, title => title, async () => true);
  session.select(session.trip, saved.end);
  future = true;
  await assert.rejects(session.load(true, title => title, async () => true), JournalSchemaError);
  assert.equal(session.mode, 'portable');
  assert.equal(session.day, saved.end);
  assert.deepEqual(session.trip, saved);
  await assert.rejects(session.change(() => { session.trip!.title = 'Unsaved edit'; }), JournalSchemaError);
  assert.deepEqual(session.trip, saved);
});

await test('a portable conflict adopts every saved field before the traveler retries their edit', async () => {
  const saved = trip();
  const newer = { ...saved, title: 'Edited in the newer file' };
  const revisions: string[] = [];
  const session = new JournalSession({ ...journalStorage,
    readPortable: async () => ({ version: 'old-read', trips: structuredClone([saved]) }),
    writePortable: async (trips, revision) => {
      revisions.push(revision);
      if (revision === 'old-read') throw new PortableConflict({ version: 'new-read', trips: [newer] });
      return { version: 'saved', trips };
    }
  });
  await session.load(true, title => title, async () => true);
  assert.equal(await session.change(() => { session.trip!.title = 'Retry this edit'; }), 'conflict');
  assert.deepEqual(session.trip, newer);
  assert.equal(session.trip?.googlePins?.[0].id, 'bookmark');
  assert.equal(session.trip?.stops[0].reviewReason, 'Branch not yet confirmed');
  assert.equal(await session.change(() => { session.trip!.title = 'Approved retry'; }), 'saved');
  assert.deepEqual(revisions, ['old-read', 'new-read']);
  assert.match(session.revision, /^saved\//);
});

await test('a portable file without storage keeps changes only in its tab and never calls a persistence writer', async () => {
  let writes = 0;
  const session = new JournalSession({ ...journalStorage,
    readPortable: async () => null,
    writePortable: async () => { writes++; throw Error('No persistent storage'); }
  });
  await session.load(true, title => title, async () => true);
  assert.equal(session.mode, 'memory');
  assert.equal(await session.change(() => { session.trips.push(trip()); }), 'saved');
  await session.load(true, title => title, async () => true);
  assert.equal(session.trip?.title, 'Weekend');
  assert.equal(session.mode, 'memory');
  assert.equal(writes, 0);
});

await test('a missing stored record leaves open trips available for backup and recovery', async () => {
  const saved = trip();
  let missing = false;
  let release!: () => void;
  const commit = new Promise<void>(resolve => { release = resolve; });
  const session = new JournalSession({ ...journalStorage,
    readPortable: async () => {
      if (missing) throw new PortableRecordMissing();
      return { version: 'old', trips: [saved] };
    },
    recoverPortable: async trips => {
      await commit;
      return { version: 'restored', trips };
    }
  });
  const load = () => session.load(true, title => title, async () => true);
  await load();
  missing = true;
  assert.equal((await load()).kind, 'portable-missing');
  assert.deepEqual(session.trip, saved);
  const recovery = session.change(() => { session.trip!.title = 'Recovered trip'; });
  assert.equal((await load()).kind, 'unchanged');
  release();
  assert.equal(await recovery, 'saved');
  assert.equal(session.mode, 'portable');
  assert.match(session.revision, /^restored\//);
  assert.equal(session.trip?.title, 'Recovered trip');
});
