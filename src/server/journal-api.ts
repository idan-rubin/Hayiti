import { cleanTrip, cleanStop, isRecord, member, mergeStops, reportSources, safeDate, validOutcome } from '../domain/core.ts';
import { dayStops, indexEdges, routeStops, walkingStats } from '../domain/daily-route.ts';
import { loadState, storeState, type Bucket } from './storage.ts';
import { tools } from './tools.ts';
const json = (data: unknown, status = 200) => Response.json(data, {
  status,
  headers: {
    'Cache-Control': 'private, no-store',
    'Vary': 'Cookie, Authorization'
  }
});
const serverInfo = {
  name: 'Hayiti',
  version: '1.0.0'
};
async function callTool(bucket: Bucket, owner: string, name: unknown, args: Record<string, unknown>): Promise<unknown> {
  const journal = await loadState(bucket, owner);
  if (name === 'list_trips') return journal.trips.map(({ id, title, start, end }) => ({
    id, title: title || 'My trip', start, end
  }));
  const trip = journal.trips.find(t => t.id === args.tripId);
  if (name === 'get_day') {
    if (!trip || !safeDate(args.date)) throw Error('טיול או תאריך לא נמצא');
    const stops = dayStops(trip, args.date).map(({
      photos,
      ...stop
    }) => ({
      ...stop,
      photoCount: photos.length
    }));
    return {
      stops,
      home: trip.home,
      rules: trip.rules,
      walking: walkingStats(routeStops(trip, args.date), indexEdges(trip))
    };
  }
  if (name !== 'add_trip_stops') throw Error('Unknown tool');
  if (typeof args.tripId !== 'string' || !args.tripId.trim() || args.tripId !== args.tripId.trim() || args.tripId.length > 100 || !Array.isArray(args.stops) || args.stops.length > 200) throw Error('Supply a trip ID and up to 200 stops');
  const incoming = args.stops.map(cleanStop);
  if (incoming.some(s => !s.sources.length || !s.refs.length)) throw Error('Supply a source and stable reference for every stop');
  const target = trip ?? cleanTrip({
    id: args.tripId,
    title: args.title,
    start: args.start,
    end: args.end,
    home: args.home,
    homeXY: args.homeXY,
    stops: []
  });
  const checks = args.sourceChecks ?? {};
  if (!isRecord(checks)) throw Error('Invalid source check');
  const entries = Object.entries(checks);
  if (entries.length && (args.start !== target.start || args.end !== target.end)) throw Error('Include the exact trip dates for source checks');
  for (const [key, status] of entries) {
    if (!member(reportSources, key) || !validOutcome(key, status)) throw Error('Invalid source check');
    target.checks[key] = {
      status,
      start: target.start,
      end: target.end,
      at: new Date().toISOString()
    };
  }
  const result = mergeStops(target, incoming);
  if (!trip) journal.trips.push(target);
  if (!trip || entries.length || result.added || result.linked) await storeState(bucket, owner, journal.trips, journal.rev);
  return result;
}
export async function journalAPI(req: Request, bucket: Bucket, mode: 'web' | 'mcp', owner: string | null): Promise<Response> {
  let id: unknown = null;
  const ok = (result: unknown) => json({
    jsonrpc: '2.0',
    id,
    result
  });
  try {
    if (mode === 'web') {
      if (!owner) return json({
        error: 'Authentication required'
      }, 401);
      if (req.method === 'GET') return json(await loadState(bucket, owner));
    }
    if (req.method !== 'POST') return json({
      error: 'Method not allowed'
    }, 405);
    const origin = req.headers.get('origin');
    if ((mode === 'web' || origin !== null) && origin !== new URL(req.url).origin) return json({
      error: 'Origin mismatch'
    }, 403);
    if (mode === 'mcp' && req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return json({
      error: 'Expected application/json'
    }, 415);
    if (Number(req.headers.get('content-length')) > 8000000) return json({
      error: 'Journal too large'
    }, 413);
    const body = await req.text();
    if (body.length > 8000000) return json({
      error: 'Journal too large'
    }, 413);
    const msg: unknown = JSON.parse(body);
    if (!isRecord(msg)) return json({
      error: 'Invalid request'
    }, 400);
    if (mode === 'web' && owner) return json({
      rev: await storeState(bucket, owner, msg.trips, msg.rev)
    });
    id = msg.id ?? null;
    const params = isRecord(msg.params) ? msg.params : {};
    switch (msg.method) {
      case 'server/discover':
        return ok({
          supportedVersions: ['2026-07-28'],
          capabilities: {
            tools: {}
          },
          serverInfo
        });
      case 'initialize':
        return ok({
          protocolVersion: params.protocolVersion || '2025-03-26',
          capabilities: {
            tools: {}
          },
          serverInfo
        });
      case 'tools/list':
        return ok({
          tools
        });
      case 'notifications/initialized':
        return new Response(null, {
          status: 202
        });
      case 'tools/call':
        {
          if (!owner) return json({
            error: 'Authentication required'
          }, 401);
          const result = await callTool(bucket, owner, params.name, isRecord(params.arguments) ? params.arguments : {});
          return ok({
            content: [{
              type: 'text',
              text: JSON.stringify(result)
            }]
          });
        }
      default:
        return json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'Unknown method'
          }
        });
    }
  } catch (error) {
    const message = error instanceof SyntaxError ? 'Invalid JSON' : error instanceof Error ? error.message.slice(0, 200) : 'Request failed';
    return mode === 'mcp' ? ok({
      isError: true,
      content: [{
        type: 'text',
        text: message
      }]
    }) : json({
      error: message
    }, message === 'CONFLICT' ? 409 : 400);
  }
}
