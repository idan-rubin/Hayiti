import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { prepareRouteImport, setDayRoutes } from '../src/domain/route-update.ts';
import { journalAPI } from '../src/server/journal-api.ts';
import { loadState, storeState } from '../src/server/storage.ts';
import { MemoryBucket } from './memory-bucket.ts';

const date = '2026-05-03';
const end = '2026-05-04';
const a = [51.92, 4.48], bend = [51.921, 4.48], b = [51.921, 4.485];
const walking = { a: 'base', b: 'cafe', type: 'walk', line: [a, bend, b] };
const cab = { a: 'pickup', b: 'dropoff', type: 'taxi', line: [a, bend, b] };

function example() {
  return cleanTrip({
    id: 'trip', start: date, end, home: 'Guesthouse', homeXY: a,
    stops: [
      { id: 'cafe', name: 'Cafe', date, xy: b, rank: 1 },
      { id: 'remote', name: 'Remote', date, rank: 2, kind: 'remote' },
      { id: 'pickup', name: 'Pickup', date, xy: a, rank: 3, kind: 'pickup' },
      { id: 'dropoff', name: 'Drop-off', date, xy: b, rank: 4, kind: 'dropoff' },
      { id: 'park', name: 'Park', date: end, xy: b, rank: 1 }
    ]
  });
}

await test('routing retains confirmed network points, round-trips home legs, and preserves omitted legs', () => {
  const trip = example();
  assert.deepEqual(setDayRoutes(trip, date, [walking, cab]), { updated: 2, unchanged: 0 });
  const roundTrip = cleanTrip(trip);
  assert.deepEqual(setDayRoutes(roundTrip, date, [walking, cab]), { updated: 0, unchanged: 2 });
  assert.ok(roundTrip.edges[0].m > 0);
  assert.deepEqual(roundTrip.edges[0].line, walking.line);
  assert.deepEqual(setDayRoutes(roundTrip, date, [{ ...walking, type: 'gap', line: [] }]), { updated: 1, unchanged: 0 });
  assert.equal(roundTrip.edges.find(e => e.a === 'pickup')?.type, 'taxi');
});
await test('pedestrians can reach a path 130 m from a shoreline pin while taxi endpoints stay within 100 m', () => {
  const trip = example();
  const snappedStart = [51.92117, 4.48];
  const line = [snappedStart, bend, b];
  assert.equal(setDayRoutes(trip, date, [{ ...walking, line }]).updated, 1);
  assert.throws(() => setDayRoutes(trip, date, [{ ...cab, line }]));
});
await test('reject invalid, reversed, cross-day, off-route or implausible segments without changing any date', () => {
  const trip = example();
  const invalid = [
    { ...walking, a: 'remote' }, { ...walking, b: 'park' }, { ...walking, b: 'pickup' },
    { ...cab, type: 'walk' }, { ...walking, line: [b, bend, a] },
    { ...walking, line: [a, a] }, { ...walking, line: [a, [100, 0], b] },
    { ...walking, m: 50000 }, { ...walking, type: 'gap' },
    { ...walking, type: 'same', line: [] }
  ];
  for (const leg of invalid) {
    assert.throws(() => setDayRoutes(trip, date, [leg]));
    assert.deepEqual(trip.edges, []);
  }
  const file = { tripId: trip.id, days: [
    { date, routes: [walking] }, { date: end, routes: [cab] }
  ] };
  assert.throws(() => prepareRouteImport(trip, file));
  assert.throws(() => prepareRouteImport(trip, { ...file, tripId: 'other' }));
  assert.deepEqual(trip.edges, []);
});
await test('authenticated route writes are isolated, idempotent and verified by get_day', async () => {
  const bucket = new MemoryBucket();
  const trip = example();
  await storeState(bucket, 'alice', [trip], '');
  const args = { tripId: trip.id, date, routes: [walking, cab] };
  function call(name: string, owner: string | null) {
    const req = new Request('https://example.test/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    return journalAPI(req, bucket, 'mcp', owner);
  }
  assert.equal((await call('set_day_routes', null)).status, 401);
  assert.equal((await (await call('set_day_routes', 'bob')).json()).result.isError, true);
  assert.equal(JSON.parse((await (await call('set_day_routes', 'alice')).json()).result.content[0].text).updated, 2);
  const rev = (await loadState(bucket, 'alice')).rev;
  assert.equal(JSON.parse((await (await call('set_day_routes', 'alice')).json()).result.content[0].text).unchanged, 2);
  assert.equal(rev, (await loadState(bucket, 'alice')).rev);
  const result = JSON.parse((await (await call('get_day', 'alice')).json()).result.content[0].text);
  assert.deepEqual(result.routes.map((route: { type: string; points: number }) => [route.type, route.points]),
    [['walk', 3], ['gap', 0], ['taxi', 3]]);
});
