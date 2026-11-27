import { distanceMeters, isRecord, member, point, safeDate } from './core.ts';
import type { Edge, Stop, Trip } from './core.ts';
import { dayDetails, offRoute, routeStops } from './daily-route.ts';

const modes = ['walk', 'taxi', 'same', 'gap'] as const;

function readRoute(raw: Record<string, unknown>, from: Stop, to: Stop): Edge {
  if (!member(modes, raw.type) || !Array.isArray(raw.line)) throw Error('סוג מקטע או תוואי לא תקין');
  const edge: Edge = { a: from.id, b: to.id, type: raw.type, line: [], m: 0 };
  if (raw.type === 'gap' || raw.type === 'same') {
    if (raw.line.length || (raw.m !== undefined && raw.m !== 0)) throw Error('מקטע ללא תנועה אינו יכול להכיל תוואי או מרחק');
    if (raw.type === 'same' && (!from.xy || !to.xy || distanceMeters(from.xy, to.xy) > 25)) throw Error('התחנות מרוחקות מכדי לסמן אותן כאותו מקום');
    return edge;
  }
  if (raw.line.length < 2 || raw.line.length > 1000) throw Error('נדרשות בין 2 ל־1000 נקודות בתוואי');
  if (raw.type === 'walk' && from.kind === 'pickup' && to.kind === 'dropoff') throw Error('נסיעה מנקודת איסוף לנקודת הורדה מחייבת מסלול בכביש');
  let length = 0;
  for (const value of raw.line) {
    const xy = point(value);
    if (!xy) throw Error('נקודה בתוואי אינה תקינה');
    const previous = edge.line.at(-1);
    if (previous && previous[0] === xy[0] && previous[1] === xy[1]) continue;
    if (previous) length += distanceMeters(previous, xy);
    edge.line.push(xy);
  }
  if (!length) throw Error('נדרש תוואי עם נקודות נפרדות');
  // Routers snap entrances to a nearby sidewalk or road. Retain the network endpoints as returned.
  const snapLimitMeters = edge.type === 'walk' ? 150 : 100;
  if (!from.xy || !to.xy || distanceMeters(from.xy, edge.line[0]) > snapLimitMeters || distanceMeters(to.xy, edge.line[edge.line.length - 1]) > snapLimitMeters) {
    throw Error('קצות התוואי מרוחקים מהתחנות: יש לבדוק את המיקום והכיוון');
  }
  const meters = raw.m ?? length;
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0 ||
      meters < length * 0.8 - 5 || meters > length * 2 + 50) throw Error('מרחק המסלול אינו תואם את התוואי');
  edge.m = Math.max(1, Math.round(meters));
  return edge;
}

function sameGeometry(a: Edge, b: Edge): boolean {
  return a.type === b.type && a.m === b.m && a.line.length === b.line.length &&
    a.line.every(([lat, lon], i) => lat === b.line[i][0] && lon === b.line[i][1]);
}

export interface DayOrder {
  previous: string[];
  next: string[];
}

export function readDayOrder(raw: unknown): DayOrder {
  function ids(value: unknown): value is string[] {
    return Array.isArray(value) && value.length <= 6500 &&
      value.every(id => typeof id === 'string' && id.trim() !== '') && new Set(value).size === value.length;
  }
  if (!isRecord(raw) || !ids(raw.previous) || !ids(raw.next)) throw Error('נדרשות שתי רשימות מלאות של מזהי תחנות ללא כפילויות.');
  const before = new Set(raw.previous);
  if (before.size !== raw.next.length || raw.next.some(id => !before.has(id))) throw Error('שתי הרשימות צריכות לכלול את אותן תחנות.');
  return { previous: raw.previous, next: raw.next };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

// Keep each slot's rank and its position in the backing list. Older trips can have equal ranks.
function orderedTripStops(trip: Trip, date: string, today: Stop[], order: DayOrder): Stop[] {
  // Previous clients included unpinned visits and ride endpoints in both lists. Keep their stored ranks.
  const legacyIds = new Set(dayDetails(trip, date).filter(stop => !offRoute(stop)).map(stop => stop.id));
  const previous = order.previous.filter(id => !legacyIds.has(id)), next = order.next.filter(id => !legacyIds.has(id));
  const places = today.filter(stop => stop.kind !== 'origin');
  const current = places.map(stop => stop.id);
  if (sameOrder(current, next)) return trip.stops;
  if (!sameOrder(current, previous)) throw Error('סדר התחנות השתנה. יש לקרוא שוב את נתוני היום.');
  const byId = new Map(places.map(stop => [stop.id, stop]));
  const replacements = new Map(places.map((slot, index) => {
    const stop = byId.get(next[index])!;
    return [slot.id, { ...stop, rank: slot.rank }];
  }));
  return trip.stops.map(stop => replacements.get(stop.id) ?? stop);
}

function nextStops(stops: Stop[]) {
  return new Map(stops.slice(1).map((stop, index) => [stops[index].id, stop]));
}

// A real endpoint can move across midnight. Home uses the shared "base" ID, so its destination identifies the day.
function taxiTouchesDay(edge: Edge, positions: Map<string, number>): boolean {
  return edge.type === 'taxi' && (positions.has(edge.b) || (edge.a !== 'base' && positions.has(edge.a)));
}

/** A saved taxi edge identifies a ride even after manual edits separate its endpoints. */
function checkTaxiOrder(stops: Stop[], before: Map<string, Stop>, after: Map<string, Stop>, rides: Edge[]) {
  const pickups = new Set<string>(), dropoffs = new Set<string>(), matched = new Set<string>();

  function keepRide(pickup: string, dropoff: string) {
    pickups.add(pickup);
    dropoffs.add(dropoff);
    if (after.get(pickup)?.id === dropoff) matched.add(pickup);
    else if (before.get(pickup)?.id === dropoff) throw Error('נקודת האיסוף של המונית צריכה להופיע מיד לפני נקודת ההורדה שלה.');
  }

  for (const ride of rides) keepRide(ride.a, ride.b);
  // Older trips can identify a ride only by an adjacent pickup and drop-off.
  for (const stop of stops) {
    const next = before.get(stop.id);
    if (stop.kind === 'pickup' && next?.kind === 'dropoff' && !pickups.has(stop.id) && !dropoffs.has(next.id)) {
      keepRide(stop.id, next.id);
    }
  }
  const loosePickups = stops.filter(s => s.kind === 'pickup' && !pickups.has(s.id));
  const looseDropoffs = stops.filter(s => s.kind === 'dropoff' && !dropoffs.has(s.id));
  for (const stop of stops) {
    const next = after.get(stop.id);
    if (stop.kind !== 'pickup' || next?.kind !== 'dropoff' || before.get(stop.id)?.id === next.id || matched.has(stop.id)) continue;
    if (loosePickups.length !== 1 || loosePickups[0].id !== stop.id ||
        looseDropoffs.length !== 1 || looseDropoffs[0].id !== next.id) {
      throw Error('אין די מידע לשייך את נקודות האיסוף וההורדה לאותה נסיעת מונית.');
    }
  }
}

// Release only the exact ride the traveler disputed. All other rides still go through the ordinary guards.
function prepareTaxiCorrections(trip: Trip, date: string, routes: unknown[]) {
  const corrections = routes.filter(isRecord).filter(route => route.correctTaxi !== undefined && route.correctTaxi !== false);
  let correctedRides = 0;
  if (!corrections.length) return { trip, correctedRides };
  const before = routeStops(trip, date);
  const stops = new Map(before.map(stop => [stop.id, stop]));
  const next = nextStops(before);
  const rides = trip.edges.filter(edge => edge.type === 'taxi');
  const removed = new Set<Edge>(), visits = new Set<Stop>();
  for (const raw of corrections) {
    if (raw.correctTaxi !== true || (raw.type !== 'walk' && raw.type !== 'gap')) {
      throw Error('תיקון נסיעת מונית דורש מסלול הליכה או פער מפורש.');
    }
    const from = typeof raw.a === 'string' && stops.get(raw.a), to = typeof raw.b === 'string' && stops.get(raw.b);
    if (!from || !to || from.id === to.id) throw Error('מזהי התחנות במקטע אינם תקינים');
    const matches = trip.edges.filter(edge => edge.a === from.id && edge.b === to.id);
    const wasTaxi = matches.some(edge => edge.type === 'taxi');
    const legacyPair = from.kind === 'pickup' && to.kind === 'dropoff' && next.get(from.id)?.id === to.id;
    if (!wasTaxi && !legacyPair) {
      const current = matches.at(-1);
      if (current && sameGeometry(current, readRoute(raw, from, to))) continue;
      throw Error('המקטע שנבחר אינו נסיעת המונית שנקראה. יש לבדוק שוב את נתוני היום.');
    }
    if (rides.some(edge => (from.kind === 'pickup' && edge.a === from.id && edge.b !== to.id) ||
        (to.kind === 'dropoff' && edge.b === to.id && edge.a !== from.id))) {
      throw Error('אין די מידע לשייך את נקודות האיסוף וההורדה לאותה נסיעת מונית.');
    }
    correctedRides++;
    for (const edge of matches) removed.add(edge);
    if (from.kind === 'pickup') visits.add(from);
    if (to.kind === 'dropoff') visits.add(to);
  }
  if (!correctedRides) return { trip, correctedRides };
  const stopsAfter = visits.size ? trip.stops.map(stop => visits.has(stop) ? { ...stop, kind: 'visit' as const } : stop) : trip.stops;
  return { trip: { ...trip, stops: stopsAfter, edges: trip.edges.filter(edge => !removed.has(edge)) }, correctedRides };
}

/** Write an agent-supplied order and routes together after checking them against the stored day. */
export function setDayRoutes(target: Trip, date: unknown, routes: unknown, order?: unknown) {
  if (!safeDate(date) || date < target.start || date > target.end) throw Error('תאריך המסלול מחוץ לטיול');
  if (!Array.isArray(routes) || routes.length > 200) throw Error('ניתן לייבא עד 200 מקטעים ביום');
  const { trip, correctedRides } = prepareTaxiCorrections(target, date, routes);
  const before = routeStops(trip, date);
  const ordered = order === undefined ? trip.stops : orderedTripStops(trip, date, before, readDayOrder(order));
  const reordered = ordered !== trip.stops;
  const stops = reordered ? routeStops({ ...trip, stops: ordered }, date) : before;
  const after = nextStops(stops);
  const oldNext = nextStops(before);
  const positions = new Map(stops.map((stop, index) => [stop.id, index]));
  if (reordered) {
    checkTaxiOrder(stops, oldNext, after, trip.edges.filter(edge => taxiTouchesDay(edge, positions)));
  }
  const replacements = new Map<string, Edge>();
  for (const raw of routes) {
    if (!isRecord(raw) || typeof raw.a !== 'string' || typeof raw.b !== 'string') throw Error('מזהי התחנות במקטע אינם תקינים');
    const start = positions.get(raw.a);
    if (start === undefined || stops[start + 1]?.id !== raw.b) throw Error('סדר התחנות השתנה או שהמקטע אינו מחבר תחנות סמוכות באותו יום');
    if (replacements.has(raw.a)) throw Error('מקטע מופיע פעמיים באותו יום');
    replacements.set(raw.a, readRoute(raw, stops[start], stops[start + 1]));
  }

  const taxiOrigins = new Map([...replacements.values()].filter(edge => edge.type === 'taxi').map(edge => [edge.b, edge.a]));
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const unchangedKeys = new Set<string>();
  for (const old of trip.edges) {
    const replacement = replacements.get(old.a);
    if (taxiTouchesDay(old, positions)) {
      const origin = taxiOrigins.get(old.b);
      if ((replacement?.b === old.b && replacement.type !== 'taxi') ||
          (replacement?.type === 'taxi' && replacement.b !== old.b) || (origin !== undefined && origin !== old.a)) {
        throw Error('יש לשמור על נקודות המוצא והיעד של נסיעת המונית ועל סוג הנסיעה.');
      }
    }
    if (reordered && positions.has(old.a) && positions.has(old.b) && old.type !== 'taxi' && after.get(old.a)?.id !== old.b) continue;
    if (replacement?.b !== old.b) {
      edges.push(old);
    } else if (seen.has(old.a)) {
      // Older backups can contain two versions of the same leg.
      unchangedKeys.delete(old.a);
    } else {
      if (sameGeometry(old, replacement)) unchangedKeys.add(old.a);
      edges.push(replacement);
      seen.add(old.a);
    }
  }
  for (const [a, replacement] of replacements) if (!seen.has(a)) edges.push(replacement);
  const unchanged = unchangedKeys.size;
  if (edges.length > 8000) throw Error('מספר המקטעים גדול מדי ליומן');
  const updated = routes.length - unchanged;
  if (updated || reordered) target.edges = edges;
  if (reordered || trip.stops !== target.stops) target.stops = ordered;
  return { updated, unchanged, ...(reordered ? { reordered: true } : {}), ...(correctedRides ? { correctedRides } : {}) };
}

/** Preview every day before committing any stop order or geometry from a file. */
export function prepareRouteImport(trip: Trip, file: Record<string, unknown>) {
  if (file.tripId !== trip.id) throw Error('קובץ המסלולים שייך לטיול אחר');
  if (!Array.isArray(file.days) || file.days.length === 0 || file.days.length > 731) throw Error('רשימת ימי המסלול אינה תקינה');
  const draft = { ...trip };
  const dates = new Set<string>();
  let updated = 0, unchanged = 0, reorderedDays = 0, correctedRides = 0;
  for (const day of file.days) {
    if (!isRecord(day) || !safeDate(day.date) || dates.has(day.date)) throw Error('ימי המסלול חייבים להיות תקינים וייחודיים');
    dates.add(day.date);
    const counts = setDayRoutes(draft, day.date, day.routes, day.order);
    if (counts.reordered) reorderedDays++;
    correctedRides += counts.correctedRides ?? 0;
    updated += counts.updated;
    unchanged += counts.unchanged;
  }
  return { stops: draft.stops, edges: draft.edges, updated, unchanged, reorderedDays, correctedRides };
}

function adjacentByDestination(trip: Trip) {
  const pairs = new Map<string, { from: Stop; to: Stop }>();
  for (const date of new Set(trip.stops.map(stop => stop.date))) {
    const day = routeStops(trip, date);
    for (let i = 1; i < day.length; i++) pairs.set(day[i].id, { from: day[i - 1], to: day[i] });
  }
  return pairs;
}

function sameRouteEndpoint(source: Stop, current: Stop) {
  return source.date === current.date && source.kind === current.kind &&
    source.xy?.[0] === current.xy?.[0] && source.xy?.[1] === current.xy?.[1];
}

/** Fill missing legs from a backup only when both endpoints still describe the same adjacent journey. */
export function restoreMissingRoutes(trip: Trip, backup: Trip, restoredIds: ReadonlyMap<string, string>) {
  if (!backup.edges.length) return 0;
  const current = adjacentByDestination(trip), original = adjacentByDestination(backup);
  const present = new Set(trip.edges.filter(edge => current.get(edge.b)?.from.id === edge.a).map(edge => edge.b));
  const savedStops = new Set(backup.stops);
  const restored: Edge[] = [];
  // The map renderer uses the last occurrence when an old backup contains two versions of a leg.
  for (const edge of backup.edges.toReversed()) {
    const to = restoredIds.get(edge.b);
    if (!to || present.has(to)) continue;
    const pair = current.get(to), old = original.get(edge.b);
    if (!pair || !old || old.from.id !== edge.a) continue;
    const syntheticHome = edge.a === 'base' && old.from.kind === 'origin' && !savedStops.has(old.from);
    if (!syntheticHome && restoredIds.get(edge.a) !== pair.from.id) continue;
    if (!sameRouteEndpoint(old.from, pair.from) || !sameRouteEndpoint(old.to, pair.to)) continue;
    let valid: Edge;
    try {
      // Older backups used zero when only the path, without a measured distance, had been saved.
      if (!edge.line.length && (edge.type === 'taxi' || edge.type === 'mixed')) {
        // An older journal may know the mode without recording a path.
        if (!Number.isFinite(edge.m)) continue;
        valid = { ...edge, a: pair.from.id, b: pair.to.id };
      } else {
        const mode = edge.type === 'mixed' ? 'taxi' : edge.type;
        valid = readRoute({ ...edge, type: mode, m: edge.m || undefined }, pair.from, pair.to);
        valid.type = edge.type;
      }
    } catch {
      continue;
    }
    if (trip.edges.length + restored.length >= 8000) throw Error('מספר המקטעים גדול מדי ליומן');
    restored.push(valid);
    present.add(to);
  }
  trip.edges.push(...restored.reverse());
  return restored.length;
}
