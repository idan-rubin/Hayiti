// Input is a private plan of adjacent stops. A pair defaults to an estimated walk.
// Route services receive only coordinates. Write the import package to stdout after all calls succeed.
import { readFileSync } from 'node:fs';
import { distanceMeters, isRecord, point, safeDate, type Edge, type Point } from '../src/domain/core.ts';

type Mode = 'walk' | 'taxi';

function coordinates(value: unknown): Point {
  const xy = point(value);
  if (!xy) throw Error('Expected [latitude, longitude].');
  return xy;
}

function routeEndpoint(mode: Mode): URL {
  const key = mode === 'walk' ? 'HAYITI_WALK_ROUTE_URL' : 'HAYITI_DRIVE_ROUTE_URL';
  const value = process.env[key];
  if (!value) throw Error('Set ' + key + ' to the route URL for this mode.');
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw Error('Use HTTPS or a loopback router.');
  return url;
}

async function routedPath(mode: Mode, from: Point, to: Point): Promise<Pick<Edge, 'line' | 'm'> | null> {
  const url = routeEndpoint(mode);
  const snapMeters = mode === 'walk' ? 150 : 100;
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + from[1] + ',' + from[0] + ';' + to[1] + ',' + to[0];
  url.searchParams.set('steps', 'true');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('radiuses', [snapMeters, snapMeters].join(';'));
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(25_000) });
  if (response.status === 429 || response.status >= 500) throw Error('Routing service returned HTTP ' + response.status + '. Retry later.');
  const body: unknown = await response.json();
  if (!isRecord(body)) throw Error('Invalid routing response.');
  if (body.code === 'NoRoute' || body.code === 'NoSegment') return null;
  if (!response.ok || body.code !== 'Ok' || !Array.isArray(body.routes)) throw Error('Route request failed (HTTP ' + response.status + ').');
  const route: unknown = body.routes[0];
  if (!isRecord(route) || typeof route.distance !== 'number' || !Number.isFinite(route.distance) || route.distance <= 0 ||
    !Array.isArray(route.legs) || route.legs.length !== 1 || !isRecord(route.geometry) ||
    route.geometry.type !== 'LineString' || !Array.isArray(route.geometry.coordinates)) throw Error('Router did not return a route with geometry.');
  const leg: unknown = route.legs[0];
  const expectedMode = mode === 'walk' ? 'walking' : 'driving';
  if (!isRecord(leg) || !Array.isArray(leg.steps) || !leg.steps.length ||
    !leg.steps.every(step => isRecord(step) && step.mode === expectedMode)) throw Error('Route steps do not match the requested ' + expectedMode + ' profile.');
  const line: Point[] = route.geometry.coordinates.map((pair: unknown) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw Error('Invalid route coordinate.');
    return coordinates([pair[1], pair[0]]);
  });
  if (line.length < 2 || line.length > 1000 || distanceMeters(from, line[0]) > snapMeters || distanceMeters(to, line[line.length - 1]) > snapMeters) return null;
  return { line, m: route.distance };
}

async function main() {
  const plan: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (!isRecord(plan) || typeof plan.tripId !== 'string' || !plan.tripId.trim() || !Array.isArray(plan.days)) throw Error('Expected a tripId and days array on stdin.');
  const days: { date: string; routes: Edge[] }[] = [];
  const cache = new Map<string, Pick<Edge, 'line' | 'm'> | null>();
  for (const day of plan.days) {
    if (!isRecord(day) || !safeDate(day.date) || !Array.isArray(day.legs)) throw Error('Expected a local date and legs array.');
    const routes: Edge[] = [];
    for (const leg of day.legs) {
      if (!isRecord(leg) || typeof leg.a !== 'string' || typeof leg.b !== 'string') throw Error('Expected adjacent stop IDs.');
      const mode = leg.type === undefined ? 'walk' : leg.type;
      if (mode !== 'walk' && mode !== 'taxi') throw Error('Expected a walk or taxi mode.');
      const from = coordinates(leg.from), to = coordinates(leg.to);
      const key = JSON.stringify([mode, from, to]);
      let shape = cache.get(key);
      if (shape === undefined) {
        shape = await routedPath(mode, from, to);
        cache.set(key, shape);
      }
      if (shape) routes.push({ a: leg.a, b: leg.b, type: mode, ...shape });
      else process.stderr.write('Keeping existing route for ' + day.date + ' ' + leg.a + ' → ' + leg.b + '\n');
    }
    if (routes.length) days.push({ date: day.date, routes });
  }
  if (!days.length) throw Error('No usable directions to import.');
  console.log(JSON.stringify({ format: 'hayiti-routes/1', tripId: plan.tripId, days }));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Routing failed.');
  process.exitCode = 1;
});
