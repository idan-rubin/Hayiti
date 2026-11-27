import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isRecord } from '../src/domain/core.ts';
import { journalSchemaVersion } from '../src/domain/journal-schema.ts';
import { journalAPI } from '../src/server/journal-api.ts';
import { loadState, storeState } from '../src/server/storage.ts';
import { MemoryBucket } from './memory-bucket.ts';

const raw = readFileSync(new URL('./fixtures/journal-v1.json', import.meta.url), 'utf8');
const fixture = JSON.parse(raw) as { schemaVersion: number; trips: unknown[] };
const owner = 'historical-traveler', key = 'journal/' + owner;

function assertRetained(actual: unknown, expected: unknown, path = 'journal') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((value, index) => assertRetained(actual[index], value, path + '[' + index + ']'));
  } else if (isRecord(expected)) {
    assert.ok(isRecord(actual), path);
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, name), path + '.' + name + ' must survive migration');
      assertRetained(actual[name], value, path + '.' + name);
    }
  } else assert.deepEqual(actual, expected, path);
}

async function loadPublishedV1(bucket: MemoryBucket) {
  try { return await loadState(bucket, owner); }
  catch (error) {
    assert.fail('Published schema v1 must remain readable. Add an explicit v1 reader or migration before raising journalSchemaVersion; do not merely accept every older version. Cause: ' + String(error));
  }
}

await test('the literal published v1 journal remains readable and retains its metadata through a current save', async () => {
  assert.equal(fixture.schemaVersion, 1);
  const bucket = new MemoryBucket();
  const seeded = await bucket.put(key, raw);
  assert.ok(seeded);
  const loaded = await loadPublishedV1(bucket);
  assert.equal(loaded.rev, seeded.etag);
  assertRetained(loaded.trips, fixture.trips);
  const changed = loaded.trips.map(trip => ({ ...trip, title: 'Renamed by the current app' }));
  const rev = await storeState(bucket, owner, changed, loaded.rev);
  const expected = structuredClone(fixture.trips);
  assert.ok(isRecord(expected[0]));
  expected[0].title = 'Renamed by the current app';
  const saved = await loadState(bucket, owner);
  assert.equal(saved.rev, rev);
  assertRetained(saved.trips, expected);
  const stored: unknown = JSON.parse(await (await bucket.get(key))!.text());
  assert.ok(isRecord(stored));
  assert.equal(stored.schemaVersion, journalSchemaVersion);
  assertRetained(stored.trips, expected);
});

await test('a literal v1 full-save client cannot overwrite a later journal schema', async () => {
  const bucket = new MemoryBucket();
  await bucket.put(key, raw);
  const loaded = await loadPublishedV1(bucket);
  const rev = await storeState(bucket, owner, loaded.trips, loaded.rev);
  const before = await (await bucket.get(key))!.text();
  const response = await journalAPI(new Request('https://journal.example/api/journal', {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://journal.example' },
    body: JSON.stringify({ schemaVersion: 1, trips: fixture.trips, rev })
  }), bucket, 'web', owner);
  assert.equal(response.status, journalSchemaVersion === 1 ? 200 : 426);
  if (journalSchemaVersion !== 1) {
    assert.match((await response.json()).error, /reload/i);
    assert.equal((await bucket.get(key))?.etag, rev);
    assert.equal(await (await bucket.get(key))!.text(), before);
  } else assertRetained((await loadState(bucket, owner)).trips, fixture.trips);
});
