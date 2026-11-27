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
