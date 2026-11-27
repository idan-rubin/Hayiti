import { point, safeDate, type Edge, type Point, type Stop, type Trip } from './core.ts';
import { dayStops, isMappedStop, routeStops } from './daily-route.ts';

function correctedText(value: unknown, original: string, limit: number) {
  if (value === undefined) return original;
  if (typeof value !== 'string' || value.trim().length > limit) throw Error('Supply valid stop details');
  return value.trim();
}

function correctedPoint(value: unknown, original: Point | null) {
  if (value === undefined) return original;
  if (value === null) return null;
  const xy = point(value);
  if (!xy || (xy[0] === 0 && xy[1] === 0)) throw Error('Supply known latitude and longitude or null for an unknown location');
  return xy;
}

/** An approximate pin replaces the precise place; changing its label alone does not generalize it. */
export function prepareApproximateLocation(old: Stop | undefined, next: Stop): void {
  if (!old || old.approx || !next.approx) return;
  if (old.xy && next.xy?.[0] === old.xy[0] && next.xy[1] === old.xy[1]) {
    throw Error('יש לבחור נקודה אחרת במפה עבור האזור המשוער.');
  }
  next.address = '';
}

/** A confirmed visit inserted between two stops makes their former connecting leg obsolete. */
function bypassedLeg(trip: Trip, stop: Stop): { a: string; b: string } | undefined {
  const stops = trip.stops.map(candidate => candidate.id === stop.id ? stop : candidate);
  const route = routeStops({ ...trip, stops }, stop.date);
  const index = route.findIndex(candidate => candidate.id === stop.id);
  const a = route[index - 1], b = route[index + 1];
  if (!a || !b) return;
  const rides = trip.edges.filter(edge => edge.type === 'taxi');
  const legacyPair = a.kind === 'pickup' && b.kind === 'dropoff' && !rides.some(ride => ride.a === a.id || ride.b === b.id);
  if (legacyPair || rides.some(ride => ride.a === a.id && ride.b === b.id)) {
    // Unlocated entries cannot be reordered in the itinerary. Put a newly located visit after
    // the recorded ride, then invalidate the leg it actually bypasses in its new position.
    const day = dayStops(trip, stop.date).filter(candidate => candidate.id !== stop.id);
    const dropoff = day.findIndex(candidate => candidate.id === b.id);
    const following = day[dropoff + 1];
    const rank = following ? b.rank + (following.rank - b.rank) / 2 : b.rank + 1;
    if (rank > b.rank && (!following || rank < following.rank)) stop.rank = rank;
    else {
      // Tied or adjacent floating-point ranks leave no slot; retain every other stop's order.
      day.splice(dropoff + 1, 0, stop);
      day.forEach((candidate, rank) => candidate.rank = rank);
    }
    return bypassedLeg(trip, stop);
  }
  return { a: a.id, b: b.id };
}

/** Invalidate only routes affected by an edit. Preserve a recorded ride even if its path needs recalculation. */
export function updateRoutesForStopEdit(trip: Trip, old: Stop, next: Stop): void {
  const moved = next.xy?.[0] !== old.xy?.[0] || next.xy?.[1] !== old.xy?.[1];
  const generalized = next.approx && !old.approx;
  const dayChanged = old.date !== next.date;
  const mapped = isMappedStop(next);
  if (!moved && !generalized && !dayChanged && isMappedStop(old) === mapped) return;

  const bypass = mapped && (!isMappedStop(old) || dayChanged) ? bypassedLeg(trip, next) : undefined;
  trip.edges = trip.edges.flatMap((edge): Edge[] => {
    if (bypass && edge.a === bypass.a && edge.b === bypass.b) return [];
    if (edge.a !== old.id && edge.b !== old.id) return [edge];
    return edge.type === 'taxi' ? [{ ...edge, m: 0, line: [] }] : [];
  });
  if (moved || generalized) {
    delete next.photoAnchor;
    if (next.sources.includes('photo')) next.edited = true;
  }
}

export function correctStopLocation(trip: Trip, args: Record<string, unknown>, revision: string): boolean {
  if (!safeDate(args.date) || typeof args.stopId !== 'string' || typeof args.expectedRevision !== 'string' || !args.expectedRevision) {
    throw Error('Use the date, stop ID and revision from get_day');
  }
  const index = trip.stops.findIndex(s => s.id === args.stopId && s.date === args.date);
  const stop = trip.stops[index];
  if (!stop || (stop.kind !== 'uncertain' && stop.kind !== 'visit')) throw Error('Choose an existing visit or uncertain stop on this day');
  if ((args.confirmVisit !== undefined && typeof args.confirmVisit !== 'boolean') || (args.approx !== undefined && typeof args.approx !== 'boolean')) {
    throw Error('Use true or false for confirmVisit and approx');
  }
  if ([args.name, args.address, args.xy, args.approx, args.confirmVisit].every(value => value === undefined)) {
    throw Error('Supply a location correction or confirm the visit');
  }
  const name = correctedText(args.name, stop.name, 160), address = correctedText(args.address, stop.address, 400);
  if (!name) throw Error('Supply a display name for the stop');
  if (stop.address && address && address !== stop.address && stop.xy && args.xy === undefined) throw Error('For a pinned stop, confirm its coordinates, supply the new point, or send xy: null to clear it');
  const xy = correctedPoint(args.xy, stop.xy);
  const approx = xy !== null && (args.approx ?? stop.approx);
  if (approx && !stop.approx && args.address !== undefined && address) {
    throw Error('Omit address or use an empty string when switching an exact location to approximate.');
  }
  const moved = xy?.[0] !== stop.xy?.[0] || xy?.[1] !== stop.xy?.[1];
  const promote = args.confirmVisit === true && stop.kind === 'uncertain';
  const next: Stop = { ...stop, name, address, xy, approx, kind: promote ? 'visit' : stop.kind };
  prepareApproximateLocation(stop, next);
  if (!moved && !promote && name === stop.name && next.address === stop.address && approx === stop.approx) return false;
  if (args.expectedRevision !== revision) throw Error('The journal changed. Read get_day again before correcting this stop.');

  if (promote) delete next.reviewReason;
  updateRoutesForStopEdit(trip, stop, next);
  trip.stops[index] = next;
  return true;
}
