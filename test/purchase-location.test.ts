import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { routeStops } from '../src/domain/daily-route.ts';
import { correctStopLocation, updateRoutesForStopEdit } from '../src/domain/stop-location.ts';

const day = '2026-06-14';
function fixture(legacy = false, tiedRanks = false) {
  const xy = [51.92, 4.48];
  return cleanTrip({
    id: 'purchase-location', start: day, end: day,
    stops: [
      { id: 'pickup', name: 'Taxi pickup', kind: legacy ? 'pickup' : 'visit', rank: 1, xy },
      { id: 'purchase', name: 'Local purchase', kind: 'visit', rank: tiedRanks ? 1 : 2 },
      { id: 'dropoff', name: 'Taxi drop-off', kind: legacy ? 'dropoff' : 'visit', rank: tiedRanks ? 1 : 3, xy },
      { id: 'museum', name: 'Museum', kind: 'visit', rank: tiedRanks ? 1 : 4, xy },
      { id: 'park', name: 'Park', kind: 'visit', rank: tiedRanks ? 1 : 5, xy }
    ].map(stop => ({ ...stop, date: day, sources: ['manual'], refs: [stop.id] })),
    edges: [
      ...legacy ? [] : [{ a: 'pickup', b: 'dropoff', type: 'taxi', m: 800, line: [xy, xy] }],
      { a: 'dropoff', b: 'museum', type: 'walk', m: 200, line: [xy, xy] },
      { a: 'museum', b: 'park', type: 'walk', m: 300, line: [xy, xy] }
    ]
  });
}

await test('pinning a purchase keeps the ride together and invalidates only its new bypassed walk', () => {
  const trip = fixture();
  const [ride, , unaffected] = structuredClone(trip.edges);
  const input = { date: day, stopId: 'purchase', expectedRevision: 'first', xy: [51.923, 4.482] };
  assert.equal(correctStopLocation(trip, input, 'first'), true);
  assert.deepEqual(routeStops(trip, day).map(stop => stop.id), ['pickup', 'dropoff', 'purchase', 'museum', 'park']);
  assert.deepEqual(trip.edges, [ride, unaffected]);
  const saved = structuredClone(trip);
  assert.equal(correctStopLocation(trip, input, 'second'), false);
  assert.deepEqual(trip, saved);
});

await test('the editor moves a newly pinned purchase after legacy pickup and drop-off endpoints', () => {
  const trip = fixture(true);
  const old = trip.stops.find(stop => stop.id === 'purchase')!;
  const next = { ...old, xy: [51.923, 4.482] as [number, number] };
  const unaffected = structuredClone(trip.edges[1]);
  updateRoutesForStopEdit(trip, old, next);
  Object.assign(old, next);
  assert.deepEqual(routeStops(trip, day).map(stop => stop.id), ['pickup', 'dropoff', 'purchase', 'museum', 'park']);
  assert.deepEqual(trip.edges, [unaffected]);
});

await test('confirming a pinned purchase with tied ranks keeps every other stop in order', () => {
  const trip = fixture(false, true);
  const stop = trip.stops.find(stop => stop.id === 'purchase')!;
  stop.xy = [51.923, 4.482];
  stop.kind = 'uncertain';
  assert.equal(correctStopLocation(trip, { date: day, stopId: stop.id, expectedRevision: 'first', confirmVisit: true }, 'first'), true);
  assert.deepEqual(routeStops(trip, day).map(stop => stop.id), ['pickup', 'dropoff', 'purchase', 'museum', 'park']);
  assert.equal(trip.edges[0].type, 'taxi');
});

await test('a newly pinned purchase clears consecutive protected rides before entering the walking itinerary', () => {
  const trip = fixture();
  const a = trip.stops.find(stop => stop.id === 'dropoff')!;
  const b = trip.stops.find(stop => stop.id === 'museum')!;
  trip.edges[1] = { a: a.id, b: b.id, type: 'taxi', m: 400, line: [a.xy!, b.xy!] };
  const rides = structuredClone(trip.edges.slice(0, 2));
  correctStopLocation(trip, { date: day, stopId: 'purchase', expectedRevision: 'first', xy: [51.923, 4.482] }, 'first');
  assert.deepEqual(routeStops(trip, day).map(stop => stop.id), ['pickup', 'dropoff', 'museum', 'purchase', 'park']);
  assert.deepEqual(trip.edges, rides);
});
