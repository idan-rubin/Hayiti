import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanStop, cleanTrip } from '../src/domain/core.ts';
import { journalSchemaVersion } from '../src/domain/journal-schema.ts';
import { JournalSession } from '../src/web/journal-session.ts';
import { journalStorage } from '../src/web/journal-storage.ts';
import { GuestConflict } from '../src/web/guest-storage.ts';
import type { GuestDraft } from '../src/web/guest-storage.ts';

await test('malformed account replies preserve the selected trip, day, and last usable revision', async t => {
  const trip = cleanTrip({ id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-15', stops: [] });
  const session = new JournalSession({ ...journalStorage,
    readGuest: async () => ({ version: 'guest-1', trips: [] }),
    writeGuest: async trips => ({ version: 'guest-2', trips })
  });
  let readReply: unknown = { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' };
  let saveReply: unknown = {};
  const revisions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (init.method !== 'POST') return Response.json(readReply);
    revisions.push(JSON.parse(String(init.body)).rev);
    return Response.json(saveReply);
  });

  await session.load(false, title => title, async () => true);
  session.select(session.trip, trip.end);
  readReply = { schemaVersion: journalSchemaVersion, trips: [] };
  await assert.rejects(session.load(false, title => title, async () => true));
  assert.equal(session.trip?.id, trip.id);

  await assert.rejects(session.change(() => { session.trips[0].title = 'First edit'; }));
  assert.equal(session.trip?.title, trip.title);
  assert.equal(session.day, trip.end);

  saveReply = { rev: 'r2' };
  assert.equal(await session.change(() => { session.trips[0].title = 'Second edit'; }), 'saved');
  assert.equal(await session.change(() => { session.trips[0].home = 'Hotel'; }), 'saved');
  assert.deepEqual(revisions, ['r1', 'r1', 'r2']);
});

await test('competing guest edits adopt the authoritative draft before a retry and never replace another trip', async () => {
  const trip = cleanTrip({ id: 'original', title: 'Original', start: '2026-06-14', end: '2026-06-15', stops: [] });
  let saved: GuestDraft = { version: 'initial', trips: [trip] };
  const storage = { ...journalStorage,
    readAccount: async () => null,
    readGuest: async () => structuredClone(saved),
    writeGuest: async (trips: typeof trip[], expected: string) => {
      if (expected !== saved.version) throw new GuestConflict(structuredClone(saved));
      saved = { version: crypto.randomUUID(), trips: structuredClone(trips) };
      return structuredClone(saved);
    }
  };
  const sessions = [new JournalSession(storage), new JournalSession(storage)];
  await Promise.all(sessions.map(session => session.load(false, title => title, async () => true)));
  const append = (session: JournalSession, id: string) => () => { session.trips.push({ ...trip, id, title: id }); };
  const results = await Promise.all(sessions.map((session, index) => session.change(append(session, 'trip-' + index))));
  assert.deepEqual([...results].sort(), ['conflict', 'saved']);
  const rejected = results.indexOf('conflict');
  assert.equal(await sessions[rejected].change(append(sessions[rejected], 'trip-' + rejected)), 'saved');
  assert.deepEqual(saved.trips.map(item => item.id).sort(), ['original', 'trip-0', 'trip-1']);
});

await test('a late guest notification cannot restore a snapshot from before a completed save', async () => {
  const trip = cleanTrip({ id: 'trip', title: 'Before', start: '2026-06-14', end: '2026-06-15', stops: [] });
  let saved: GuestDraft = { version: 'initial', trips: [trip] };
  let defer = false;
  let answer: ((draft: GuestDraft) => void) | undefined;
  const session = new JournalSession({ ...journalStorage,
    readAccount: async () => null,
    readGuest: async () => defer ? new Promise<GuestDraft>(resolve => { answer = resolve; }) : structuredClone(saved),
    writeGuest: async trips => {
      saved = { version: 'saved', trips: structuredClone(trips) };
      return structuredClone(saved);
    }
  });
  await session.load(false, title => title, async () => true);
  const stale = structuredClone(saved);
  defer = true;
  const adoption = session.adoptGuestDraft();
  assert.equal(await session.change(() => { session.trips[0].title = 'After'; }), 'saved');
  assert.ok(answer);
  answer(stale);
  assert.equal(await adoption, false);
  assert.equal(session.trip?.title, 'After');
});

await test('a rejected guest write keeps the saved trip and selected day visible and reports failure', async () => {
  const trip = cleanTrip({ id: 'trip', title: 'Saved', start: '2026-06-14', end: '2026-06-15', stops: [] });
  const session = new JournalSession({ ...journalStorage,
    readAccount: async () => null,
    readGuest: async () => ({ version: 'initial', trips: structuredClone([trip]) }),
    writeGuest: async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }
  });
  await session.load(false, title => title, async () => true);
  session.select(session.trip, trip.end);
  assert.equal(await session.change(() => { session.trips[0].title = 'Unsaved'; }), 'storage-error');
  assert.equal(session.trip?.title, 'Saved');
  assert.equal(session.day, trip.end);
});

await test('unavailable guest storage never turns a signed-out session into a writable empty draft', async () => {
  let writes = 0;
  const session = new JournalSession({ ...journalStorage,
    readAccount: async () => null,
    readGuest: async () => { throw Error('Draft storage unavailable'); },
    writeGuest: async () => { writes++; throw Error('Unexpected save'); }
  });
  assert.equal((await session.load(false, title => title, async () => true)).kind, 'guest-unavailable');
  assert.equal(await session.change(() => {}), 'loading');
  assert.equal(writes, 0);
});

await test('an account save completed during a guest read is not replaced by the earlier account snapshot', async () => {
  const trip = cleanTrip({ id: 'trip', title: 'Before', start: '2026-06-14', end: '2026-06-15', stops: [] });
  let remote = { rev: 'r1', trips: [trip] };
  let reads = 0;
  let answer: ((draft: GuestDraft) => void) | undefined;
  const session = new JournalSession({ ...journalStorage,
    readAccount: async () => structuredClone(remote),
    readGuest: async () => {
      reads++;
      return reads === 1 ? { version: 'guest', trips: [] }
        : new Promise<GuestDraft>(resolve => { answer = resolve; });
    },
    writeAccount: async journal => { remote = { trips: structuredClone(journal.trips), rev: 'r2' }; return 'r2'; }
  });
  await session.load(false, title => title, async () => true);
  const reload = session.load(false, title => title, async () => true);
  await Promise.resolve();
  assert.ok(answer);
  assert.equal(await session.change(() => { session.trips[0].title = 'After'; }), 'saved');
  answer({ version: 'guest', trips: [] });
  assert.equal((await reload).kind, 'unchanged');
  assert.equal(session.trip?.title, 'After');
  assert.match(session.revision, /^r2\//);
});

await test('an expired account followed by a failed draft read clears account data and blocks edits', async () => {
  const trip = cleanTrip({ id: 'private', title: 'Private account', start: '2026-06-14', end: '2026-06-15', stops: [] });
  let expired = false;
  const session = new JournalSession({ ...journalStorage,
    readAccount: async () => expired ? null : { rev: 'r1', trips: [trip] },
    readGuest: async () => {
      if (expired) throw Error('Draft storage unavailable');
      return { version: 'guest', trips: [] };
    }
  });
  await session.load(false, title => title, async () => true);
  expired = true;
  assert.equal((await session.load(false, title => title, async () => true)).kind, 'guest-unavailable');
  assert.deepEqual(session.trips, []);
  assert.equal(session.trip, null);
  assert.equal(await session.change(() => {}), 'loading');
});

await test('refresh adopts a newer server revision while an import acknowledgment is still pending', async () => {
  const trip = cleanTrip({ id: 'trip', title: 'Day out', start: '2026-06-14', end: '2026-06-14', stops: [] });
  let remote = { rev: 'original', trips: [trip] };
  let writes = 0;
  let posted = () => {}, release = () => {};
  const request = new Promise<void>(resolve => { posted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const session = new JournalSession({ ...journalStorage,
    readAccount: async () => structuredClone(remote),
    readGuest: async () => ({ version: 'guest', trips: [] }),
    writeAccount: async journal => {
      remote = { rev: 'newer', trips: structuredClone(journal.trips) };
      if (++writes === 1) {
        posted();
        await held;
        return 'imported';
      }
      assert.equal(journal.rev, 'newer');
      return 'next';
    }
  });
  await session.load(false, title => title, async () => true);
  const save = session.change(() => {
    session.trip!.stops.push(cleanStop({ id: 'cafe', name: 'Cafe', date: trip.start }));
  });
  try {
    await request;
    assert.equal((await session.load(false, title => title, async () => true)).kind, 'account');
    assert.deepEqual(session.trip?.stops.map(stop => stop.name), ['Cafe']);
    release();
    assert.equal(await save, 'saved-after-refresh');
    assert.match(session.revision, /^newer\//);
    assert.equal(await session.change(() => { session.trips.push({ ...trip, id: 'next' }); }), 'saved');
    assert.equal(writes, 2);
  } finally { release(); }
});
