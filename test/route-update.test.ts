import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { routeStops } from '../src/domain/daily-route.ts';
import { prepareTripBackup } from '../src/domain/importers.ts';
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
await test('backup merges restore the saved path and distance for adjacent stops across days, once', () => {
  const backup = example();
  setDayRoutes(backup, date, [walking, cab]);
  setDayRoutes(backup, end, [{ ...walking, b: 'park' }]);
  const existing = structuredClone(backup);
  const [currentRide] = existing.edges.filter(edge => edge.type === 'taxi');
  currentRide.m += 12;
  existing.edges = [currentRide];
  const cafe = existing.stops.find(stop => stop.id === 'cafe')!;
  const sourceCafe = backup.stops.find(stop => stop.id === 'cafe')!;
  cafe.id = 'local-cafe';
  cafe.refs = sourceCafe.refs = ['same-receipt'];
  const restored = prepareTripBackup(backup, [existing]);
  assert.equal(restored.routes, 2);
  assert.equal(existing.edges.length, 1, 'preview does not mutate the live route');
  assert.deepEqual(restored.trip.edges.find(edge => edge.b === 'local-cafe'), { ...backup.edges[0], b: 'local-cafe' });
  assert.deepEqual(restored.trip.edges.find(edge => edge.b === 'park'), backup.edges.find(edge => edge.b === 'park'));
  assert.deepEqual(restored.trip.edges.find(edge => edge.b === 'dropoff'), currentRide);
  assert.equal(prepareTripBackup(backup, [restored.trip]).routes, 0);
  existing.edges = [];
  assert.deepEqual(prepareTripBackup(backup, [existing]).trip.edges.find(edge => edge.type === 'taxi'), backup.edges[1]);
});

await test('an earlier backed up photo adds its evidence without moving a current pin or its road geometry', () => {
  const backup = example();
  const photo = backup.stops.find(stop => stop.id === 'cafe')!;
  photo.sources = ['photo'];
  photo.refs = ['same-photo'];
  photo.time = '10:00';
  const existing = structuredClone(backup);
  const current = existing.stops.find(stop => stop.id === 'cafe')!;
  current.time = '11:00';
  current.xy = [b[0] + 0.0001, b[1]];
  setDayRoutes(existing, date, [walking]);
  photo.refs.push('related-photo');
  const result = prepareTripBackup(backup, [existing]);
  assert.deepEqual(result.trip.edges, existing.edges);
  assert.deepEqual(result.trip.stops.find(stop => stop.id === 'cafe'), { ...current, refs: photo.refs });
  assert.equal(prepareTripBackup(backup, [result.trip]).routes, 0);
});

await test('a backup cannot reattach routes to edited positions, another day, unrelated IDs or a superseded order', () => {
  const backup = example();
  setDayRoutes(backup, date, [walking, cab]);
  setDayRoutes(backup, end, [{ ...walking, b: 'park' }]);
  const existing = structuredClone(backup);
  existing.edges = [];
  existing.homeXY = [51.9201, 4.48]; // Within normal router snapping range, but the traveler moved it.
  const dropoff = existing.stops.find(stop => stop.id === 'dropoff')!;
  dropoff.name = 'A different stop with the same ID';
  assert.equal(prepareTripBackup(backup, [existing]).routes, 0);
  dropoff.name = 'Drop-off';
  dropoff.xy = [51.9211, 4.485];
  assert.equal(prepareTripBackup(backup, [existing]).routes, 0);
  dropoff.xy = [...backup.stops.find(stop => stop.id === 'dropoff')!.xy!];
  dropoff.rank = 2.5;
  assert.equal(prepareTripBackup(backup, [existing]).routes, 0);
  dropoff.rank = 4;
  dropoff.date = end;
  assert.equal(prepareTripBackup(backup, [existing]).routes, 0);
});

await test('backup restores new visits in rank order and skips invalid geometry without losing valid legs', () => {
  const backup = example();
  setDayRoutes(backup, date, [walking, cab]);
  backup.stops.reverse();
  backup.edges.push({ ...backup.edges[0], line: [[0, 0], [1, 1]] });
  backup.edges.push({ ...backup.edges[1], a: 'cafe', b: 'park' });
  const existing = cleanTrip({ ...backup, stops: [], edges: [] });
  const result = prepareTripBackup(backup, [existing]);
  assert.equal(result.routes, 2);
  assert.deepEqual(result.trip.edges.find(edge => edge.b === 'cafe'), backup.edges[0]);
  assert.deepEqual(result.trip.edges.find(edge => edge.b === 'dropoff'), backup.edges[1]);
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

const order = { previous: ['cafe', 'pickup', 'dropoff'], next: ['pickup', 'dropoff', 'cafe'] };
const afterRide = { a: 'dropoff', b: 'cafe', type: 'same', line: [] };

await test('a new order retains the taxi ride and other days, dropping precisely the displaced links', () => {
  const trip = example();
  setDayRoutes(trip, date, [walking, cab, { a: 'cafe', b: 'pickup', type: 'walk', line: [b, bend, a] }]);
  setDayRoutes(trip, end, [{ ...walking, b: 'park' }]);
  const retained = trip.edges.filter(edge => edge.type === 'taxi' || edge.b === 'park');
  const offRoute = structuredClone(trip.stops.filter(stop => stop.kind === 'remote' || stop.date === end));
  setDayRoutes(trip, date, [], order);
  assert.deepEqual(routeStops(trip, date).map(stop => stop.id), ['base', ...order.next]);
  assert.deepEqual(trip.edges, retained);
  assert.deepEqual(trip.stops.filter(stop => stop.kind === 'remote' || stop.date === end), offRoute);
  // An order already in effect still allows a subsequent successful directions lookup.
  setDayRoutes(trip, date, [afterRide], order);
  const saved = structuredClone(trip);
  assert.equal(setDayRoutes(trip, date, [afterRide], order).unchanged, 1);
  assert.deepEqual(trip, saved);
});

await test('mapped orders accept legacy pinless placeholders without moving them or splitting known geometry', () => {
  const trip = example();
  const purchase = { ...trip.stops[0], id: 'unlocated', rank: 3.5, xy: null };
  trip.stops.push(purchase);
  setDayRoutes(trip, date, [cab]);
  assert.deepEqual(routeStops(trip, date).map(stop => stop.id), ['base', ...order.previous]);
  assert.throws(() => setDayRoutes(trip, date, [{ ...cab, b: purchase.id }]));
  const legacy = { previous: ['cafe', 'pickup', purchase.id, 'dropoff'], next: ['pickup', 'dropoff', purchase.id, 'cafe'] };
  setDayRoutes(trip, date, [], legacy);
  assert.deepEqual(routeStops(trip, date).map(stop => stop.id), ['base', ...order.next]);
  assert.deepEqual(trip.stops.find(stop => stop.id === purchase.id), purchase);
  assert.deepEqual(trip.edges.map(({ a, b }) => [a, b]), [['pickup', 'dropoff']]);
  assert.deepEqual(setDayRoutes(trip, date, [], legacy), { updated: 0, unchanged: 0 });
});

await test('each order must match a complete day snapshot and keep adjacent taxi endpoints together', () => {
  const trip = example();
  const origin = { ...trip.stops[0], id: 'hotel', kind: 'origin' as const, rank: 0 };
  trip.stops.push(origin, { ...trip.stops[0], id: 'unsure', kind: 'uncertain' });
  const invalid = [
    { previous: ['pickup', 'cafe', 'dropoff'], next: order.next },
    { previous: order.previous, next: ['dropoff', 'pickup', 'cafe'] },
    { previous: order.previous, next: ['pickup', 'cafe', 'dropoff'] },
    { previous: order.previous, next: ['cafe', 'cafe', 'pickup'] },
    { previous: ['cafe', 'pickup'], next: order.previous },
    ...['park', 'hotel', 'base', 'remote', 'unsure'].map(extra => ({
      previous: [...order.previous, extra], next: [...order.next, extra]
    }))
  ];
  for (const invalidOrder of invalid) {
    const before = structuredClone(trip);
    assert.throws(() => setDayRoutes(trip, date, [], invalidOrder));
    assert.deepEqual(trip, before);
  }
  const before = structuredClone(trip);
  assert.throws(() => setDayRoutes(trip, date, [{ a: 'cafe', b: 'pickup', type: 'walk', line: [b, bend, a] }], order));
  assert.deepEqual(trip, before);
  setDayRoutes(trip, date, [], order);
  assert.deepEqual(routeStops(trip, date).map(stop => stop.id), ['hotel', ...order.next]);
});

await test('equal ranks in a legacy day can be reordered while excluded records keep their rank', () => {
  const trip = example();
  for (const stop of trip.stops) stop.rank = 0;
  setDayRoutes(trip, date, [], order);
  assert.deepEqual(routeStops(cleanTrip(trip), date).map(stop => stop.id), ['base', ...order.next]);
  assert.equal(trip.stops.find(stop => stop.id === 'remote')?.rank, 0);
  assert.equal(trip.stops.find(stop => stop.id === 'park')?.rank, 0);
});

await test('a taxi recorded between ordinary stops also protects their order', () => {
  const trip = example();
  for (const stop of trip.stops) if (stop.id === 'pickup' || stop.id === 'dropoff') stop.kind = 'visit';
  setDayRoutes(trip, date, [cab]);
  const before = structuredClone(trip);
  assert.throws(() => setDayRoutes(trip, date, [], { previous: order.previous, next: ['pickup', 'cafe', 'dropoff'] }));
  assert.throws(() => setDayRoutes(trip, date, [{ ...cab, type: 'walk' }], order));
  assert.deepEqual(trip, before);
});

await test('portable order previews validate every day before changing any ranks or geometry', () => {
  const trip = example();
  setDayRoutes(trip, date, [walking, cab]);
  const before = structuredClone(trip);
  const firstDay = { date, order, routes: [] };
  const file = { tripId: trip.id, days: [firstDay] };
  const plan = prepareRouteImport(trip, file);
  assert.equal(plan.reorderedDays, 1);
  assert.deepEqual(routeStops({ ...trip, stops: plan.stops }, date).map(stop => stop.id), ['base', ...order.next]);
  assert.deepEqual(plan.edges, before.edges.filter(edge => edge.type === 'taxi'));
  assert.deepEqual(trip, before);
  assert.throws(() => prepareRouteImport(trip, { ...file, days: [firstDay, { date: end, order, routes: [] }] }));
  assert.deepEqual(trip, before);
});

await test('an agent can persist a new order with no replacement geometry and safely retry', async () => {
  const bucket = new MemoryBucket(), trip = example();
  const revision = await storeState(bucket, 'alice', [trip], '');
  const args = { tripId: trip.id, date, routes: [], order };
  const save = () => journalAPI(new Request('https://example.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_day_routes', arguments: args } })
  }), bucket, 'mcp', 'alice');
  assert.ok(!(await (await save()).json()).result.isError);
  const saved = await loadState(bucket, 'alice');
  assert.notEqual(saved.rev, revision);
  assert.deepEqual(routeStops(saved.trips[0], date).map(stop => stop.id), ['base', ...order.next]);
  assert.ok(!(await (await save()).json()).result.isError);
  assert.equal((await loadState(bucket, 'alice')).rev, saved.rev);
});

await test('a pickup and drop-off saved apart can be brought together, and then stay together', () => {
  const trip = example();
  const ids = () => routeStops(trip, date).filter(stop => stop.kind !== 'origin').map(stop => stop.id);
  for (const stop of trip.stops) {
    if (stop.id === 'cafe') stop.rank = 3.5;
  }
  assert.deepEqual(ids(), ['pickup', 'cafe', 'dropoff']);
  assert.deepEqual(setDayRoutes(trip, date, [], { previous: ['pickup', 'cafe', 'dropoff'], next: ['cafe', 'pickup', 'dropoff'] }),
    { updated: 0, unchanged: 0, reordered: true });
  assert.deepEqual(ids(), ['cafe', 'pickup', 'dropoff']);
  assert.throws(() => setDayRoutes(trip, date, [], { previous: ['cafe', 'pickup', 'dropoff'], next: ['pickup', 'cafe', 'dropoff'] }));
  assert.deepEqual(ids(), ['cafe', 'pickup', 'dropoff']);
});

function separatedRides() {
  const previous = ['p1', 'museum', 'd1', 'p2', 'lunch', 'd2'];
  const stops = previous.map((id, rank) => ({
    id, rank, date, name: id, xy: id.startsWith('p') ? a : b,
    kind: id.startsWith('p') ? 'pickup' : id.startsWith('d') ? 'dropoff' : 'visit'
  }));
  const ride = (a: string, b: string) => ({ ...cab, a, b });
  const trip = cleanTrip({ id: 'two-rides', start: date, end: date, stops, edges: [ride('p1', 'd1'), ride('p2', 'd2')] });
  return { trip, previous, ride };
}

await test('manual separation keeps both recorded rides recoverable and prevents exchanging their endpoints', () => {
  const { trip, previous, ride } = separatedRides();
  const before = structuredClone(trip);
  const swapped = { previous, next: ['p1', 'd2', 'museum', 'p2', 'd1', 'lunch'] };
  assert.throws(() => setDayRoutes(trip, date, [], swapped));
  assert.throws(() => setDayRoutes(trip, date, [ride('p1', 'd2'), ride('p2', 'd1')], swapped));
  assert.deepEqual(trip, before);

  const unrelated = ['museum', 'p1', 'lunch', 'd1', 'p2', 'd2'];
  setDayRoutes(trip, date, [], { previous, next: unrelated });
  assert.deepEqual(trip.edges, before.edges);
  const restored = { previous: unrelated, next: ['museum', 'p1', 'd1', 'lunch', 'p2', 'd2'] };
  assert.throws(() => setDayRoutes(trip, date, [{ a: 'p1', b: 'd1', type: 'gap', line: [] }], restored));
  setDayRoutes(trip, date, [], restored);
  assert.deepEqual(trip.edges, before.edges);
  assert.deepEqual(setDayRoutes(trip, date, [], restored), { updated: 0, unchanged: 0 });
  assert.throws(() => setDayRoutes(trip, date, [], swapped));
  assert.deepEqual(trip.edges, before.edges);
});

await test('a routing retry cannot bind one ride to a different saved ride after a manual reorder', () => {
  const { trip, ride } = separatedRides();
  trip.stops.find(s => s.id === 'd2')!.rank = 0.5;
  const before = structuredClone(trip);
  assert.throws(() => setDayRoutes(trip, date, [ride('p1', 'd2')]));
  assert.deepEqual(trip, before);
});

await test('several loose taxi endpoints cannot be paired by position while a single remaining ride can', () => {
  const { trip, previous } = separatedRides();
  const [firstRide] = trip.edges;
  trip.edges = [];
  const next = ['p1', 'd1', 'museum', 'p2', 'd2', 'lunch'];
  assert.throws(() => setDayRoutes(trip, date, [], { previous, next }));
  assert.deepEqual(routeStops(trip, date).map(s => s.id), previous);

  trip.edges.push(firstRide);
  assert.ok(setDayRoutes(trip, date, [], { previous, next }).reordered);
  assert.deepEqual(routeStops(trip, date).map(s => s.id), next);
});

await test('get_day exposes only the IDs of separated taxi rides on the requested day', async () => {
  const { trip } = separatedRides();
  trip.end = end;
  const stop = trip.stops[0];
  trip.stops.push({ ...stop, id: 'tomorrow', date: end });
  // Only the first ride is still separated.
  trip.stops.find(s => s.id === 'lunch')!.rank = 6;
  const bucket = new MemoryBucket();
  await storeState(bucket, 'owner', [trip], '');
  const read = async (day: string) => {
    const request = new Request('https://example.test/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_day', arguments: { tripId: trip.id, date: day } } })
    });
    const response = await journalAPI(request, bucket, 'mcp', 'owner');
    return JSON.parse((await response.json()).result.content[0].text);
  };
  assert.deepEqual((await read(date)).separatedTaxiPairs, [{ a: 'p1', b: 'd1' }]);
  assert.equal((await read(end)).separatedTaxiPairs, undefined);
});

await test('geometry alone cannot downgrade a saved taxi leg, including visits with no taxi kind', () => {
  const trip = example();
  for (const stop of trip.stops) if (stop.kind === 'pickup' || stop.kind === 'dropoff') stop.kind = 'visit';
  setDayRoutes(trip, date, [cab]);
  const before = structuredClone(trip);
  for (const route of [{ ...cab, type: 'gap', line: [] }, { ...cab, type: 'walk' }]) {
    assert.throws(() => setDayRoutes(trip, date, [route]));
  }
  assert.deepEqual(trip, before);
});

await test('an overnight ride reserves its endpoint while home taxi legs are scoped by day', () => {
  const { trip, previous, ride } = separatedRides();
  trip.end = end;
  trip.stops.find(s => s.id === 'd1')!.date = end;
  trip.stops = trip.stops.filter(stop => stop.id !== 'p2');
  trip.edges = [trip.edges[0]];
  const before = structuredClone(trip);
  const next = ['p1', 'd2', 'museum', 'lunch'];
  assert.throws(() => setDayRoutes(trip, date, [], { previous: previous.filter(id => id !== 'd1' && id !== 'p2'), next }));
  assert.deepEqual(trip, before);

  const home = example();
  assert.ok(setDayRoutes(home, date, [{ ...walking, type: 'taxi' }]).updated);
  assert.ok(setDayRoutes(home, end, [ride('base', 'park')]).updated);
  assert.deepEqual(home.edges.map(edge => [edge.a, edge.b]), [['base', 'cafe'], ['base', 'park']]);
});

await test('an explicit taxi correction restores ordinary visits and allows a later reorder or taxi route', () => {
  for (const stored of [true, false]) for (const replacement of [
    { ...cab, type: 'walk', correctTaxi: true }, { ...cab, type: 'gap', line: [], correctTaxi: true }
  ]) {
    const trip = example();
    setDayRoutes(trip, date, stored ? [walking, cab] : [walking]);
    const original = structuredClone(trip), split = { previous: order.previous, next: ['pickup', 'cafe', 'dropoff'] };
    const file = { tripId: trip.id, days: [{ date, routes: [replacement] }] };
    const plan = prepareRouteImport(trip, file);
    assert.deepEqual(trip, original);
    assert.equal(plan.correctedRides, 1);
    assert.deepEqual(setDayRoutes(trip, date, [replacement]), { updated: 1, unchanged: 0, correctedRides: 1 });
    assert.deepEqual(trip.stops, plan.stops);
    assert.deepEqual(trip.edges, plan.edges);
    assert.deepEqual(trip.stops.slice(2, 4), original.stops.slice(2, 4).map(stop => ({ ...stop, kind: 'visit' })));
    assert.equal(trip.edges.find(edge => edge.a === 'pickup')?.type, replacement.type);
    assert.deepEqual(trip.edges[0], original.edges[0]);
    const corrected = structuredClone(trip);
    assert.deepEqual(setDayRoutes(trip, date, [replacement]), { updated: 0, unchanged: 1 });
    assert.deepEqual(trip, corrected);
    assert.ok(setDayRoutes(trip, date, [], split).reordered);
    setDayRoutes(trip, date, [cab], { previous: split.next, next: split.previous });
    assert.throws(() => setDayRoutes(trip, date, [], split));
  }
});

await test('a correction cannot release a different ride and failed imports leave the original intact', () => {
  const { trip, ride, previous } = separatedRides();
  const original = structuredClone(trip);
  for (const legs of [
    [{ ...ride('p1', 'd1'), correctTaxi: true }],
    [{ ...ride('p1', 'd2'), correctTaxi: true, type: 'gap', line: [] }],
    [{ ...ride('p1', 'd1'), correctTaxi: true, type: 'walk', line: [b, bend, a] }]
  ]) {
    assert.throws(() => setDayRoutes(trip, date, legs));
    assert.deepEqual(trip, original);
  }
  const next = ['p1', 'd1', 'museum', 'p2', 'd2', 'lunch'];
  const oneRide = { ...ride('p1', 'd1'), correctTaxi: true, type: 'gap', line: [] };
  setDayRoutes(trip, date, [oneRide], { previous, next });
  assert.deepEqual(trip.edges.find(edge => edge.a === 'p2'), original.edges.find(edge => edge.a === 'p2'));
  assert.throws(() => setDayRoutes(trip, date, [], { previous: next, next: ['p1', 'd1', 'museum', 'p2', 'lunch', 'd2'] }));
  const exampleTrip = example();
  setDayRoutes(exampleTrip, date, [cab]);
  const before = structuredClone(exampleTrip);
  const corrected = { ...cab, correctTaxi: true, type: 'gap', line: [] };
  assert.throws(() => setDayRoutes(exampleTrip, date, [corrected], { previous: order.next, next: ['pickup', 'cafe', 'dropoff'] }));
  assert.deepEqual(exampleTrip, before);
  assert.throws(() => prepareRouteImport(exampleTrip, { tripId: exampleTrip.id, days: [
    { date, routes: [corrected] }, { date: end, routes: [cab] }
  ] }));
  assert.deepEqual(exampleTrip, before);
});

await test('MCP requires the read revision to correct a taxi and accepts an exact retry without a write', async () => {
  const trip = example(), bucket = new MemoryBucket();
  for (const stop of trip.stops) if (stop.kind === 'pickup' || stop.kind === 'dropoff') stop.kind = 'visit';
  setDayRoutes(trip, date, [cab]);
  await storeState(bucket, 'alice', [trip], '');
  const call = async (name: string, args: Record<string, unknown>) => (await (await journalAPI(new Request('https://example.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { tripId: trip.id, date, ...args } } })
  }), bucket, 'mcp', 'alice')).json()).result;
  const day = JSON.parse((await call('get_day', {})).content[0].text);
  const corrected = { ...cab, type: 'walk', correctTaxi: true };
  const args = { routes: [corrected], expectedRevision: day.revision };
  for (const expectedRevision of [undefined, 'stale']) {
    assert.equal((await call('set_day_routes', { ...args, expectedRevision })).isError, true);
    assert.deepEqual((await loadState(bucket, 'alice')).trips[0], trip);
  }
  assert.equal(JSON.parse((await call('set_day_routes', args)).content[0].text).updated, 1);
  const saved = await loadState(bucket, 'alice');
  assert.equal(JSON.parse((await call('set_day_routes', args)).content[0].text).unchanged, 1);
  assert.equal((await call('set_day_routes', { ...args, routes: [{ ...corrected, type: 'gap', line: [] }] })).isError, true);
  assert.deepEqual(await loadState(bucket, 'alice'), saved);
});
