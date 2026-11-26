import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameIn, prepareStyle } from '../src/web/street-map.ts';

await test('the street map style gets place names in the journal language, flat buildings and no points of interest', () => {
  const style = {
    version: 8,
    layers: [
      { id: 'land', type: 'background' },
      { id: 'building-3d', type: 'fill-extrusion' },
      { id: 'poi_transit', type: 'symbol', 'source-layer': 'poi', layout: { 'text-field': ['get', 'name'] } },
      { id: 'road-number', type: 'symbol', layout: { 'text-field': ['get', 'ref'] } },
      { id: 'place', type: 'symbol', layout: { 'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']] } },
      { id: 'street', type: 'symbol', layout: { 'text-field': '{name:latin} {name:nonlatin}' } },
      { id: 'icon-only', type: 'symbol', layout: { 'icon-image': 'bus' } }
    ]
  };
  assert.deepEqual(prepareStyle(style, 'he'), ['place', 'street']);
  assert.deepEqual(style.layers.map(layer => layer.id), ['land', 'road-number', 'place', 'street', 'icon-only']);
  assert.deepEqual(style.layers[2].layout, { 'text-field': ['coalesce', ['get', 'name:he'], ['get', 'name']] });
  assert.deepEqual(style.layers[3].layout, { 'text-field': ['coalesce', ['get', 'name:he'], ['get', 'name']] });
  assert.deepEqual(style.layers[1].layout, { 'text-field': ['get', 'ref'] });
});

await test('English place names fall back to a Latin-script name before the local one', () => {
  assert.deepEqual(nameIn('en'), ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']]);
});

await test('a reply that is not a map style is refused', () => {
  assert.throws(() => prepareStyle({ error: 'not found' }, 'en'));
  assert.throws(() => prepareStyle(null, 'en'));
});
