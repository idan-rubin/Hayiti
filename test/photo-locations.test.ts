import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTrip } from '../src/domain/core.ts';
import { photoHeader, photoVisits, savePhotoVisit } from '../src/domain/photo-locations.ts';

await test('photos corroborate one visit, preserve a later return, and are safe to import twice', () => {
  const date = '2026-06-01';
  const trip = cleanTrip({ start: date, end: date, stops: [{ date, name: 'Cafe', xy: [51, 4], time: '09:00', sources: ['card'] }] });
  const raw = [photoHeader, ...['09:05|51|4', '09:07|51.0001|4', '12:00|51|4', '13:00||'].map(v => date + '|' + v)].join('\n');
  const { visits, omitted } = photoVisits(raw, trip, 'Photo location');
  assert.equal(omitted, 1);
  assert.equal(visits.length, 2);
  for (const visit of [...visits, ...visits]) savePhotoVisit(trip, visit);
  assert.equal(trip.stops.length, 2);
  assert.deepEqual(trip.stops[0].sources, ['card', 'photo']);
  assert.equal(trip.stops[0].time, '09:00');
});
