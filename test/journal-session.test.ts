import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { JournalSession } from '../src/web/journal-session.ts';
import { journalStorage } from '../src/web/journal-storage.ts';

await test('malformed account replies preserve the selected trip, day, and last usable revision', async t => {
  const trip = cleanTrip({ id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-15', stops: [] });
  const session = new JournalSession({ ...journalStorage, readGuest: () => [], writeGuest: () => {} });
  let readReply: unknown = { trips: [trip], rev: 'r1' };
  let saveReply: unknown = {};
  const revisions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (init.method !== 'POST') return Response.json(readReply);
    revisions.push(JSON.parse(String(init.body)).rev);
    return Response.json(saveReply);
  });

  await session.load(false, title => title);
  session.select(session.trip, trip.end);
  readReply = { trips: [] };
  await assert.rejects(session.load(false, title => title));
  assert.equal(session.trip?.id, trip.id);

  await assert.rejects(session.change(() => { session.trips[0].title = 'First edit'; }));
  assert.equal(session.trip?.title, trip.title);
  assert.equal(session.day, trip.end);

  saveReply = { rev: 'r2' };
  assert.equal(await session.change(() => { session.trips[0].title = 'Second edit'; }), 'saved');
  assert.equal(await session.change(() => { session.trips[0].home = 'Hotel'; }), 'saved');
  assert.deepEqual(revisions, ['r1', 'r1', 'r2']);
});
