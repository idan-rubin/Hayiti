import { cleanStop, distanceMeters } from './core.ts';
import type { Stop, Trip, Edge } from './core.ts';
export const offRoute = (stop: Stop) => stop.kind === 'uncertain' || stop.kind === 'remote';
export function dayStops(trip: Trip, day: string) {
  return trip.stops.filter(stop => stop.date === day).sort((a, b) => {
    if (a.kind === 'origin' && b.kind !== 'origin') return -1;
    if (b.kind === 'origin' && a.kind !== 'origin') return 1;
    return a.rank - b.rank;
  });
}
export function routeStops(trip: Trip | null, day: string, defaultOrigin = 'נקודת מוצא') {
  if (!trip) return [];
  const stops = dayStops(trip, day).filter(stop => !offRoute(stop));
  if (!stops.some(stop => stop.kind === 'origin') && (trip.home || trip.homeXY)) {
    stops.unshift(cleanStop({
      id: 'base',
      date: day,
      kind: 'origin',
      name: trip.home || defaultOrigin,
      xy: trip.homeXY
    }));
  }
  return stops;
}
export function indexEdges(trip: Trip | null) {
  return new Map((trip?.edges || []).map(edge => [edge.a + '|' + edge.b, edge]));
}

// Saved pedestrian route length takes precedence over the simplified display geometry.
function walkingLength(edge: Edge) {
  if (Number.isFinite(edge.m) && edge.m > 0) return edge.m;
  const points = edge.line || [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += distanceMeters(points[i - 1], points[i]);
  }
  return length;
}
export function walkingStats(stops: Stop[], edges: Map<string, Edge>) {
  let total = 0,
    walkingLegs = 0,
    taxiLegs = 0,
    unknownLegs = 0,
    longest = null;
  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1],
      to = stops[i],
      edge = edges.get(from.id + '|' + to.id);
    if (edge?.type === 'same') continue;
    if (edge?.type === 'taxi') {
      taxiLegs++;
      continue;
    }
    const meters = edge?.type === 'walk' ? walkingLength(edge) : 0;
    if (!meters) {
      unknownLegs++;
      continue;
    }
    total += meters;
    walkingLegs++;
    if (!longest || meters > longest.meters) longest = {
      from: from.name,
      to: to.name,
      meters: Math.round(meters)
    };
  }
  return {
    estimatedWalkingMeters: walkingLegs ? Math.round(total) : null,
    walkingLegs,
    taxiLegs,
    unknownLegs,
    stopCount: stops.filter(stop => stop.kind !== 'origin').length,
    longest
  };
}

export function suggest(stops: Stop[], trip: Trip) {
  const slots = {
    morning: 9,
    midday: 13,
    evening: 19,
    night: 23
  };
  const words: Record<string, number> = {
    morning: 9,
    midday: 13,
    noon: 13,
    afternoon: 16,
    evening: 19,
    night: 23,
    'בוקר': 9,
    'צהריים': 13,
    'אחה״צ': 16,
    'ערב': 19,
    'לילה': 23
  };
  const rules = trip.rules.split('\n').map(x => x.trim()).filter(Boolean);
  const before = rules.map(x => x.split(/\s+(?:לפני|before)\s+/i).map(a => a.trim())).filter(x => x.length === 2 && x.every(Boolean));
  function when(s: Stop) {
    if (s.time) {
      const [h, m] = s.time.split(':').map(Number);
      return h + m / 60;
    }
    for (const r of rules) {
      const [key, slot] = r.split('|').map(x => x.trim());
      if (key && Object.hasOwn(words, slot?.toLowerCase()) && s.name.includes(key)) return words[slot.toLowerCase()];
    }
    return s.slot ? slots[s.slot] : null;
  }
  const list = stops.filter(s => s.kind === 'visit');
  let xy = trip.homeXY;
  const ordered: Stop[] = [];
  while (list.length) {
    const candidates = list.filter(s => !before.some(([a, b]) => s.name.includes(b) && list.some(t => t !== s && t.name.includes(a))));
    if (!candidates.length) throw Error('שני כללי סדר סותרים זה את זה');
    const timed = candidates.filter(s => when(s) !== null),
      early = timed.length ? Math.min(...timed.map(s => when(s) ?? Infinity)) : null;
    const allowed = candidates.filter(s => when(s) === null || when(s) === early);
    const dist = (s: Stop) => xy && s.xy ? Math.hypot(s.xy[0] - xy[0], (s.xy[1] - xy[1]) * Math.cos(xy[0] * Math.PI / 180)) : 10;
    allowed.sort((a, b) => (early !== null && early < 11 && when(a) === early ? -20 : 0) + dist(a) - ((early !== null && early < 11 && when(b) === early ? -20 : 0) + dist(b)) || a.rank - b.rank);
    const chosen = allowed[0];
    list.splice(list.indexOf(chosen), 1);
    ordered.push(chosen);
    xy = chosen.xy || xy;
  }
  let j = 0;
  return stops.map(s => s.kind === 'visit' ? ordered[j++] : s);
}
