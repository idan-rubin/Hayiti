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

/** Replace supplied adjacent legs atomically. Other dates, stops and omitted legs retain their geometry. */
export function setDayRoutes(trip: Trip, date: unknown, routes: unknown) {
  if (!safeDate(date) || date < trip.start || date > trip.end) throw Error('תאריך המסלול מחוץ לטיול');
  if (!Array.isArray(routes) || routes.length > 200) throw Error('ניתן לייבא עד 200 מקטעים ביום');
  const stops = routeStops(trip, date);
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
  if (updated) trip.edges = edges;
  return { updated, unchanged };
}

/** Prepare a whole file before replacing any of the current journal's edges. */
export function prepareRouteImport(trip: Trip, file: Record<string, unknown>) {
  if (file.tripId !== trip.id) throw Error('קובץ המסלולים שייך לטיול אחר');
  if (!Array.isArray(file.days) || file.days.length === 0 || file.days.length > 731) throw Error('רשימת ימי המסלול אינה תקינה');
  const draft = { ...trip };
  const dates = new Set<string>();
  let updated = 0, unchanged = 0;
  for (const day of file.days) {
    if (!isRecord(day) || !safeDate(day.date) || dates.has(day.date)) throw Error('ימי המסלול חייבים להיות תקינים וייחודיים');
    dates.add(day.date);
    const counts = setDayRoutes(draft, day.date, day.routes);
    updated += counts.updated;
    unchanged += counts.unchanged;
  }
  return { edges: draft.edges, updated, unchanged };
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
