import { cleanStop, point, safeDate, type Point, type Stop, type Trip } from './core.ts';

// A short interval and a small radius avoid joining separate visits to the same venue.
const visitMinutes = 30;
const visitRadiusMeters = 75;
function minutes(time: string) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

function nearby(a: Point, b: Point) {
  const longitude = ((a[1] - b[1] + 540) % 360 - 180) * Math.cos((a[0] + b[0]) * Math.PI / 360);
  return Math.hypot(a[0] - b[0], longitude) * 111_195 <= visitRadiusMeters;
}

export const photoHeader = 'hayiti-photo-locations/1';

export function photoVisits(raw: string, trip: Trip, label: string) {
  const rows = raw.trim().split(/\r?\n/);
  if (rows.shift() !== photoHeader || rows.length > 10000) throw Error('Invalid photo location export');
  const visits: Stop[] = [];
  let omitted = 0;
  for (const row of rows.sort()) {
    const [date, time, lat, lon, ...extra] = row.trim().split('|');
    const xy = lat?.trim() && lon?.trim() ? point([Number(lat), Number(lon)]) : null;
    if (extra.length || !xy || !safeDate(date) || date < trip.start || date > trip.end || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) {
      omitted++;
      continue;
    }
    const last = visits.at(-1);
    if (last?.xy && last.date === date && minutes(time) - minutes(last.time) <= visitMinutes && nearby(last.xy, xy)) continue;
    const id = ['photo', date, time, ...xy].join('/');
    visits.push(cleanStop({ id, name: label, date, time, xy, sources: ['photo'], refs: [id] }));
  }
  return { visits, omitted };
}

export function matchingVisit(trip: Trip, visit: Stop) {
  const duplicate = trip.stops.find(s => s.id === visit.id || s.refs.includes(visit.id));
  if (duplicate) return duplicate;
  const matches = trip.stops.filter(s => s.kind === 'visit' && s.date === visit.date && s.time && s.xy && visit.xy &&
    Math.abs(minutes(s.time) - minutes(visit.time)) <= visitMinutes && nearby(s.xy, visit.xy));
  return matches.length === 1 ? matches[0] : undefined;
}

export function savePhotoVisit(trip: Trip, visit: Stop) {
  const match = matchingVisit(trip, visit);
  if (match) {
    if (!match.sources.includes('photo')) match.sources.push('photo');
    if (!match.refs.includes(visit.id) && match.refs.length < 100) match.refs.push(visit.id);
    return;
  }
  const day = trip.stops.filter(s => s.date === visit.date);
  trip.stops.push({ ...visit, rank: 1 + Math.max(0, ...day.map(s => s.rank)) });
}
