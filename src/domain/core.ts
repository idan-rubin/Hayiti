export const journalCharacterLimit = 7_000_000;
export const sources = ['card', 'email', 'calendar', 'ticket', 'whatsapp', 'manual', 'taxi', 'transfer', 'diary', 'photo'] as const;
export const reportSources = ['finances', 'gmail', 'calendar', 'drive'] as const;
const commonReportStates = ['checked', 'disconnected', 'syncing', 'failed', 'unavailable', 'partial'] as const;
export const reportStates = [...commonReportStates, 'no_accounts', 'no_transactions', 'no_places'] as const;
export const statesBySource = {
  finances: reportStates,
  gmail: commonReportStates,
  calendar: commonReportStates,
  drive: commonReportStates
} satisfies Record<CheckSource, readonly CheckStatus[]>;
const kinds = ['origin', 'visit', 'uncertain', 'remote', 'pickup', 'dropoff'] as const;
const slots = ['morning', 'midday', 'evening', 'night'] as const;
const travelModes = ['walk', 'taxi', 'gap', 'mixed', 'same'] as const;
export type Source = typeof sources[number];
export type CheckSource = typeof reportSources[number];
export type CheckStatus = typeof reportStates[number];
export type Point = [latitude: number, longitude: number];
export interface Stop {
  id: string;
  name: string;
  date: string;
  address: string;
  time: string;
  xy: Point | null;
  photoAnchor?: Point;
  captureTime?: string;
  /** The traveler set this stop's time or place by hand. An import adds its evidence and leaves both alone. */
  edited?: true;
  notes: string;
  band: string;
  sources: Source[];
  refs: string[];
  kind: typeof kinds[number];
  count: number;
  rank: number;
  slot: typeof slots[number] | '';
  photos: string[];
  approx: boolean;
}
/** A saved Google Maps place is a bookmark; its assigned day does not imply a visit. */
export interface GooglePin {
  id: string;
  name: string;
  xy: Point;
  date?: string;
  savedAt?: string;
  dayEdited?: true;
}
export interface Edge {
  a: string;
  b: string;
  type: typeof travelModes[number];
  m: number;
  line: Point[];
}
export interface SourceCheck {
  status: CheckStatus;
  start: string;
  end: string;
  at: string;
}
export interface Trip {
  id: string;
  title: string;
  start: string;
  end: string;
  home: string;
  homeXY: Point | null;
  stops: Stop[];
  googlePins?: GooglePin[];
  edges: Edge[];
  rules: string;
  dayNotes: Record<string, string>;
  checks: Partial<Record<CheckSource, SourceCheck>>;
}
export interface Journal {
  trips: Trip[];
  rev: string;
}
export interface MergeResult {
  added: number;
  linked: number;
  skipped: number;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some(item => item === value);
}
export function safeDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}
const text = (value: unknown, limit = 400) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
export function point(value: unknown): Point | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lat, lon] = value;
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}
const googlePinLimit = 6500;

function validSavedAt(value: unknown): value is string {
  if (safeDate(value)) return true;
  if (typeof value !== 'string' || !safeDate(value.slice(0, 10))) return false;
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function cleanGooglePin(value: unknown, start: string, end: string, inferSaveDay = false): GooglePin {
  if (!isRecord(value)) throw Error('Invalid Google Pin');
  const { id, date, savedAt } = value;
  const name = text(value.name, 160), xy = point(value.xy);
  if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 180 || !name || !xy) {
    throw Error('A Google Pin needs a stable ID, name and coordinates');
  }
  if (date !== undefined && !safeDate(date)) throw Error('Invalid Google Pin day');
  if (savedAt !== undefined && !validSavedAt(savedAt)) throw Error('Invalid Google Pin save time');
  // A UTC export timestamp can fall on another day locally. The agent can supply date after converting it.
  let tripDay = date;
  if (!tripDay && inferSaveDay && !value.dayEdited && savedAt && !/(?:Z|[+-]00:00)$/.test(savedAt)) {
    tripDay = savedAt.slice(0, 10);
  }
  return {
    id, name, xy,
    ...(tripDay && tripDay >= start && tripDay <= end ? { date: tripDay } : {}),
    ...(savedAt ? { savedAt } : {}),
    ...(value.dayEdited === true ? { dayEdited: true } : {})
  };
}

export interface GooglePinResult extends MergeResult {
  /** Pins saved without the day they were sent with, because that day is outside the trip. */
  datesOutsideTrip?: number;
}

/**
 * On a retry, fill missing details and take a corrected name or location for the same place,
 * while preserving a day chosen or cleared by the traveler.
 */
export function mergeGooglePins(trip: Trip, incoming: readonly unknown[]): GooglePinResult {
  const result = { added: 0, linked: 0, skipped: 0 };
  let datesOutsideTrip = 0;
  const pins = new Map(trip.googlePins?.map(pin => [pin.id, pin]));
  for (const value of incoming) {
    const pin = cleanGooglePin(value, trip.start, trip.end, true);
    // Google's export writes [0, 0] for a place whose location it does not know.
    if (pin.xy[0] === 0 && pin.xy[1] === 0) throw Error('A Google Pin at [0, 0] has no known location');
    // The pin is still saved, without a day. The count tells the agent its day was not kept.
    if (isRecord(value) && value.date !== undefined && !pin.date) datesOutsideTrip++;
    const previous = pins.get(pin.id);
    if (!previous) {
      pins.set(pin.id, pin);
      result.added++;
      continue;
    }
    const date = !previous.dayEdited && !previous.date ? pin.date : undefined;
    const savedAt = !previous.savedAt ? pin.savedAt : undefined;
    const corrected = previous.name !== pin.name || previous.xy[0] !== pin.xy[0] || previous.xy[1] !== pin.xy[1];
    if (date || savedAt || corrected) {
      pins.set(pin.id, { ...previous, name: pin.name, xy: pin.xy, ...(date ? { date } : {}), ...(savedAt ? { savedAt } : {}) });
      result.linked++;
    } else result.skipped++;
  }
  if (pins.size > googlePinLimit) throw Error('Too many Google Pins in this trip');
  if (result.added || result.linked) trip.googlePins = [...pins.values()];
  return datesOutsideTrip ? { ...result, datesOutsideTrip } : result;
}

export function distanceMeters([lat, lon]: Point, [nextLat, nextLon]: Point): number {
  const rad = Math.PI / 180;
  const a = Math.sin((nextLat - lat) * rad / 2) ** 2 +
    Math.cos(lat * rad) * Math.cos(nextLat * rad) * Math.sin((nextLon - lon) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, a)));
}

export const photoPinRadiusMeters = 100;

function hasPhotoAssetRefs(stop: Stop): boolean {
  return stop.sources.length === 1 && stop.sources[0] === 'photo' && stop.refs.length > 0;
}

export function photoLocation(stop: Stop): stop is Stop & { xy: Point } {
  return stop.kind === 'visit' && stop.xy !== null && hasPhotoAssetRefs(stop) && !stop.photos.length && !stop.count;
}

// Whether one local time is known to come before another. A time without seconds says nothing about the
// order inside its own minute, so it never displaces a capture recorded to the second.
function knownEarlier(time: string, than: string): boolean {
  if (time.length === 5 || than.length === 5) return time.slice(0, 5) < than.slice(0, 5);
  const precise = (value: string) => value.length === 8 ? value + '.000' : value.padEnd(12, '0');
  return precise(time) < precise(than);
}

function linkPhotoReferences(pin: Stop, incoming: Stop): 'linked' | 'skipped' {
  // Follow the journal's persisted reference limit. Spatial deduplication still works at capacity.
  const refs = [...new Set([...pin.refs, ...incoming.refs])].slice(0, 100);
  const time = incoming.captureTime || incoming.time;
  const current = pin.captureTime || pin.time;
  // A pin the traveler placed or timed by hand keeps collecting references and stays where they put it.
  const earlier = !pin.edited && pin.date === incoming.date && photoLocation(pin) && photoLocation(incoming) && time &&
    (!current || knownEarlier(time, current)) &&
    distanceMeters(pin.photoAnchor ?? pin.xy, incoming.xy) <= photoPinRadiusMeters;
  if (!earlier && refs.length === pin.refs.length) return 'skipped';
  if (earlier && pin.xy) {
    pin.photoAnchor ??= pin.xy;
    pin.xy = incoming.xy;
    pin.time = incoming.time;
    if (incoming.captureTime) pin.captureTime = incoming.captureTime;
    else delete pin.captureTime;
  }
  pin.refs = refs;
  return 'linked';
}

function closestPhotoPin(day: Stop[], incoming: Stop & { xy: Point }) {
  let nearest: Stop | undefined;
  let limit = photoPinRadiusMeters;
  for (const candidate of day) {
    if (!photoLocation(candidate)) continue;
    const distance = distanceMeters(candidate.photoAnchor ?? candidate.xy, incoming.xy);
    if (distance <= limit) {
      nearest = candidate;
      limit = distance;
    }
  }
  return nearest;
}

export function photosOf(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 3 || value.some(photo => typeof photo !== 'string' || photo.length > 335000 || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+=*$/.test(photo))) throw Error('תמונה לא תקינה או גדולה מדי');
  return [...new Set(value)];
}
export function cleanStop(value: unknown): Stop {
  if (!isRecord(value) || !safeDate(value.date) || !text(value.name, 160)) throw Error('נדרשים תאריך תקין ושם תחנה');
  const captureTime = text(value.captureTime, 16);
  if (captureTime && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(captureTime)) throw Error('Invalid local capture time');
  const time = text(value.time, 5) || captureTime.slice(0, 5);
  if (captureTime && captureTime.slice(0, 5) !== time) throw Error('Capture time must match the local stop time');
  const anchor = point(value.photoAnchor);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('שעה לא תקינה');
  return {
    id: text(value.id, 140) || crypto.randomUUID(),
    name: text(value.name, 160),
    date: value.date,
    time,
    ...(captureTime ? { captureTime } : {}),
    ...(anchor ? { photoAnchor: anchor } : {}),
    ...(value.edited === true ? { edited: true as const } : {}),
    address: text(value.address),
    xy: point(value.xy),
    notes: text(value.notes, 1200),
    band: text(value.band, 180),
    sources: [...new Set(Array.isArray(value.sources) ? value.sources.filter((s): s is Source => member(sources, s)) : [])],
    refs: [...new Set(Array.isArray(value.refs) ? value.refs.map(r => text(r, 180)).filter(Boolean) : [])].slice(0, 100),
    kind: member(kinds, value.kind) ? value.kind : 'visit',
    count: typeof value.count === 'number' && Number.isSafeInteger(value.count) ? Math.min(10000, Math.max(0, value.count)) : 0,
    rank: typeof value.rank === 'number' && Number.isFinite(value.rank) ? value.rank : 0,
    slot: member(slots, value.slot) ? value.slot : '',
    photos: photosOf(value.photos),
    approx: value.approx === true
  };
}
export function validOutcome(source: unknown, status: unknown): status is CheckStatus {
  return member(reportSources, source) && member(statesBySource[source], status);
}
function cleanChecks(value: unknown, start: string, end: string): Trip['checks'] {
  const checks: Trip['checks'] = {};
  if (!isRecord(value)) return checks;
  for (const source of reportSources) {
    const item = value[source];
    if (isRecord(item) && item.start === start && item.end === end && validOutcome(source, item.status) && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at))) checks[source] = {
      status: item.status,
      start,
      end,
      at: new Date(item.at).toISOString()
    };
  }
  return checks;
}
export function cleanTrip(value: unknown): Trip {
  if (!isRecord(value) || !safeDate(value.start) || !safeDate(value.end) || value.end < value.start || Date.parse(value.end) - Date.parse(value.start) > 730 * 86400000) throw Error('טווח הטיול חייב להיות עד שנתיים');
  const {
    start,
    end
  } = value;
  if (!Array.isArray(value.stops) || value.stops.length > 6500) throw Error('מספר התחנות גדול מדי');
  const stops = value.stops.map(cleanStop),
    ids = new Set(stops.map(s => s.id));
  if (ids.size !== stops.length || stops.some(s => s.date < start || s.date > end)) throw Error('תחנה כפולה או תאריך מחוץ לטווח');
  if (value.googlePins !== undefined && (!Array.isArray(value.googlePins) || value.googlePins.length > googlePinLimit)) {
    throw Error('Invalid Google Pins collection');
  }
  const googlePins = value.googlePins?.map((pin: unknown) => cleanGooglePin(pin, start, end));
  if (googlePins && new Set(googlePins.map(pin => pin.id)).size !== googlePins.length) throw Error('Duplicate Google Pin ID');
  const homeXY = point(value.homeXY);
  const edges: Edge[] = [];
  if (Array.isArray(value.edges)) for (const e of value.edges) {
    if (!isRecord(e) || typeof e.a !== 'string' || typeof e.b !== 'string' || (!ids.has(e.a) && !(e.a === 'base' && homeXY)) || !ids.has(e.b)) continue;
    edges.push({
      a: e.a,
      b: e.b,
      type: member(travelModes, e.type) ? e.type : 'gap',
      m: Math.max(0, Number(e.m) || 0),
      line: Array.isArray(e.line) ? e.line.slice(0, 1000).map(point).filter(p => p !== null) : []
    });
    if (edges.length >= 8000) break;
  }
  const notes = isRecord(value.dayNotes) ? Object.entries(value.dayNotes).filter(([date]) => safeDate(date)) : [];
  return {
    id: text(value.id, 100) || crypto.randomUUID(),
    title: text(value.title, 100),
    start,
    end,
    home: text(value.home),
    homeXY,
    stops,
    ...(googlePins?.length ? { googlePins } : {}),
    edges,
    rules: text(value.rules, 2400),
    checks: cleanChecks(value.checks, start, end),
    dayNotes: Object.fromEntries(notes.map(([date, note]) => [date, text(note, 700)]))
  };
}
export function combineEvidence(target: Stop, source: Stop): void {
  const photos = [...new Set([...target.photos, ...source.photos])];
  if (photos.length > 3) throw Error('ניתן לצרף עד שלוש תמונות לתחנה');
  target.photos = photos;
  target.sources = [...new Set([...target.sources, ...source.sources])];
  target.refs = [...new Set([...target.refs, ...source.refs])];
  target.address ||= source.address;
  target.xy ||= source.xy;
  target.time ||= source.time;
  target.count += source.count;
  if (source.notes && !target.notes.includes(source.notes)) target.notes = [target.notes, source.notes].filter(Boolean).join(' · ');
}
const normalized = (value: string) => value.toLowerCase().replace(/[^\p{L}\d]+/gu, '');
function corroborates(existing: Stop, incoming: Stop): boolean {
  return existing.kind === 'visit' && incoming.kind === 'visit' && normalized(existing.name) === normalized(incoming.name) && (!existing.time || !incoming.time || existing.time === incoming.time) && (!existing.address || !incoming.address || normalized(existing.address) === normalized(incoming.address)) && incoming.sources.length > 0 && existing.sources.every(s => !incoming.sources.includes(s));
}
export function mergeStops(trip: Trip, incoming: readonly unknown[]): MergeResult {
  const result = {
    added: 0,
    linked: 0,
    skipped: 0
  };
  const ids = new Set(trip.stops.map(stop => stop.id));
  const batch = incoming.map(cleanStop);
  // Sort only photo slots, leaving the order of the traveler's other evidence intact.
  const orderedPhotos = batch.filter(photoLocation).sort((a, b) =>
    a.date.localeCompare(b.date) || (a.captureTime || a.time || '99').localeCompare(b.captureTime || b.time || '99'));
  let photoIndex = 0;
  const link = (pin: Stop, stop: Stop) => {
    const was = pin.xy;
    result[linkPhotoReferences(pin, stop)]++;
    // A saved route ends where the pin was. It goes with the move, as it does when the traveler moves a pin.
    if (was && pin.xy && (was[0] !== pin.xy[0] || was[1] !== pin.xy[1])) {
      trip.edges = trip.edges.filter(edge => edge.a !== pin.id && edge.b !== pin.id);
    }
  };
  for (const item of batch) {
    const stop = photoLocation(item) ? orderedPhotos[photoIndex++] : item;
    if (stop.date < trip.start || stop.date > trip.end) throw Error('תחנה מחוץ לטווח הטיול');
    const day = trip.stops.filter(s => s.date === stop.date);
    // Prefer stable asset identity, then a unique named visit, before spatial matching.
    const isPhoto = photoLocation(stop);
    const hasAssetRefs = hasPhotoAssetRefs(stop);
    const refs = new Set(stop.refs);
    const sharesReference = (saved: Stop) => saved.refs.some(ref => refs.has(ref));
    // A photo's asset ID follows the stop when the traveler corrects its day. Other days are searched only for
    // stops they changed, so two photos that happen to share a reference on different days stay separate.
    const repeated = day.find(sharesReference) ?? (hasAssetRefs
      ? trip.stops.find(saved => saved.edited && sharesReference(saved))
      : undefined);
    if (hasAssetRefs && repeated) {
      link(repeated, stop);
      continue;
    }
    if (ids.has(stop.id) || repeated) {
      result.skipped++;
      continue;
    }
    const matches = day.filter(s => corroborates(s, stop) &&
      (!isPhoto || !s.xy || distanceMeters(s.xy, stop.xy) <= photoPinRadiusMeters));
    if (matches.length === 1) {
      combineEvidence(matches[0], stop);
      result.linked++;
      continue;
    }
    if (isPhoto) {
      const pin = closestPhotoPin(day, stop);
      if (pin) {
        link(pin, stop);
        continue;
      }
    }
    stop.rank = Math.max(0, ...day.map(s => s.rank)) + 1;
    trip.stops.push(stop);
    ids.add(stop.id);
    result.added++;
  }
  return result;
}
