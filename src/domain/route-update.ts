import { distanceMeters, isRecord, member, point, safeDate } from './core.ts';
import type { Edge, Stop, Trip } from './core.ts';
import { routeStops } from './daily-route.ts';

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
function orderedTripStops(trip: Trip, today: Stop[], order: DayOrder): Stop[] {
  const places = today.filter(stop => stop.kind !== 'origin');
  const current = places.map(stop => stop.id);
  if (sameOrder(current, order.next)) return trip.stops;
  if (!sameOrder(current, order.previous)) throw Error('סדר התחנות השתנה. יש לקרוא שוב את נתוני היום.');
  const byId = new Map(places.map(stop => [stop.id, stop]));
  const replacements = new Map(places.map((slot, index) => {
    const stop = byId.get(order.next[index])!;
    return [slot.id, { ...stop, rank: slot.rank }];
  }));
  return trip.stops.map(stop => replacements.get(stop.id) ?? stop);
}

function nextStops(stops: Stop[]) {
  return new Map(stops.slice(1).map((stop, index) => [stops[index].id, stop]));
}

/** Write an agent-supplied order and routes together after checking them against the stored day. */
export function setDayRoutes(trip: Trip, date: unknown, routes: unknown, order?: unknown) {
  if (!safeDate(date) || date < trip.start || date > trip.end) throw Error('תאריך המסלול מחוץ לטיול');
  if (!Array.isArray(routes) || routes.length > 200) throw Error('ניתן לייבא עד 200 מקטעים ביום');
  const before = routeStops(trip, date);
  const ordered = order === undefined ? trip.stops : orderedTripStops(trip, before, readDayOrder(order));
  const reordered = ordered !== trip.stops;
  const stops = reordered ? routeStops({ ...trip, stops: ordered }, date) : before;
  const after = nextStops(stops);
  const oldNext = nextStops(before);
  if (reordered) {
    // A ride already saved as a pair stays together. A pickup and drop-off saved apart can be brought together:
    // pairing a pickup with another ride's drop-off would separate that ride, which this also refuses.
    for (const pickup of before.filter(stop => stop.kind === 'pickup')) {
      const oldDrop = oldNext.get(pickup.id), newDrop = after.get(pickup.id);
      if (oldDrop?.kind === 'dropoff' && newDrop?.id !== oldDrop.id) {
        throw Error('נקודת האיסוף של המונית צריכה להופיע מיד לפני נקודת ההורדה שלה.');
      }
    }
  }
  const positions = new Map(stops.map((stop, index) => [stop.id, index]));
  const replacements = new Map<string, Edge>();
  for (const raw of routes) {
    if (!isRecord(raw) || typeof raw.a !== 'string' || typeof raw.b !== 'string') throw Error('מזהי התחנות במקטע אינם תקינים');
    const start = positions.get(raw.a);
    if (start === undefined || stops[start + 1]?.id !== raw.b) throw Error('סדר התחנות השתנה או שהמקטע אינו מחבר תחנות סמוכות באותו יום');
    if (replacements.has(raw.a)) throw Error('מקטע מופיע פעמיים באותו יום');
    replacements.set(raw.a, readRoute(raw, stops[start], stops[start + 1]));
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const unchangedKeys = new Set<string>();
  for (const old of trip.edges) {
    const replacement = replacements.get(old.a);
    if (order !== undefined && old.type === 'taxi' && oldNext.get(old.a)?.id === old.b &&
        (after.get(old.a)?.id !== old.b || (replacement && replacement.type !== 'taxi'))) {
      throw Error('יש לשמור על נקודות המוצא והיעד של נסיעת המונית ועל סוג הנסיעה.');
    }
    // "base" is shared across days. The destination identifies which day's home leg this is.
    if (reordered && positions.has(old.b) && positions.has(old.a) && after.get(old.a)?.id !== old.b) continue;
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
  if (updated || reordered) trip.edges = edges;
  if (reordered) trip.stops = ordered;
  return { updated, unchanged, ...(reordered ? { reordered: true } : {}) };
}

/** Preview every day before committing any stop order or geometry from a file. */
export function prepareRouteImport(trip: Trip, file: Record<string, unknown>) {
  if (file.tripId !== trip.id) throw Error('קובץ המסלולים שייך לטיול אחר');
  if (!Array.isArray(file.days) || file.days.length === 0 || file.days.length > 731) throw Error('רשימת ימי המסלול אינה תקינה');
  const draft = { ...trip };
  const dates = new Set<string>();
  let updated = 0, unchanged = 0, reorderedDays = 0;
  for (const day of file.days) {
    if (!isRecord(day) || !safeDate(day.date) || dates.has(day.date)) throw Error('ימי המסלול חייבים להיות תקינים וייחודיים');
    dates.add(day.date);
    const counts = setDayRoutes(draft, day.date, day.routes, day.order);
    if (counts.reordered) reorderedDays++;
    updated += counts.updated;
    unchanged += counts.unchanged;
  }
  return { stops: draft.stops, edges: draft.edges, updated, unchanged, reorderedDays };
}
