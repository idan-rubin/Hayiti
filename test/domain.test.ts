import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip, mergeStops, safeDate } from '../src/domain/core.ts';
import { importCsv, importIcs } from '../src/domain/importers.ts';
import { indexEdges, routeStops, suggest, walkingStats } from '../src/domain/daily-route.ts';
import { readFileSync } from 'node:fs';
export const sample = () => cleanTrip(JSON.parse(readFileSync(new URL('./fixtures/rotterdam.json', import.meta.url), 'utf8')).trip);
await test('email and card evidence corroborate a unique visit; an identical receipt can be retried', () => {
  const trip = sample(),
    first = trip.stops[0];
  first.sources = ['card'];
  first.count = 1;
  const receipt = {
    ...first,
    id: 'receipt',
    sources: ['email'],
    refs: ['mail-1'],
    count: 0
  };
  assert.deepEqual(mergeStops(trip, [receipt]), {
    added: 0,
    linked: 1,
    skipped: 0
  });
  assert.deepEqual(first.sources, ['card', 'email']);
  assert.deepEqual(mergeStops(trip, [receipt]), {
    added: 0,
    linked: 0,
    skipped: 1
  });
  assert.equal(first.count, 1);
});
await test('visits with conflicting times are retained; an ambiguous match stays separate', () => {
  const trip = sample(),
    first = trip.stops[0];
  first.sources = ['manual'];
  const second = {
    ...first,
    id: 'evening',
    time: '19:00',
    sources: ['manual'],
    refs: ['another']
  };
  assert.equal(mergeStops(trip, [second]).added, 1);
  assert.equal(mergeStops(trip, [{
    ...second,
    id: 'receipt',
    time: '',
    sources: ['card'],
    refs: ['charge-1']
  }]).added, 1);
});
await test('dates and finite map coordinates are validated at import', () => {
  assert.equal(safeDate('2026-02-29'), false);
  assert.equal(safeDate('2028-02-29'), true);
  const trip = sample();
  assert.throws(() => mergeStops(trip, [{
    name: 'outside',
    date: '2026-07-01'
  }]));
  mergeStops(trip, [{
    name: 'Unknown place',
    date: trip.start,
    xy: [1, 190]
  }]);
  assert.equal(trip.stops.at(-1)?.xy, null);
});
await test('CSV retries preserve separate identical purchases and quoted merchant names', async () => {
  const raw = 'Transaction Date,Clearing Date,Merchant,Description\n06/14/2026,06/15/2026,"Cafe, Station",Lunch\n06/14/2026,06/15/2026,"Cafe, Station",Lunch';
  const {
    stops
  } = await importCsv(raw);
  assert.equal(stops.length, 2);
  assert.equal(stops[0].name, 'Cafe, Station');
  assert.notDeepEqual(stops[0].refs, stops[1].refs);
  const trip = sample();
  assert.equal(mergeStops(trip, stops).added, 2);
  assert.equal(mergeStops(trip, (await importCsv(raw)).stops).skipped, 2);
});
await test('calendar UTC times do not become local show times', async () => {
  const {
    stops
  } = await importIcs('BEGIN:VEVENT\r\nDTSTART:20260614T180000Z\r\nSUMMARY:Concert\r\nEND:VEVENT');
  assert.equal(stops[0].time, '');
  assert.match(stops[0].notes, /UTC/);
});
await test('calculates only known walking legs and honors explicit stop-order rules', () => {
  const trip = sample();
  const [first, last] = trip.stops;
  trip.edges = [{
    a: first.id,
    b: last.id,
    type: 'walk',
    m: 340,
    line: []
  }];
  assert.equal(walkingStats(routeStops(trip, trip.start), indexEdges(trip)).estimatedWalkingMeters, 340);
  trip.edges[0].type = 'taxi';
  assert.equal(walkingStats(trip.stops, indexEdges(trip)).estimatedWalkingMeters, null);
  trip.rules = last.name + ' before ' + first.name;
  assert.equal(suggest(trip.stops, trip)[0].id, last.id);
});

await test('a moved stop keeps its edited date when its backup is imported', () => {
  const trip = sample();
  const backup = structuredClone(trip);
  trip.stops[0].date = trip.end;
  assert.deepEqual(mergeStops(trip, backup.stops), { added: 0, linked: 0, skipped: 2 });
  assert.equal(cleanTrip(trip).stops[0].date, trip.end);
});

await test('starting points sort ahead of visits even when created last', () => {
  const trip = sample();
  const origin = { ...trip.stops[0], kind: 'origin' as const, id: 'late-origin', rank: 99 };
  trip.stops.push(origin);
  assert.deepEqual(routeStops(trip, trip.start).map(stop => stop.id), [origin.id, 'sample-1', 'sample-2']);
});

await test('CSV dates use the order evidenced in the file and times are normalized row by row', async () => {
  const header = 'Transaction Date,Description,Time\n';
  const us = await importCsv(header + '06/05/2026,Cafe,9:30\n06/14/2026,Show,2:30 PM\n06/15/2026,Bad,25:15');
  assert.deepEqual(us.stops.map(s => [s.date, s.time]), [['2026-06-05', '09:30'], ['2026-06-14', '14:30']]);
  assert.equal(us.omitted, 1);
  const eu = await importCsv(header + '05/06/2026,Cafe,12:00 AM\n14/06/2026,Show,12:00 PM');
  assert.deepEqual(eu.stops.map(s => [s.date, s.time]), [['2026-06-05', '00:00'], ['2026-06-14', '12:00']]);
  const ambiguous = header + '06/05/2026,Cafe,';
  assert.equal((await importCsv(ambiguous)).needsDateOrder, true);
  assert.equal((await importCsv(ambiguous, 'month-first')).stops[0].date, '2026-06-05');
  assert.equal((await importCsv(ambiguous, 'day-first')).stops[0].date, '2026-05-06');
});

await test('a statement with both columns names the stop after the merchant, not the bank descriptor', async () => {
  const raw = 'Transaction Date,Clearing Date,Description,Merchant\n06/14/2026,06/15/2026,SQ *BLUE BOTTLE 123 MAIN ST,Blue Bottle Coffee';
  assert.equal((await importCsv(raw)).stops[0].name, 'Blue Bottle Coffee');
  assert.equal((await importCsv('Date,Description\n2026-06-14,Corner Bakery')).stops[0].name, 'Corner Bakery');
});

await test('one column names the stops in a CSV, rows without it are skipped, and the purchase date is used', async () => {
  const merchant = await importCsv('Transaction Date,Description,Merchant,Name\n2026-06-14,CORNER BAKERY 123,,Dana Traveler\n2026-06-14,SQ *BLUE BOTTLE,Blue Bottle Coffee,Dana Traveler');
  assert.deepEqual(merchant.stops.map(stop => stop.name), ['Blue Bottle Coffee']);
  assert.equal(merchant.omitted, 1);
  const places = await importCsv('Date,Description,Name\n2026-06-14,Lunch at the counter,Cafe One\n2026-06-14,,Beach\n2026-06-14,A note only,');
  assert.deepEqual(places.stops.map(stop => stop.name), ['Cafe One', 'Beach']);
  assert.equal(places.omitted, 1);
  assert.equal((await importCsv('Date,Name\n2026-06-14,Markthal')).stops[0].name, 'Markthal');
  assert.equal((await importCsv('Date,Transaction Date,Merchant\n2026-06-16,2026-06-14,Markthal')).stops[0].date, '2026-06-14');
});

await test('photo metadata imports reuse fixed daily pins across batches and retries', () => {
  const trip = sample();
  trip.stops = [];
  const photo = (ref: string, northMeters: number, date = trip.start) => ({
    name: 'Photo location', date, xy: [northMeters / 111195, 4], sources: ['photo'], refs: [ref]
  });
  const first = photo('p1', 0);
  const nearby = photo('p2', 95);
  assert.deepEqual(mergeStops(trip, [first, nearby]), { added: 1, linked: 1, skipped: 0 });
  assert.deepEqual(trip.stops[0].xy, first.xy);
  assert.equal(mergeStops(trip, [nearby]).skipped, 1);
  assert.equal(mergeStops(trip, [{ ...nearby, refs: ['p2', 'p3'] }]).linked, 1);
  assert.deepEqual(trip.stops[0].refs, ['p1', 'p2', 'p3']);
  assert.equal(mergeStops(trip, [photo('beyond-anchor', 105), photo('far', 500)]).added, 2);
  assert.equal(mergeStops(trip, [photo('another-day', 0, trip.end)]).added, 1);
});

await test('earliest capture wins for an unsorted batch and for a later import within the same minute', () => {
  const trip = sample();
  trip.stops = [];
  const photo = (ref: string, seconds: number, northMeters: number) => ({
    date: trip.start, name: 'Camera pin', captureTime: '14:00:' + String(seconds),
    xy: [northMeters / 111195, 4], refs: [ref], sources: ['photo']
  });
  const early = photo('early', 20, 0);
  const late = photo('late', 50, 70);
  mergeStops(trip, [late, early]);
  assert.deepEqual(trip.stops[0].xy, early.xy);
  const earliest = photo('earliest', 10, -80);
  assert.equal(mergeStops(trip, [earliest]).linked, 1);
  const restored = cleanTrip(trip);
  assert.equal(restored.stops[0].captureTime, '14:00:10');
  assert.deepEqual(restored.stops[0].xy, earliest.xy);
  assert.equal(mergeStops(restored, [earliest]).skipped, 1);
  assert.equal(mergeStops(restored, [photo('outside-original-radius', 30, -160)]).added, 1);
});
