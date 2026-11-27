import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Point } from '../src/domain/core.ts';
import { projectMapPoints, wrapLongitude } from '../src/web/map-longitudes.ts';

await test('a day in Fiji and Samoa fits across the date line, keeping pins and route bends together', () => {
  const fiji: Point = [-17.77, 178], samoa: Point = [-13.83, -172];
  const display = projectMapPoints([fiji, samoa]);
  const line: Point[] = [fiji, [-16, 179], [-15, -179], samoa];
  const plotted = line.map(display);
  assert.deepEqual(plotted.map(point => point[1]), [-182, -181, -179, -172]);
  assert.deepEqual([plotted[0], plotted.at(-1)], [display(fiji), display(samoa)]);
  assert.deepEqual(line.map(point => point[1]), [178, 179, -179, -172]);
  assert.equal(wrapLongitude(plotted[0][1]), fiji[1]);
});

await test('ordinary trips retain their coordinates and east and west 180 represent the same pin', () => {
  const london: Point = [51.51, -0.12], paris: Point = [48.86, 2.35];
  for (const points of [[], [london], [paris, london]]) {
    assert.equal(projectMapPoints(points)(london), london);
  }
  const display = projectMapPoints([[0, 180], [0, -180]]);
  assert.deepEqual(display([0, 180]), display([0, -180]));
  assert.equal(wrapLongitude(34.77), 34.77);
  assert.equal(wrapLongitude(541), -179);
  assert.equal(wrapLongitude(-541), 179);
});
