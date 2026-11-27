import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { correctStopLocation, prepareApproximateLocation, updateRoutesForStopEdit } from '../src/domain/stop-location.ts';
import { readSharedRoute, shareableTrip } from '../src/domain/share-format.ts';
import { journalAPI } from '../src/server/journal-api.ts';
import { loadState, storeState } from '../src/server/storage.ts';
import { MemoryBucket } from './memory-bucket.ts';

const date = '2026-06-14';
function fixture() {
  return cleanTrip({
    id: 'private-purchase', title: 'A day away', start: date, end: date,
    stops: [
      { id: 'before', date, name: 'Park', xy: [51.921, 4.48], rank: 0 },
      { id: 'purchase', date, name: 'Canal Street Shop', address: '17 Canal Street', xy: [51.922, 4.481], rank: 1 },
      { id: 'after', date, name: 'Museum', xy: [51.924, 4.484], rank: 2 },
      { id: 'last', date, name: 'Station', xy: [51.925, 4.485], rank: 3 }
    ],
    edges: [
      { a: 'before', b: 'purchase', type: 'walk', line: [[51.921, 4.48], [51.922, 4.481]], m: 160 },
      { a: 'after', b: 'last', type: 'walk', line: [[51.924, 4.484], [51.925, 4.485]], m: 160 }
    ]
  });
}

await test('an approximate label cannot keep an exact pin or invalidate its routes', () => {
  for (const xy of [undefined, [51.922, 4.481]]) {
    const trip = fixture(), original = structuredClone(trip);
    assert.throws(() => correctStopLocation(trip, {
      date, stopId: 'purchase', expectedRevision: 'r1', approx: true, xy
    }, 'r1'), /האזור המשוער/);
    assert.deepEqual(trip, original);
  }
});

await test('an approved area replaces the address and shares its saved general label and point', () => {
  const trip = fixture(), unchangedLeg = structuredClone(trip.edges[1]);
  const args = { date, stopId: 'purchase', expectedRevision: 'r1', approx: true,
    name: 'Carmel Market', xy: [51.923, 4.482], address: '17 Canal Street' };
  assert.equal(correctStopLocation(trip, args, 'r1'), true);
  const purchase = trip.stops[1];
  assert.equal(purchase.name, 'Carmel Market');
  assert.equal(purchase.address, '');
  assert.deepEqual(purchase.xy, args.xy);
  assert.deepEqual(trip.edges, [unchangedLeg]);
  assert.throws(() => correctStopLocation(trip, args, 'r2'), /journal changed/i);
  assert.equal(correctStopLocation(trip, { ...args, address: '' }, 'r2'), false);
  const shared = shareableTrip(trip, false);
  assert.equal(shared.stops[1].name, 'Carmel Market');
  assert.equal(shared.stops[1].address, '');
  assert.deepEqual(shared.stops[1].xy, args.xy);
  assert.doesNotMatch(JSON.stringify(shared), /17 Canal Street/);
  assert.equal(trip.stops[1].name, 'Carmel Market');
});

await test('approximate shared visits and taxi endpoints preserve their saved names while omitting addresses', () => {
  const snapshot = fixture();
  snapshot.stops[0].kind = 'pickup';
  snapshot.stops[0].name = 'Taxi pickup at the market';
  snapshot.stops[0].approx = true;
  snapshot.stops[1].approx = true;
  snapshot.stops[1].name = 'Carmel Market';
  snapshot.stops[2].kind = 'dropoff';
  snapshot.stops[2].name = 'Taxi drop-off at the museum';
  snapshot.stops[2].approx = true;
  const shared = readSharedRoute(snapshot, false);
  assert.equal(shared.stops[1].id, 'purchase');
  assert.deepEqual(shared.stops.map(stop => stop.name), snapshot.stops.map(stop => stop.name));
  assert.equal(shared.stops[1].address, '');
  assert.doesNotMatch(JSON.stringify(shared), /17 Canal Street/);
  assert.equal(snapshot.stops[1].address, '17 Canal Street');
});

await test('metadata edits to an already approximate stop preserve its private address and routes', () => {
  const trip = fixture();
  const old = trip.stops[1];
  old.approx = true;
  const next = { ...old, name: 'Carmel Market', time: '12:30', notes: 'Lunch with friends' };
  const edges = structuredClone(trip.edges);
  prepareApproximateLocation(old, next);
  updateRoutesForStopEdit(trip, old, next);
  assert.equal(next.address, old.address);
  assert.deepEqual(next.xy, old.xy);
  assert.deepEqual(trip.edges, edges);

  assert.equal(correctStopLocation(trip, {
    date, stopId: old.id, expectedRevision: 'r1', name: 'Carmel Market'
  }, 'r1'), true);
  assert.equal(trip.stops[1].address, '17 Canal Street');
  assert.equal(correctStopLocation(trip, {
    date, stopId: old.id, expectedRevision: 'r2', approx: true
  }, 'r2'), false);
  assert.deepEqual(trip.edges, edges);
});

await test('a new approximate stop keeps its selected label and private area description', () => {
  const next = fixture().stops[1];
  next.name = 'Carmel Market';
  next.address = 'Market neighborhood';
  next.approx = true;
  prepareApproximateLocation(undefined, next);
  assert.equal(next.name, 'Carmel Market');
  assert.equal(next.address, 'Market neighborhood');
});

await test('hosted approximation rejects the original point, respects revisions and retries safely', async () => {
  const bucket = new MemoryBucket(), trip = fixture();
  const revision = await storeState(bucket, 'traveler', [trip], '');
  async function correct(args: Record<string, unknown>) {
    const response = await journalAPI(new Request('https://hayiti.test/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'correct_stop_location', arguments: { tripId: trip.id, date, stopId: 'purchase', ...args }
      } })
    }), bucket, 'mcp', 'traveler');
    return (await response.json()).result;
  }
  const refused = await correct({ expectedRevision: revision, approx: true, xy: trip.stops[1].xy });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /different point/);
  assert.deepEqual(await loadState(bucket, 'traveler'), { trips: [trip], rev: revision });

  const args = { expectedRevision: revision, approx: true, xy: [51.923, 4.482], address: trip.stops[1].address };
  assert.equal((await correct({ ...args, expectedRevision: 'stale' })).isError, true);
  assert.equal((await loadState(bucket, 'traveler')).rev, revision);
  const applied = JSON.parse((await correct(args)).content[0].text);
  assert.equal(applied.updated, true);
  const saved = await loadState(bucket, 'traveler');
  assert.equal(saved.trips[0].stops[1].address, '');
  const retried = JSON.parse((await correct({ ...args, address: '' })).content[0].text);
  assert.deepEqual(retried, { ...applied, updated: false });
  assert.deepEqual(await loadState(bucket, 'traveler'), saved);

  const staleAddress = await correct({ expectedRevision: revision, approx: true, address: 'Different private address', xy: args.xy });
  assert.equal(staleAddress.isError, true);
  assert.match(staleAddress.content[0].text, /journal changed/i);
  assert.deepEqual(await loadState(bucket, 'traveler'), saved);
});
