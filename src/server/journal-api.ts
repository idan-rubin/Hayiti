import { cleanTrip, cleanStop, isRecord, member, mergeGooglePins, mergeStops, point, reportSources, safeDate, validOutcome, type Trip } from '../domain/core.ts';
import { dayStops, indexEdges, routeStops, walkingStats } from '../domain/daily-route.ts';
import { loadState, storeState, type Bucket } from './storage.ts';
import { setDayRoutes } from '../domain/route-update.ts';
import { dailyGooglePinPreviewLimit, tools } from './tools.ts';
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
function googlePinsForDate(trip: Trip, date?: string) {
  const pins = trip.googlePins ?? [];
  return date === undefined ? pins : pins.filter(pin => pin.date === date);
}
async function callTool(bucket: Bucket, owner: string, name: unknown, args: Record<string, unknown>): Promise<unknown> {
  const journal = await loadState(bucket, owner);
  if (name === 'list_trips') return journal.trips.map(({ id, title, start, end }) => ({
    id, title: title || 'My trip', start, end
  }));
  const trip = journal.trips.find(t => t.id === args.tripId);
  if (name === 'list_google_pins') {
    if (!trip) throw Error('טיול לא נמצא');
    const offset = args.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw Error('Supply offset as a whole number of pins to skip');
    const date = args.date;
    if (date !== undefined && !safeDate(date)) throw Error('Supply date as a valid local YYYY-MM-DD');
    const pins = googlePinsForDate(trip, date);
    return { total: pins.length, offset, pins: pins.slice(offset, offset + 200) };
  }
  if (name === 'get_day') {
    if (!trip || !safeDate(args.date)) throw Error('טיול או תאריך לא נמצא');
    const stops = dayStops(trip, args.date).map(({
      photos,
      ...stop
    }) => ({
      ...stop,
      photoCount: photos.length
    }));
    const route = routeStops(trip, args.date);
    const edges = indexEdges(trip);
    const pins = googlePinsForDate(trip, args.date);
    const positions = new Map(route.map((stop, index) => [stop.id, index]));
    const separatedTaxiPairs = [...edges.values()].filter(edge =>
      edge.type === 'taxi' && positions.has(edge.a) && positions.has(edge.b) && route[positions.get(edge.a)! + 1]?.id !== edge.b)
      .map(({ a, b }) => ({ a, b }));
    return {
      stops,
      googlePins: pins.slice(0, dailyGooglePinPreviewLimit),
      googlePinCount: pins.length,
      home: trip.home,
      rules: trip.rules,
      homeXY: trip.homeXY,
      ...(separatedTaxiPairs.length ? { separatedTaxiPairs } : {}),
      routes: route.slice(1).map((to, i) => {
        const a = route[i].id;
        const edge = edges.get(a + '|' + to.id);
        return { a, b: to.id, type: edge?.type ?? 'gap', m: edge?.m ?? 0, points: edge?.line.length ?? 0 };
      }),
      walking: walkingStats(route, edges)
    };
  }
  if (name === 'set_day_routes') {
    if (!trip) throw Error('טיול לא נמצא');
    const counts = setDayRoutes(trip, args.date, args.routes, args.order);
    if (counts.updated || counts.reordered) await storeState(bucket, owner, journal.trips, journal.rev);
    return counts;
  }
  if (name !== 'add_trip_stops') throw Error('Unknown tool');
  if (typeof args.tripId !== 'string' || !args.tripId.trim() || args.tripId !== args.tripId.trim() || args.tripId.length > 100 || !Array.isArray(args.stops) || args.stops.length > 200) throw Error('Supply a trip ID and up to 200 stops');
  if (args.googlePins !== undefined && (!Array.isArray(args.googlePins) || args.googlePins.length > 200)) throw Error('Supply up to 200 Google Pins');
  const incoming = args.stops.map(cleanStop);
  if (incoming.some(s => !s.sources.length || !s.refs.length)) throw Error('Supply a source and stable reference for every stop');
  if (!trip && args.homeXY != null && !point(args.homeXY)) throw Error('Supply homeXY as [latitude, longitude] in degrees');
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
  const pinResult = args.googlePins && mergeGooglePins(target, args.googlePins);
  if (!trip) journal.trips.push(target);
  if (!trip || entries.length || result.added || result.linked || pinResult?.added || pinResult?.linked) await storeState(bucket, owner, journal.trips, journal.rev);
  return pinResult ? { ...result, googlePins: pinResult } : result;
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
          instructions: [
            'Start in chat. Read list_trips and reuse the matching trip. Resolve dates, destination and optional home base from authorized context. Ask only for missing details that affect the route.',
            'Use the sources the traveler chooses. For photo evidence, search the actual photo library by local capture dates across albums. Google Drive and Google Photos are separate sources. Reuse authorized access and batch-read available timestamps and GPS. Photos and links are optional.',
            'For Google Maps bookmarks, list_google_pins first, then pass approved saved places in googlePins to add_trip_stops. Preserve the original save time only when the source identifies it. Use the verified local save date or the traveler’s chosen day. A save is not evidence of a visit.',
            'Read get_day for affected dates before writing. Count Live Photo pairs once. Group photo-only locations within 100 metres of a fixed pin on the same local day, even across separate bursts. Use the earliest capture for the pin coordinates and include captureTime when available. Compare against existing stops. Preserve distinct venues and revisit times. Use stable opaque refs so retries are safe.',
            'Work out the order before drawing paths. Preserve stated corrections and before/after rules. The journal does not record which stops the traveler ordered by hand: treat a saved order as possibly theirs, show a proposed order and write it only after they approve. Distinguish a local purchase, photo, or ride time from a posting date or an unconfirmed reservation. For untimed venue visits, check opening hours for that branch, weekday and trip date, including holiday exceptions. Treat current hours as a clue for a historical date. Overlapping windows leave the order uncertain. Give the traveler’s recollection and timed evidence priority over proximity. Do not turn opening times into visit times.',
            'Infer the order in chat from trip evidence and traveler rules. Read get_day, keep confirmed taxi pairs together, and pass previous and next stop IDs in set_day_routes.order together with verified directions for the new adjacent pairs. Honor travel modes tied to a specific leg and use road directions for known taxi rides. A day-level fare alone does not identify a leg. Call set_day_routes with verified network geometry and omit unavailable directions or unsupported travel modes.',
            'Save approved stops to the owned trip. Keep remote purchases and uncertain venues off the route. Re-read changed days to verify the result. After appending stops, use set_day_routes for approved changes to the order and check the stored result. Show what changed and open the private journal for review.'
          ].join(' '),
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
