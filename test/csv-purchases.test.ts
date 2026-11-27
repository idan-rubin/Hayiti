import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importCsv } from '../src/domain/importers.ts';

await test('Chase-style exports retain descriptions and transaction dates across retries', async () => {
  const csv = [
    'Transaction Date,Post Date,Description,Amount',
    '11/14/2026,11/15/2026,Canal Bakery,-12.50',
    '11/14/2026,11/16/2026,Harbor Books,-18.00',
    '11/14/2026,11/17/2026,Canal Bakery,-12.50'
  ].join('\n');
  const imported = await importCsv(csv);
  assert.equal(imported.omitted, 0);
  assert.deepEqual(imported.stops.map(stop => [stop.name, stop.date]), [
    ['Canal Bakery', '2026-11-14'], ['Harbor Books', '2026-11-14'], ['Canal Bakery', '2026-11-14']
  ]);
  assert.deepEqual(imported.stops.map(stop => stop.refs), (await importCsv(csv)).stops.map(stop => stop.refs));
  assert.notDeepEqual(imported.stops[0].refs, imported.stops[2].refs);
});

await test('coordinates or an address keep statement purchases as visits in English and Hebrew exports', async () => {
  const english = await importCsv([
    'Transaction Date,Post Date,Merchant,Description,Amount,Address,Latitude,Longitude',
    '2026-11-14,2026-11-15,Canal Bakery,BANK DESCRIPTOR,-12.50,,51.92,4.48',
    '2026-11-14,2026-11-15,Harbor Books,BANK DESCRIPTOR,-18.00,12 Harbor Street,,'
  ].join('\n'));
  assert.deepEqual(english.stops.map(stop => [stop.name, stop.kind, stop.xy, stop.address]), [
    ['Canal Bakery', 'visit', [51.92, 4.48], ''], ['Harbor Books', 'visit', null, '12 Harbor Street']
  ]);
  assert.doesNotMatch(JSON.stringify(english.stops), /BANK DESCRIPTOR/);
  const hebrew = await importCsv([
    'תאריך עסקה,שם בית העסק,סכום עסקה,כתובת,קו רוחב,קו אורך',
    '14/11/2026,חנות ספרים,18,,32.06,34.77',
    '14/11/2026,מאפייה,12,רחוב הנמל 12,,'
  ].join('\n'));
  assert.deepEqual(hebrew.stops.map(stop => [stop.name, stop.kind]), [['חנות ספרים', 'visit'], ['מאפייה', 'visit']]);
});

await test('location evidence does not override an online channel and invalid coordinates do not confirm attendance', async () => {
  const result = await importCsv([
    'Transaction Date,Merchant,Amount,Payment Channel,Address,Latitude,Longitude',
    '2026-11-14,Online Books,18,online,12 Harbor Street,51.92,4.48',
    '2026-11-14,Unlocated Books,18,,,,',
    '2026-11-14,Invalid Pin,18,,,500,4.48',
    '2026-11-14,,18,card present,,,'
  ].join('\n'));
  assert.deepEqual(result.stops.map(stop => [stop.name, stop.kind, stop.xy]), [
    ['Online Books', 'remote', [51.92, 4.48]], ['Unlocated Books', 'uncertain', null],
    ['Invalid Pin', 'uncertain', null], ['Unidentified merchant', 'visit', null]
  ]);
});

await test('a posting-date-only statement falls back to Description while generic Name stays private', async () => {
  const imported = await importCsv('Date,Post Date,Description,Name\n2026-11-14,2026-11-15,Canal Bakery,Account holder');
  assert.deepEqual(imported.stops.map(stop => [stop.name, stop.kind]), [['Canal Bakery', 'uncertain']]);
  assert.doesNotMatch(JSON.stringify(imported.stops), /Account holder/);
  const unknown = await importCsv('Date,Post Date,Name\n2026-11-14,2026-11-15,Account holder');
  assert.deepEqual(unknown.stops.map(stop => [stop.name, stop.kind]), [['Unidentified merchant', 'uncertain']]);
});
