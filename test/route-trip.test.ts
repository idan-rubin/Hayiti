import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';

await test('route adapter defaults to walking, reuses equivalent explicit walks, and checks taxi directions', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    assert.equal(url.searchParams.get('radiuses'), url.pathname.startsWith('/foot/') ? '150;150' : '100;100');
    assert.equal(url.searchParams.get('steps'), 'true');
    assert.equal(url.searchParams.get('geometries'), 'geojson');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.includes('no-route')) {
      res.writeHead(400).end(JSON.stringify({ code: 'NoRoute' }));
      return;
    }
    res.end(JSON.stringify({ code: 'Ok', routes: [{
      distance: 158,
      geometry: { type: 'LineString', coordinates: [[4, 51], [4.0005, 51.0005], [4.001, 51.001]] },
      legs: [{ steps: [{ mode: 'walking' }] }]
    }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const root = 'http://127.0.0.1:' + address.port;
  const leg = { a: 'a', b: 'b', from: [51, 4], to: [51.001, 4.001] };
  async function run(drivePath: string) {
    const days = [{ date: '2026-07-01', legs: [leg, { ...leg, a: 'b', b: 'c', type: 'taxi' }] },
      { date: '2026-07-02', legs: [{ ...leg, a: 'd', b: 'e', type: 'walk' }] }];
    const child = spawn(process.execPath, ['scripts/route-trip.ts'], {
      env: { ...process.env, HAYITI_WALK_ROUTE_URL: root + '/foot', HAYITI_DRIVE_ROUTE_URL: root + drivePath }
    });
    const result = Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
    child.stdin.end(JSON.stringify({ tripId: 'test-trip', days }));
    return result;
  }
  try {
    const [[code], out, err] = await run('/no-route');
    assert.equal(code, 0);
    const pkg = JSON.parse(out);
    assert.equal(pkg.format, 'hayiti-routes/1');
    assert.equal(pkg.tripId, 'test-trip');
    assert.equal(pkg.days.length, 2);
    assert.equal(pkg.days[0].routes.length, 1);
    assert.equal(pkg.days[0].routes[0].type, 'walk');
    assert.deepEqual(pkg.days[1].routes[0], {
      a: 'd', b: 'e', type: 'walk', m: 158, line: [[51, 4], [51.0005, 4.0005], [51.001, 4.001]]
    });
    assert.deepEqual(requests, ['/foot/4,51;4.001,51.001', '/no-route/4,51;4.001,51.001']);
    assert.match(err, /Keeping existing route/);
    const [[errorCode], partial, error] = await run('/wrong-mode');
    assert.equal(errorCode, 1);
    assert.equal(partial, '');
    assert.match(error, /driving profile/);
  } finally {
    server.close();
  }
});

await test('route adapter preserves long rides and their turns and leaves out a leg that takes a ferry', async () => {
  const last = 51 + 1499 * 0.00009;
  // Point 500 is the only turn in this 1,001-point path. Sampling by index drops it.
  const bend = [4.01, 51];
  const turning = [
    ...Array.from({ length: 500 }, (_, i) => [4 + i * 0.000018, 51]),
    bend,
    ...Array.from({ length: 500 }, (_, i) => [4.01, 51.001 + i * 0.000018])
  ];
  const turnsEnd = turning[turning.length - 1];
  const loop = [...Array.from({ length: 1100 }, (_, i) => [4 + i * 0.00001, 51 + (i % 2) * 0.0001]), [4, 51]];
  const fixtures = new Map([
    ['4.001,51.001', { distance: 158, coordinates: [[4, 51], [4.001, 51.001]], modes: ['walking', 'ferry', 'walking'] }],
    ['4,' + last, { distance: 15000, coordinates: Array.from({ length: 1500 }, (_, i) => [4, 51 + i * 0.00009]), modes: ['driving'] }],
    [turnsEnd.join(','), { distance: 1820, coordinates: turning, modes: ['driving'] }],
    ['4,51', { distance: 12900, coordinates: loop, modes: ['driving'] }]
  ]);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const fixture = fixtures.get(pathname.split(';')[1]);
    assert.ok(fixture);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 'Ok', routes: [{
      distance: fixture.distance,
      geometry: { type: 'LineString', coordinates: fixture.coordinates },
      legs: [{ steps: fixture.modes.map(mode => ({ mode })) }]
    }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const root = 'http://127.0.0.1:' + address.port;
  try {
    const child = spawn(process.execPath, ['scripts/route-trip.ts'], {
      env: { ...process.env, HAYITI_WALK_ROUTE_URL: root + '/foot', HAYITI_DRIVE_ROUTE_URL: root + '/driving' }
    });
    const result = Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
    child.stdin.end(JSON.stringify({ tripId: 'test-trip', days: [{ date: '2026-07-01', legs: [
      { a: 'pier', b: 'island', type: 'walk', from: [51, 4], to: [51.001, 4.001] },
      { a: 'hotel', b: 'airport', type: 'taxi', from: [51, 4], to: [last, 4] },
      { a: 'depot', b: 'station', type: 'taxi', from: [51, 4], to: [turnsEnd[1], turnsEnd[0]] },
      { a: 'depart', b: 'return', type: 'taxi', from: [51, 4], to: [51, 4] }
    ] }] }));
    const [[code], out, err] = await result;
    assert.equal(code, 0);
    const routes = JSON.parse(out).days[0].routes;
    assert.equal(routes.length, 3);
    assert.deepEqual(routes.slice(0, 2), [
      { a: 'hotel', b: 'airport', type: 'taxi', m: 15000, line: [[51, 4], [last, 4]] },
      { a: 'depot', b: 'station', type: 'taxi', m: 1820, line: [[51, 4], [bend[1], bend[0]], [turnsEnd[1], turnsEnd[0]]] }
    ]);
    const winding = routes[2];
    assert.equal(winding.line.length, 1000);
    assert.equal(winding.m, 12900);
    assert.deepEqual(winding.line[0], [51, 4]);
    assert.deepEqual(winding.line.at(-1), [51, 4]);
    assert.ok(winding.line.some(([lat]: [number, number]) => lat > 51));
    assert.match(err, /Keeping existing route for 2026-07-01 pier → island/);
  } finally {
    server.close();
  }
});
