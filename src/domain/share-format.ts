import type { Point, Stop, Trip } from './core.ts';
// Only location and itinerary fields belong in a route that another person can open.
export function shareableTrip(trip: Trip, includeOrigin: boolean, day: string | null = null) {
  const origins = trip.stops.filter(stop => stop.kind === 'origin');
  const points = [trip.homeXY, ...origins.map(stop => stop.xy)].filter((p): p is Point => p !== null);
  const labels = [trip.home, ...origins.flatMap(stop => [stop.address, stop.name])].filter(Boolean).map(value => value.trim().toLowerCase()).filter(Boolean);
  function isOrigin(stop: Stop) {
    if (stop.kind === 'origin') return true;
    // A ride can end at the home base even when the record is labelled as a drop-off.
    const xy = stop.xy;
    if (xy && points.some(([lat, lon]) => Math.abs(xy[0] - lat) < 0.0002 && Math.abs(xy[1] - lon) < 0.0002)) return true;
    return [stop.name, stop.address].some(value => value && labels.some(label => value.trim().toLowerCase() === label || label.length >= 6 && value.toLowerCase().includes(label)));
  }
  const ids = new Map<string, string>();
  const stops = trip.stops.filter(stop => (!day || stop.date === day) && stop.kind !== 'uncertain' && stop.kind !== 'remote' && (includeOrigin || !isOrigin(stop))).map(({
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
    const shareId = 's' + (ids.size + 1);
    ids.set(id, shareId);
    return {
      id: shareId,
      name,
      date,
      time,
      address,
      xy,
      kind,
      rank,
      approx
    };
  });
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
    home: includeOrigin ? trip.home : '',
    homeXY: includeOrigin ? trip.homeXY : null
  };
}
export function portableDocument(cleanSource: string, route: ReturnType<typeof shareableTrip> | null = null) {
  const dataElement = (id: string, value: unknown) => '<script type="application/json" id="' + id + '">' + JSON.stringify(value).replaceAll('<', '\\u003c') + '</script>';
  // Carry the pristine build source so even a renamed or forwarded file can make a blank app.
  const data = dataElement('hayiti-source', cleanSource) + (route ? dataElement('hayiti-route', route) : '');
  return cleanSource.replace('</head>', () => data + '</head>');
}
