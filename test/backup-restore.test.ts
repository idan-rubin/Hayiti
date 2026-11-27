import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip, type Trip } from '../src/domain/core.ts';
import { routeStops } from '../src/domain/daily-route.ts';
import { prepareTripBackup } from '../src/domain/importers.ts';

const date = '2026-06-14';
function example() {
  return cleanTrip({
    id: 'backup-order', title: 'A fictional afternoon', start: date, end: '2026-06-15',
    stops: ['cafe', 'museum', 'park', 'bridge', 'market'].map((name, index) => ({
      id: name, name, date, rank: index + 1, sources: ['manual'], refs: ['visit:' + name],
      xy: [51.92 + index * 0.0005, 4.48 + index * 0.001]
    }))
  });
}
function routes(trip: Trip) {
  trip.edges = trip.stops.slice(1).map((stop, index) => ({
    a: trip.stops[index].id, b: stop.id, type: 'walk', m: 100,
    line: [trip.stops[index].xy!, stop.xy!]
  }));
}
const order = (trip: Trip) => routeStops(trip, date).map(stop => stop.id);

await test('restoring a middle stop restores its position and both adjacent walks without changing the live trip', () => {
  const backup = example();
  backup.stops = backup.stops.slice(0, 3);
  routes(backup);
  const live = structuredClone(backup);
  live.stops.splice(1, 1);
  live.edges = [];
  const before = structuredClone(live);
  const result = prepareTripBackup(backup, [live]);
  assert.deepEqual(order(result.trip), ['cafe', 'museum', 'park']);
  assert.deepEqual(result.trip.edges, backup.edges);
  assert.equal(result.routes, 2);
  assert.equal(result.stops.added, 1);
  assert.deepEqual(live, before);
  const retry = prepareTripBackup(backup, [result.trip]);
  assert.deepEqual(retry.trip, result.trip);
  assert.equal(retry.routes, 0);
  assert.equal(retry.stops.added, 0);
});

await test('missing runs at the start and end return around their surviving backup anchor', () => {
  const backup = example();
  routes(backup);
  const live = structuredClone(backup);
  live.stops = [live.stops[2]];
  live.edges = [];
  const result = prepareTripBackup(backup, [live]);
  assert.deepEqual(order(result.trip), ['cafe', 'museum', 'park', 'bridge', 'market']);
  assert.deepEqual(result.trip.edges, backup.edges);
  assert.equal(result.routes, 4);
});

await test('restoring missing stops preserves the order and newer walks of current visits', () => {
  const backup = example();
  backup.stops = backup.stops.slice(0, 3);
  routes(backup);
  const live = structuredClone(backup);
  live.stops.splice(1, 1);
  const extra = { ...structuredClone(live.stops[0]), id: 'live-stop', name: 'New visit', rank: 2, refs: ['live-stop'] };
  live.stops.push(extra);
  live.edges = [{ a: 'cafe', b: 'live-stop', type: 'same', m: 0, line: [] }];
  const result = prepareTripBackup(backup, [live]);
  assert.deepEqual(order(result.trip), ['cafe', 'live-stop', 'museum', 'park']);
  assert.deepEqual(result.trip.edges[0], live.edges[0]);
  assert.equal(result.routes, 1);
  assert.equal(result.trip.edges[1].a, 'museum');
  assert.equal(result.trip.edges[1].b, 'park');
});

await test('a backup keeps a newer order and never restores a leg across reversed current anchors', () => {
  const backup = example();
  backup.stops = backup.stops.slice(0, 3);
  routes(backup);
  const live = structuredClone(backup);
  live.stops.splice(1, 1);
  live.stops[0].rank = 2;
  live.stops[1].rank = 1;
  live.edges = [];
  const result = prepareTripBackup(backup, [live]);
  assert.deepEqual(order(result.trip), ['park', 'cafe', 'museum']);
  assert.deepEqual(result.trip.edges.map(edge => [edge.a, edge.b]), [['cafe', 'museum']]);
});

await test('a restored stop does not revive a walk to a surviving endpoint moved since the backup', () => {
  const backup = example();
  backup.stops = backup.stops.slice(0, 3);
  routes(backup);
  const live = structuredClone(backup);
  live.stops.splice(1, 1);
  live.stops[1].xy = [51.93, 4.49];
  live.edges = [];
  const result = prepareTripBackup(backup, [live]);
  assert.deepEqual(order(result.trip), ['cafe', 'museum', 'park']);
  assert.deepEqual(result.trip.edges.map(edge => [edge.a, edge.b]), [['cafe', 'museum']]);
  assert.deepEqual(result.trip.stops.find(stop => stop.id === 'park')?.xy, [51.93, 4.49]);
});
