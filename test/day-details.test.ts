import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { dayDetails, routeStops, walkingStats } from '../src/domain/daily-route.ts';

await test('an unpinned starting point remains editable among day details without becoming a route stop', () => {
  const date = '2026-06-14';
  const trip = cleanTrip({
    id: 'starting-point', title: 'A day out', start: date, end: date,
    stops: [
      { id: 'hotel', name: 'Hotel', date, kind: 'origin' },
      { id: 'purchase', name: 'Market', date, kind: 'visit' },
      { id: 'park', name: 'Park', date, xy: [51.9, 4.4] }
    ]
  });
  assert.deepEqual(dayDetails(trip, date).map(stop => stop.id), ['hotel', 'purchase']);
  const route = routeStops(trip, date);
  assert.deepEqual(route.map(stop => stop.id), ['park']);
  assert.equal(walkingStats(route, new Map()).stopCount, 1);
});
