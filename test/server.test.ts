import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { cleanTrip, reportSources, reportStates, validOutcome } from '../src/domain/core.ts';
import { routeStops } from '../src/domain/daily-route.ts';
import { handleRequest } from '../src/server/app.ts';
import { loadState, storeState } from '../src/server/storage.ts';
import { MemoryBucket } from './memory-bucket.ts';
const base = 'https://maps.example',
  companion = 'https://journal.example';
function fixture() {
  const env = {
    BUCKET: new MemoryBucket(),
    PUBLISHER_ORIGIN: base,
    RELAY_ORIGIN: companion,
    HAYITI_SHARE_RELAY: crypto.randomUUID()
  };
  const trip = cleanTrip(JSON.parse(readFileSync(new URL('./fixtures/rotterdam.json', import.meta.url), 'utf8')).trip);
  function dispatch(request: Request, user: string | null) {
    return handleRequest(request, env, user, () => Promise.resolve(new Response(null, {
      status: 404
    })));
  }
  function post(path: string, body: unknown, user: string | null, site = base, origin = site) {
    return dispatch(new Request(site + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin
      },
      body: JSON.stringify(body)
    }), user);
  }
  function tool(name: string, args: unknown, user: string | null = 'alice') {
    return post('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args
      }
    }, user);
  }
  return {
    env,
    trip,
    post,
    dispatch,
    tool
  };
}
await test('a trip created in chat starts each day at the supplied home base', async () => {
  const { tool, trip, env } = fixture();
  const homeXY = [51.92, 4.48];
  const created = await (await tool('add_trip_stops', {
    tripId: trip.id, start: trip.start, end: trip.end, title: trip.title,
    home: 'Guesthouse', homeXY, stops: []
  })).json();
  assert.ok(!created.result.isError);
  const journal = await loadState(env.BUCKET, 'alice');
  const [origin] = routeStops(journal.trips[0], trip.end);
  assert.equal(origin.kind, 'origin');
  assert.equal(origin.name, 'Guesthouse');
  assert.deepEqual(origin.xy, homeXY);
});

await test('a home base that cannot be placed is refused, and no trip is saved without its pin', async () => {
  const { tool, trip, env } = fixture();
  // Longitude first: a latitude of 139.69 does not exist.
  const refused = await (await tool('add_trip_stops', {
    tripId: trip.id, start: trip.start, end: trip.end, title: trip.title,
    home: 'Guesthouse', homeXY: [139.69, 35.68], stops: []
  })).json();
  assert.equal(refused.result.isError, true);
  assert.deepEqual((await loadState(env.BUCKET, 'alice')).trips, []);
});

await test('adding stops ignores redundant home coordinates and keeps the existing home', async () => {
  const { tool, trip, env } = fixture();
  const homeXY = [51.92, 4.48];
  await tool('add_trip_stops', {
    tripId: trip.id, start: trip.start, end: trip.end, home: 'Guesthouse', homeXY, stops: []
  });
  const response = await (await tool('add_trip_stops', {
    tripId: trip.id, home: 'Old address', homeXY: [139.69, 35.68], stops: [trip.stops[0]]
  })).json();
  assert.equal(JSON.parse(response.result.content[0].text).added, 1);
  const [saved] = (await loadState(env.BUCKET, 'alice')).trips;
  assert.equal(saved.home, 'Guesthouse');
  assert.deepEqual(saved.homeXY, homeXY);
  assert.deepEqual(saved.stops.map(stop => stop.id), [trip.stops[0].id]);
});

await test('owner-only reads, dated source outcomes, and duplicate writes through the MCP endpoint', async () => {
  const {
    env,
    trip,
    tool
  } = fixture();
  const args = {
    tripId: trip.id,
    title: trip.title,
    start: trip.start,
    end: trip.end,
    stops: trip.stops
  };
  const result = await (await tool('add_trip_stops', args)).json();
  assert.equal(JSON.parse(result.result.content[0].text).added, 2);
  assert.equal(JSON.parse((await (await tool('add_trip_stops', args)).json()).result.content[0].text).skipped, 2);
  assert.equal((await tool('list_trips', {}, null)).status, 401);
  assert.deepEqual(JSON.parse((await (await tool('list_trips', {}, 'bob')).json()).result.content[0].text), []);
  assert.equal((await (await tool('get_day', {
    tripId: trip.id,
    date: trip.start
  }, 'bob')).json()).result.isError, true);
  for (const status of reportStates) {
    const response = await (await tool('add_trip_stops', {
      ...args,
      stops: [],
      sourceChecks: {
        finances: status
      }
    })).json();
    assert.ok(!response.result.isError);
    assert.equal((await loadState(env.BUCKET, 'alice')).trips[0].checks.finances?.status, status);
  }
  assert.equal((await (await tool('add_trip_stops', {
    ...args,
    sourceChecks: {
      gmail: 'no_accounts'
    }
  })).json()).result.isError, true);
});
await test('get_day follows route order and keeps off-route evidence', async () => {
  const { env, tool, trip } = fixture();
  const first = trip.stops[0];
  trip.stops.push(
    { ...first, id: 'hotel', kind: 'origin', rank: 99 },
    { ...first, id: 'online', kind: 'remote', rank: 10 },
    { ...first, id: 'maybe', kind: 'uncertain', rank: 11 },
    { ...first, id: 'tomorrow', date: trip.end }
  );
  await storeState(env.BUCKET, 'alice', [trip], '');
  const response = await (await tool('get_day', { tripId: trip.id, date: trip.start })).json();
  const day = JSON.parse(response.result.content[0].text);
  assert.deepEqual(day.stops.map((stop: { id: string }) => stop.id), ['hotel', 'sample-1', 'sample-2', 'online', 'maybe']);
  assert.equal(day.walking.stopCount, 2);
});

await test('tools/list advertises exactly the source outcomes the server accepts', async () => {
  const { post } = fixture();
  const response = await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).json();
  const add = response.result.tools.find((tool: { name: string }) => tool.name === 'add_trip_stops');
  const properties = add.inputSchema.properties.sourceChecks.properties;
  for (const source of reportSources) {
    assert.deepEqual(properties[source].enum, reportStates.filter(status => validOutcome(source, status)));
  }
});

await test('MCP rejects foreign browser origins and requires JSON before dispatch', async () => {
  const { dispatch } = fixture();
  const discovery = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const origin of ['https://unrelated.example', 'null']) {
    const response = await dispatch(new Request(base + '/mcp', {
      method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(discovery)
    }), 'alice');
    assert.equal(response.status, 403);
  }
  const wrongType = await dispatch(new Request(base + '/mcp', {
    method: 'POST', body: JSON.stringify(discovery)
  }), 'alice');
  assert.equal(wrongType.status, 415);
});
await test('a server-side MCP client can save stops with a host-verified identity', async () => {
  const { env, dispatch, trip } = fixture();
  const response = await dispatch(new Request(base + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'add_trip_stops', arguments: { tripId: trip.id, start: trip.start, end: trip.end, title: trip.title, stops: trip.stops }
    } })
  }), 'alice');
  assert.equal(response.status, 200);
  assert.equal((await loadState(env.BUCKET, 'alice')).trips[0].stops.length, 2);
});
await test('competing edits conflict; request headers alone never establish an identity', async () => {
  const {
    env,
    trip,
    dispatch,
    post
  } = fixture();
  const rev = await storeState(env.BUCKET, 'alice', [trip], '');
  const writes = await Promise.all([1, 2].map(i => post('/api/journal', {
    trips: [{
      ...trip,
      title: 'Revision ' + i
    }],
    rev
  }, 'alice')));
  assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
  assert.equal((await dispatch(new Request(base + '/api/journal', {
    headers: {
      'oai-authenticated-user-id': 'alice'
    }
  }), null)).status, 401);
  assert.equal((await post('/api/journal', {
    trips: [],
    rev
  }, 'alice', base, 'https://unrelated.example')).status, 403);
});
for (const site of [base, companion]) await test('redacted route, isolation, retry and revocation via ' + site, async () => {
  const {
    env,
    trip,
    post,
    dispatch
  } = fixture();
  trip.home = trip.stops[0].name;
  trip.homeXY = trip.stops[0].xy;
  trip.stops[1].notes = 'sensitive note';
  await storeState(env.BUCKET, 'alice', [trip], '');
  async function manage(action: unknown, user = 'alice') {
    const result = await post('/api/route-links', action, user, site);
    if (site === base || !result.ok) return result;
    const {
      relay
    } = await result.json();
    return post('/api/route-links?relay', relay, null, base, companion);
  }
  const id = crypto.randomUUID(),
    create = {
      type: 'create',
      scope: 'day',
      day: trip.start,
      id,
      tripId: trip.id
    };
  const made = await manage(create);
  assert.equal(made.status, 200);
  const {
    url
  } = await made.json();
  assert.equal((await (await manage(create)).json()).url, url);
  const read = () => dispatch(new Request(base + '/api/route-links', {
    headers: {
      'X-Hayiti-View': new URL(url).hash.slice(7)
    }
  }), null);
  const response = await read();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const publicTrip = await response.json();
  assert.equal(publicTrip.stops.length, 1);
  assert.equal(publicTrip.home, '');
  assert.ok(!('refs' in publicTrip.stops[0]));
  assert.ok(!('notes' in publicTrip.stops[0]));
  assert.equal((await manage({
    type: 'revoke',
    id
  }, 'bob')).status, 404);
  assert.equal((await manage({
    type: 'revoke',
    id
  })).status, 200);
  assert.equal((await read()).status, 404);
  assert.equal((await manage(create)).status, 409);
});

await test('list_trips gives an untitled trip a display name without renaming it', async () => {
  const { env, tool, trip } = fixture();
  await tool('add_trip_stops', { tripId: trip.id, start: trip.start, end: trip.end, stops: [] });
  const response = await (await tool('list_trips', {})).json();
  assert.deepEqual(JSON.parse(response.result.content[0].text), [
    { id: trip.id, title: 'My trip', start: trip.start, end: trip.end }
  ]);
  assert.equal((await loadState(env.BUCKET, 'alice')).trips[0].title, '');
});
