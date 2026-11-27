import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { journalSchemaVersion as schemaVersion } from '../src/domain/journal-schema.ts';
import { journalAPI } from '../src/server/journal-api.ts';
import { loadState, storeState } from '../src/server/storage.ts';
import { journalStorage, SaveRejected } from '../src/web/journal-storage.ts';
import { MemoryBucket } from './memory-bucket.ts';

const owner = 'traveler';
const key = 'journal/' + owner;
function tripFixture() {
  return cleanTrip({
    id: 'city', title: 'City trip', start: '2026-06-14', end: '2026-06-15',
    stops: [{
      id: 'museum', name: 'Museum', date: '2026-06-14', xy: [51.92, 4.48],
      sources: ['photo'], refs: ['photo-ref'], time: '09:30', captureTime: '09:30:12.500',
      photoAnchor: [51.9201, 4.4801], edited: true, kind: 'uncertain', reviewReason: 'Visit still to confirm'
    }],
    googlePins: [{ id: 'park', name: 'Park', xy: [51.93, 4.49], date: '2026-06-14' }],
    removedGooglePinIds: ['removed-cafe']
  });
}
function web(bucket: MemoryBucket, body?: unknown) {
  return journalAPI(new Request('https://journal.example/api/journal', body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://journal.example' }, body: JSON.stringify(body)
  }), bucket, 'web', owner);
}
function mcp(bucket: MemoryBucket, name: string, args: unknown) {
  return journalAPI(new Request('https://journal.example/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  }), bucket, 'mcp', owner);
}

await test('an older browser cannot strip fields from a newer journal with a full save', async () => {
  const bucket = new MemoryBucket(), trip = tripFixture();
  const rev = await storeState(bucket, owner, [trip], '');
  const before = await bucket.get(key);
  assert.ok(before);
  const oldTrip = structuredClone(trip);
  delete oldTrip.googlePins;
  delete oldTrip.removedGooglePinIds;
  delete oldTrip.stops[0].captureTime;
  delete oldTrip.stops[0].photoAnchor;
  delete oldTrip.stops[0].edited;
  delete oldTrip.stops[0].reviewReason;
  for (const version of [undefined, 0, schemaVersion + 1, '1', null]) {
    const response = await web(bucket, { trips: [oldTrip], rev, ...(version === undefined ? {} : { schemaVersion: version }) });
    assert.equal(response.status, 426);
    assert.match((await response.json()).error, /reload/i);
    const after = await bucket.get(key);
    assert.equal(after?.etag, before.etag);
    assert.equal(await after?.text(), await before.text());
  }
});

await test('a current browser reads and saves the versioned format without losing metadata', async () => {
  const bucket = new MemoryBucket(), trip = tripFixture();
  const rev = await storeState(bucket, owner, [trip], '');
  const read = await (await web(bucket)).json();
  assert.equal(read.schemaVersion, schemaVersion);
  assert.equal(read.rev, rev);
  assert.deepEqual(read.trips, [trip]);
  const changed = { ...trip, title: 'Updated title' };
  const saved = await web(bucket, { schemaVersion, trips: [changed], rev });
  assert.equal(saved.status, 200);
  const current = await loadState(bucket, owner);
  assert.notEqual(current.rev, rev);
  assert.deepEqual(current.trips, [changed]);
  assert.deepEqual(JSON.parse(await (await bucket.get(key))!.text()), { schemaVersion, trips: [changed] });
});

await test('legacy stored journals migrate only on a safe current-server write, including MCP', async () => {
  const bucket = new MemoryBucket(), trip = tripFixture();
  const legacy = JSON.stringify({ trips: [trip] });
  const stored = await bucket.put(key, legacy);
  assert.ok(stored);
  assert.deepEqual((await loadState(bucket, owner)).trips, [trip]);
  assert.equal(await (await bucket.get(key))!.text(), legacy);
  const response = await mcp(bucket, 'add_trip_stops', {
    tripId: trip.id,
    stops: [{ id: 'cafe', name: 'Cafe', date: trip.start, sources: ['manual'], refs: ['cafe-ref'] }]
  });
  const result = await response.json();
  assert.ok(!result.result.isError);
  assert.equal(JSON.parse(result.result.content[0].text).added, 1);
  const migrated = JSON.parse(await (await bucket.get(key))!.text());
  assert.equal(migrated.schemaVersion, schemaVersion);
  assert.deepEqual({ ...migrated.trips[0], stops: migrated.trips[0].stops.slice(0, 1) }, trip);
});

await test('an older server refuses to read or overwrite a future stored journal', async () => {
  const bucket = new MemoryBucket(), trip = tripFixture();
  const raw = JSON.stringify({ schemaVersion: schemaVersion + 1, trips: [{ ...trip, futureField: 'keep' }] });
  const stored = await bucket.put(key, raw);
  assert.ok(stored);
  await assert.rejects(loadState(bucket, owner), /reload/i);
  await assert.rejects(storeState(bucket, owner, [trip], stored.etag), /reload/i);
  assert.equal((await web(bucket)).status, 426);
  assert.equal((await web(bucket, { schemaVersion, trips: [trip], rev: stored.etag })).status, 426);
  const tool = await (await mcp(bucket, 'add_trip_stops', { tripId: trip.id, stops: [] })).json();
  assert.equal(tool.result.isError, true);
  assert.match(tool.result.content[0].text, /reload/i);
  assert.equal((await bucket.get(key))?.etag, stored.etag);
  assert.equal(await (await bucket.get(key))!.text(), raw);
});

await test('the browser advertises its schema and surfaces reload-required save errors', async t => {
  const trip = tripFixture();
  let posted: Record<string, unknown> | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted = JSON.parse(String(init.body));
      return Response.json({ error: 'The journal format has changed. Reload this page before saving.' }, { status: 426 });
    }
    return Response.json({ schemaVersion, trips: [trip], rev: 'revision' });
  });
  assert.deepEqual(await journalStorage.readAccount(), { trips: [trip], rev: 'revision' });
  await assert.rejects(journalStorage.writeAccount({ trips: [trip], rev: 'revision' }), error =>
    error instanceof SaveRejected && error.status === 426 && /reload/i.test(error.message));
  assert.equal(posted?.schemaVersion, schemaVersion);
});

await test('the browser refuses unsupported account replies before sanitizing their trips', async t => {
  for (const version of [undefined, 0, schemaVersion + 1]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ schemaVersion: version, trips: [tripFixture()], rev: 'revision' }));
    await assert.rejects(journalStorage.readAccount(), /reload/i);
    t.mock.restoreAll();
  }
});
