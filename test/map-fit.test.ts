import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitPadding } from '../src/web/map-fit.ts';

await test('a roomy map keeps the covered edges and the margin clear', () => {
  assert.deepEqual(fitPadding(900, 70, 0, 36), [106, 36]);
  assert.deepEqual(fitPadding(844, 120, 520, 18), [138, 538]);
});

await test('a phone on its side still leaves the route room when the bar and the sheet cover most of the map', () => {
  // 375 pixels high: the bar and the map style cover 114, and the sheet with the legend above it covers 264.
  const [top, bottom] = fitPadding(375, 114, 264, 18);
  assert.ok(top > 0 && bottom > 0);
  assert.ok(375 - top - bottom >= 48, 'the route keeps a strip of the map');
  // Each edge gives way in proportion to what covers it.
  assert.ok(bottom > top * 2);
});

await test('a map smaller than the room a route needs is fitted edge to edge', () => {
  assert.deepEqual(fitPadding(40, 40, 40, 18), [0, 0]);
  assert.deepEqual(fitPadding(0, 10, 10, 18), [0, 0]);
});
