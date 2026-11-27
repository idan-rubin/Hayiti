import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip, mergeGooglePins, removeGooglePin } from '../src/domain/core.ts';
import { shareableTrip } from '../src/domain/share-format.ts';
import { journalAPI } from '../src/server/journal-api.ts';
import { loadState, storeState } from '../src/server/storage.ts';
import { tools } from '../src/server/tools.ts';
import { MemoryBucket } from './memory-bucket.ts';

async function fixture() {
  const bucket = new MemoryBucket();
  const pin = { id: 'saved-park', name: 'Park', xy: [51.93, 4.49], date: '2026-06-15', savedAt: '2026-06-15T09:00:00+02:00' };
  const trip = cleanTrip({
    id: 'rotterdam', start: '2026-06-15', end: '2026-06-16',
    stops: [
      { id: 'cafe', name: 'Cafe', date: '2026-06-15', xy: [51.92, 4.48], rank: 0 },
      { id: 'museum', name: 'Museum', date: '2026-06-15', xy: [51.921, 4.481], rank: 1 }
    ],
    edges: [{ a: 'cafe', b: 'museum', type: 'walk', m: 150, line: [[51.92, 4.48], [51.921, 4.481]] }],
    googlePins: [pin]
  });
  removeGooglePin(trip, pin.id);
  await storeState(bucket, 'alice', [trip], '');
  async function call(name: string, args: Record<string, unknown>, owner: string | null = 'alice') {
    const response = await journalAPI(new Request('https://journal.example/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    }), bucket, 'mcp', owner);
    return { status: response.status, body: await response.json() };
  }
  return { bucket, trip, pin, call };
}

await test('chat explicitly restores a removed Google Pin and a retry leaves the revision alone', async () => {
  const { bucket, trip, pin, call } = await fixture();
  const before = await loadState(bucket, 'alice');
  const blocked = await call('add_trip_stops', { tripId: trip.id, stops: [], googlePins: [pin] });
  assert.deepEqual(JSON.parse(blocked.body.result.content[0].text).googlePins, { added: 0, linked: 0, skipped: 0, previouslyRemoved: 1 });
  assert.equal((await loadState(bucket, 'alice')).rev, before.rev);

  const restored = await call('restore_google_pin', { tripId: trip.id, pin });
  assert.ok(!restored.body.result.isError);
  assert.deepEqual(JSON.parse(restored.body.result.content[0].text), { restored: true });
  const saved = await loadState(bucket, 'alice');
  assert.notEqual(saved.rev, before.rev);
  assert.deepEqual(saved.trips[0].googlePins, [pin]);
  assert.equal(saved.trips[0].removedGooglePinIds, undefined);
  assert.deepEqual(saved.trips[0].stops, trip.stops);
  assert.deepEqual(saved.trips[0].edges, trip.edges);
  assert.deepEqual(shareableTrip(saved.trips[0], false), shareableTrip(trip, false));
  const day = await call('get_day', { tripId: trip.id, date: trip.start });
  const details = JSON.parse(day.body.result.content[0].text);
  assert.deepEqual(details.googlePins, [pin]);
  assert.equal(details.walking.stopCount, 2);

  const retry = await call('restore_google_pin', { tripId: trip.id, pin });
  assert.deepEqual(JSON.parse(retry.body.result.content[0].text), { restored: false });
  assert.equal((await loadState(bucket, 'alice')).rev, saved.rev);
});

await test('pin restoration is owner-only and invalid requests do not clear removal history', async () => {
  const { bucket, trip, pin, call } = await fixture();
  const before = await loadState(bucket, 'alice');
  assert.equal((await call('restore_google_pin', { tripId: trip.id, pin }, null)).status, 401);
  const otherOwner = await call('restore_google_pin', { tripId: trip.id, pin }, 'bob');
  assert.equal(otherOwner.body.result.isError, true);
  assert.equal(otherOwner.body.result.content[0].text, 'Trip not found');
  for (const invalid of [null, { ...pin, xy: [91, 4] }, { ...pin, xy: [0, 0] }, { ...pin, name: '' }, { ...pin, date: '2026-06-31' }, { ...pin, savedAt: 'not-a-date' }]) {
    const reply = await call('restore_google_pin', { tripId: trip.id, pin: invalid });
    assert.equal(reply.body.result.isError, true);
    assert.deepEqual(await loadState(bucket, 'alice'), before);
  }
  assert.deepEqual((await loadState(bucket, 'bob')).trips, []);
});

await test('an ordinary backup cannot restore removed pins and restoration cannot import unrelated pins', async () => {
  const { bucket, trip, pin, call } = await fixture();
  assert.deepEqual(mergeGooglePins(trip, [pin], 'backup'), { added: 0, linked: 0, skipped: 0, previouslyRemoved: 1 });
  const before = await loadState(bucket, 'alice');
  const reply = await call('restore_google_pin', { tripId: trip.id, pin: { ...pin, id: 'never-removed' } });
  assert.deepEqual(JSON.parse(reply.body.result.content[0].text), { restored: false });
  assert.deepEqual(await loadState(bucket, 'alice'), before);
  const discovery = tools.find(tool => tool.name === 'restore_google_pin');
  assert.equal(discovery?.annotations.readOnlyHint, false);
  assert.match(discovery!.description, /explicitly asks/);
});
