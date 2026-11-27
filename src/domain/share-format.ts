import { cleanTrip, distanceMeters, photoPinRadiusMeters } from './core.ts';
import type { Point, Stop, Trip } from './core.ts';
import { hasMapLocation, isMappedStop } from './daily-route.ts';
// Only location and itinerary fields belong in a route that another person can open.
function selectSharedRoute(trip: Trip, includeOrigin: boolean, day: string | null, publicId: (id: string, index: number) => string) {
  const origins = trip.stops.filter(stop => stop.kind === 'origin');
  const points = [trip.homeXY, ...origins.map(stop => stop.xy)].filter((p): p is Point => p !== null);
  const labels = [trip.home, ...origins.flatMap(stop => [stop.address, stop.name])].filter(Boolean).map(value => value.trim().toLowerCase()).filter(Boolean);
  function isOrigin(stop: Stop) {
    if (stop.kind === 'origin') return true;
    // A ride can end at the home base even when the record is labelled as a drop-off.
    const xy = stop.xy;
    if (xy && points.some(([lat, lon]) => Math.abs(xy[0] - lat) < 0.0002 && Math.abs(xy[1] - lon) < 0.0002)) return true;
    // Nearby photo coordinates can expose the home base.
    if (xy && stop.sources.includes('photo') && points.some(home => distanceMeters(home, xy) <= photoPinRadiusMeters)) return true;
    return [stop.name, stop.address].some(value => value && labels.some(label => value.trim().toLowerCase() === label || label.length >= 6 && value.toLowerCase().includes(label)));
  }
  const ids = new Map<string, string>();
  const stops = trip.stops.filter(stop => (!day || stop.date === day) && isMappedStop(stop) && (includeOrigin || !isOrigin(stop))).map(({
    id,
    name,
    date,
    time,
    address,
    xy,
    kind,
    rank,
    approx
  }) => {
    const shareId = publicId(id, ids.size + 1);
    ids.set(id, shareId);
    return {
      id: shareId,
      name,
      date,
      time,
      address: approx ? '' : address,
      xy,
      kind,
      rank,
      approx
    };
  });
  const shareHome = includeOrigin && hasMapLocation(trip.homeXY);
  if (shareHome && !ids.has('base')) ids.set('base', 'base');
  const edges = trip.edges.filter(edge => ids.has(edge.a) && ids.has(edge.b)).map(({
    a,
    b,
    type,
    m,
    line
  }) => ({
    a: ids.get(a),
    b: ids.get(b),
    type,
    m,
    line
  }));
  return {
    id: 'shared-route',
    title: trip.title,
    start: day || trip.start,
    end: day || trip.end,
    stops,
    edges,
    home: shareHome ? trip.home : '',
    homeXY: shareHome ? trip.homeXY : null
  };
}
export function shareableTrip(trip: Trip, includeOrigin: boolean, day: string | null = null) {
  return selectSharedRoute(trip, includeOrigin, day, (_, index) => 's' + index);
}

// Previous links already have anonymous stop IDs. Filter their own snapshot without reading the owner's journal.
export function readSharedRoute(value: unknown, includeOrigin: boolean) {
  return selectSharedRoute(cleanTrip(value), includeOrigin, null, id => id);
}

// Portable copies refill omitted script and style bodies from the running document.
const part = /(<(script|style) data-part="([\w-]+)"[^>]*>)[\s\S]*?(<\/\2>)/g;

export function withoutParts(source: string) {
  return source.replace(part, '$1$4');
}

export function withParts(compact: string, text: (name: string) => string | null | undefined) {
  return compact.replace(part, (_whole, open: string, _tag: string, name: string, close: string) => {
    const body = text(name);
    if (!body) throw Error('Missing part ' + name);
    return open + body + close;
  });
}

export function portableDocument(cleanSource: string, route: ReturnType<typeof shareableTrip> | null = null) {
  const dataElement = (id: string, value: unknown) => '<script type="application/json" id="' + id + '">' + JSON.stringify(value).replaceAll('<', '\\u003c') + '</script>';
  // Carry the pristine build source so even a renamed or forwarded file can make a blank app.
  const data = dataElement('hayiti-source', withoutParts(cleanSource)) + (route ? dataElement('hayiti-route', route) : '');
  return cleanSource.replace('</head>', () => data + '</head>');
}
