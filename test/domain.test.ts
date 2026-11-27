import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip, mergeGooglePins, mergeStops, safeDate } from '../src/domain/core.ts';
import { shareableTrip } from '../src/domain/share-format.ts';
import { importCsv, importEvidencePackage, importIcs } from '../src/domain/importers.ts';
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

await test('synthetic home routes survive a backup and are shared only when the home base is included', () => {
  const trip = sample();
  const destination = trip.stops[0].id;
  trip.homeXY = [51.92, 4.48];
  const homeEdge = { a: 'base', b: destination, type: 'walk' as const, m: 120, line: [trip.homeXY, [51.921, 4.48]] };
  const restored = cleanTrip({ ...trip, edges: [homeEdge, { ...homeEdge, a: 'missing' }, { ...homeEdge, b: 'missing' }] });
  assert.deepEqual(restored.edges, [homeEdge]);
  assert.equal(cleanTrip(shareableTrip(restored, true)).edges.length, 1);
  assert.equal(cleanTrip(shareableTrip(restored, false)).edges.length, 0);
  assert.equal(cleanTrip({ ...restored, homeXY: null }).edges.length, 0);
});

await test('a pin the traveler timed or placed keeps collecting photos and stays where they put it', () => {
  const trip = sample();
  trip.stops = [];
  const photo = (ref: string, time: string, northMeters: number) => ({
    date: trip.start, name: 'Camera pin', time, xy: [northMeters / 111195, 4], refs: [ref], sources: ['photo']
  });
  const first = photo('first', '14:00', 0);
  mergeStops(trip, [first]);
  // What the stop form saves when the traveler changes the time and moves the pin.
  const placed = [30 / 111195, 4.0001];
  Object.assign(trip.stops[0], { time: '14:30', xy: placed, edited: true });
  assert.equal(mergeStops(trip, [first]).skipped, 1);
  assert.equal(mergeStops(trip, [photo('earlier', '13:50', 60)]).linked, 1);
  const saved = cleanTrip(trip).stops[0];
  assert.deepEqual([saved.time, saved.xy, saved.refs, saved.edited], ['14:30', placed, ['first', 'earlier'], true]);
});

await test('a photo retry follows its stable reference to the corrected day', () => {
  const trip = sample();
  trip.stops = [];
  const photo = { date: trip.start, name: 'Camera pin', time: '10:00', xy: [0, 4], sources: ['photo'], refs: ['asset'] };
  mergeStops(trip, [photo]);
  const corrected = trip.stops[0];
  Object.assign(corrected, { date: trip.end, time: '12:00', xy: [0.001, 4], edited: true });
  const batch = [{ ...photo, refs: ['related', 'asset'] }, { ...photo, refs: ['related'] }];
  assert.deepEqual(mergeStops(trip, batch), { added: 0, linked: 1, skipped: 1 });
  assert.deepEqual(mergeStops(trip, batch), { added: 0, linked: 0, skipped: 2 });
  const attached = { ...photo, photos: ['data:image/jpeg;base64,/9j/AAAA'], refs: ['asset', 'attachment-ref'] };
  assert.deepEqual(mergeStops(trip, [attached, { ...photo, xy: null, refs: ['attachment-ref'] }]), { added: 0, linked: 1, skipped: 1 });
  assert.equal(trip.stops.length, 1);
  assert.deepEqual([corrected.date, corrected.time, corrected.xy, corrected.refs], [trip.end, '12:00', [0.001, 4], ['asset', 'related', 'attachment-ref']]);
  assert.equal(mergeStops(trip, [{ ...photo, xy: corrected.xy, refs: ['different-asset'] }]).added, 1);
});

await test('a time without seconds never displaces a capture recorded to the second', () => {
  const trip = sample();
  trip.stops = [];
  const pin = { date: trip.start, name: 'Camera pin', sources: ['photo'] };
  const precise = { ...pin, captureTime: '14:00:10', xy: [0, 4], refs: ['precise'] };
  const nearby = [50 / 111195, 4];
  mergeStops(trip, [precise]);
  assert.equal(mergeStops(trip, [{ ...pin, time: '14:00', xy: nearby, refs: ['same-minute'] }]).linked, 1);
  assert.deepEqual([trip.stops[0].captureTime, trip.stops[0].xy], ['14:00:10', precise.xy]);
  assert.equal(mergeStops(trip, [{ ...pin, time: '13:59', xy: nearby, refs: ['minute-before'] }]).linked, 1);
  assert.deepEqual([trip.stops[0].time, trip.stops[0].captureTime, trip.stops[0].xy], ['13:59', undefined, nearby]);
});

await test('a pin that an earlier photo moves gives up the routes saved to its old place', () => {
  const trip = sample();
  trip.stops = [];
  const photo = (ref: string, seconds: number, northMeters: number) => ({
    date: trip.start, name: 'Camera pin', captureTime: '14:00:' + String(seconds),
    xy: [northMeters / 111195, 4], refs: [ref], sources: ['photo']
  });
  mergeStops(trip, [{ id: 'pin', ...photo('late', 50, 0) }, { id: 'far', ...photo('far', 55, 900) }]);
  trip.edges = [{ a: 'pin', b: 'far', type: 'walk', m: 900, line: [[0, 4], [900 / 111195, 4]] }];
  assert.equal(mergeStops(trip, [photo('earlier-same-spot', 40, 0)]).linked, 1);
  assert.equal(trip.edges.length, 1);
  assert.equal(mergeStops(trip, [photo('earliest', 30, 90)]).linked, 1);
  assert.deepEqual(trip.edges, []);
});

await test('a shared route that hides the home base also hides photos taken around it', () => {
  const trip = sample();
  trip.stops = [];
  trip.homeXY = [51.92, 4.48];
  const around = (northMeters: number) => [51.92 + northMeters / 111195, 4.48];
  const photo = (ref: string, northMeters: number) => ({
    date: trip.start, name: 'Camera pin', xy: around(northMeters), refs: [ref], sources: ['photo']
  });
  mergeStops(trip, [photo('by-the-door', 50), photo('down-the-road', 400)]);
  assert.equal(shareableTrip(trip, true).stops.length, 2);
  assert.deepEqual(shareableTrip(trip, false).stops.map(stop => stop.xy), [around(400)]);
});

await test('near-home photo pins and their routes stay private after attaching an image or linking a purchase', () => {
  const date = '2026-07-01';
  const nearHome = { date, xy: [51.9205, 4.48] };
  const trip = cleanTrip({
    start: date, end: date, homeXY: [51.92, 4.48],
    stops: [
      { ...nearHome, id: 'photo', name: 'Camera pin', sources: ['photo'], refs: ['capture'], photos: ['data:image/jpeg;base64,/9j/AAAA'] },
      { ...nearHome, id: 'purchase', name: 'Photo and purchase', sources: ['card', 'photo'], refs: ['charge', 'capture-2'], count: 1 },
      { ...nearHome, id: 'cafe', name: 'Café', sources: ['card'] },
      { date, id: 'museum', name: 'Museum', xy: [51.93, 4.48], sources: ['photo'] }
    ],
    edges: [
      { a: 'cafe', b: 'photo', type: 'walk' },
      { a: 'purchase', b: 'museum', type: 'walk' },
      { a: 'cafe', b: 'museum', type: 'walk' }
    ]
  });
  const shared = shareableTrip(trip, false);
  assert.deepEqual(shared.stops.map(stop => stop.name), ['Café', 'Museum']);
  const [cafe, museum] = shared.stops;
  assert.deepEqual(shared.edges.map(edge => [edge.a, edge.b]), [[cafe.id, museum.id]]);
  const withHome = shareableTrip(trip, true);
  assert.equal(withHome.stops.length, 4);
  assert.equal(withHome.edges.length, 3);
});

await test('Google Pins preserve source precision and only infer a verified local trip day', () => {
  const trip = sample();
  const pin = { id: 'place-1', name: 'Park', xy: [51.91, 4.48] };
  const batch = [
    { ...pin, savedAt: trip.start + 'T00:01:00+02:00' },
    { ...pin, id: 'date-only', savedAt: trip.start },
    { ...pin, id: 'utc', savedAt: trip.start + 'T23:45:00Z' },
    { ...pin, id: 'utc-offset', savedAt: trip.start + 'T23:45:00+00:00' },
    { ...pin, id: 'converted', savedAt: trip.start + 'T23:45:00Z', date: trip.end },
    { ...pin, id: 'planned-before', savedAt: '2025-12-01' },
    { ...pin, id: 'unknown' }
  ];
  const before = routeStops(trip, trip.start);
  assert.deepEqual(mergeGooglePins(trip, batch), { added: 7, linked: 0, skipped: 0 });
  assert.deepEqual(trip.googlePins?.map(item => item.date), [trip.start, trip.start, undefined, undefined, trip.end, undefined, undefined]);
  assert.deepEqual(trip.googlePins?.map(item => item.savedAt), batch.map(item => 'savedAt' in item ? item.savedAt : undefined));
  assert.deepEqual(mergeGooglePins(trip, batch), { added: 0, linked: 0, skipped: 7 });
  assert.deepEqual(routeStops(trip, trip.start), before);
  assert.deepEqual(cleanTrip(trip).googlePins, trip.googlePins);
  assert.equal(Object.hasOwn(shareableTrip(trip, true), 'googlePins'), false);
});

await test('retrying a Google Pin can supply missing facts and preserves an explicitly cleared day', () => {
  const trip = sample();
  const pin = { id: 'place', name: 'Park', xy: [51.91, 4.48] };
  mergeGooglePins(trip, [pin]);
  assert.equal(mergeGooglePins(trip, [{ ...pin, date: trip.end }]).linked, 1);
  const saved = trip.googlePins?.[0];
  assert.ok(saved);
  saved.dayEdited = true;
  delete saved.date;
  assert.equal(mergeGooglePins(trip, [{ ...pin, savedAt: trip.start }]).linked, 1);
  const restored = cleanTrip(trip);
  assert.deepEqual(restored.googlePins, [{ ...pin, savedAt: trip.start, dayEdited: true }]);
  assert.equal(mergeGooglePins(restored, [{ ...pin, date: trip.start }]).skipped, 1);
  assert.equal(restored.googlePins?.[0].date, undefined);
});

await test('invalid Google Pin batches are atomic and an older trip does not acquire pins on load', () => {
  const trip = sample();
  const pin = { id: 'park', name: 'Park', xy: [51.91, 4.48] };
  for (const invalid of [
    { ...pin, xy: [400, 2] }, { ...pin, id: '' }, { ...pin, name: '' },
    { ...pin, date: '2026-02-31' }, { ...pin, savedAt: '2026-02-31T12:00:00Z' },
    { ...pin, savedAt: '2026-06-14T23:50:00' }
  ]) {
    assert.throws(() => mergeGooglePins(trip, [pin, invalid]));
    assert.equal(trip.googlePins, undefined);
  }
  assert.throws(() => cleanTrip({ ...trip, googlePins: [pin, pin] }));
  assert.equal(Object.hasOwn(cleanTrip(trip), 'googlePins'), false);
});

await test('portable evidence packages preview Google Pins without changing stops or bookmarks', () => {
  const trip = sample();
  const item = { id: 'gallery', name: 'Gallery', xy: [51.91, 4.48] };
  mergeGooglePins(trip, [item]);
  const before = structuredClone(trip);
  const data = {
    format: 'hayiti-stops/1', tripId: trip.id, start: trip.start, end: trip.end,
    stops: [trip.stops[0]], googlePins: [{ ...item, savedAt: trip.start }], sourceChecks: { gmail: 'checked' }
  };
  const preview = importEvidencePackage(data, trip);
  assert.deepEqual(preview.stops, data.stops);
  assert.deepEqual(preview.checks, data.sourceChecks);
  assert.deepEqual(preview.googlePins, data.googlePins);
  assert.deepEqual(importEvidencePackage({ format: 'masluli-stops/1', stops: [] }, trip).stops, []);
  assert.throws(() => importEvidencePackage({ ...data, googlePins: [...data.googlePins, { xy: [0, 0] }] }, trip));
  assert.throws(() => importEvidencePackage({ ...data, stops: [{}] }, trip));
  assert.throws(() => importEvidencePackage({ ...data, tripId: 'another-trip' }, trip));
  assert.deepEqual(trip, before);
  assert.deepEqual(mergeGooglePins(trip, preview.googlePins ?? []), { added: 0, linked: 1, skipped: 0 });
  assert.equal(trip.googlePins?.[0].date, trip.start);
});

await test('sending a saved Google Pin again corrects its name and location and keeps the traveler’s day', () => {
  const trip = sample();
  const wrong = { id: 'place', name: 'Café (wrong branch)', xy: [51.95, 4.5] };
  mergeGooglePins(trip, [wrong]);
  const saved = trip.googlePins?.[0];
  assert.ok(saved);
  Object.assign(saved, { date: trip.end, dayEdited: true });
  const right = { id: 'place', name: 'Café', xy: [51.91, 4.48], date: trip.start };
  assert.deepEqual(mergeGooglePins(trip, [right]), { added: 0, linked: 1, skipped: 0 });
  assert.deepEqual(trip.googlePins, [{ id: 'place', name: 'Café', xy: [51.91, 4.48], date: trip.end, dayEdited: true }]);
  assert.deepEqual(mergeGooglePins(trip, [right]), { added: 0, linked: 0, skipped: 1 });
});

await test('a Google Pin with no known location is refused, and a day outside the trip is reported', () => {
  const trip = sample();
  const pin = { id: 'park', name: 'Park', xy: [51.91, 4.48] };
  // Google's export writes [0, 0] when it does not know where a place is.
  assert.throws(() => mergeGooglePins(trip, [pin, { id: 'nowhere', name: 'Unknown place', xy: [0, 0] }]), /no known location/);
  assert.equal(trip.googlePins, undefined);
  assert.deepEqual(mergeGooglePins(trip, [{ ...pin, date: '2019-01-01' }, { ...pin, id: 'planned', savedAt: '2019-01-01' }]),
    { added: 2, linked: 0, skipped: 0, datesOutsideTrip: 1 });
  assert.deepEqual(cleanTrip(trip).googlePins?.map(item => item.date), [undefined, undefined]);
  // A journal that already holds such a pin still opens.
  assert.equal(cleanTrip({ ...trip, googlePins: [{ id: 'nowhere', name: 'Unknown place', xy: [0, 0] }] }).googlePins?.length, 1);
});
