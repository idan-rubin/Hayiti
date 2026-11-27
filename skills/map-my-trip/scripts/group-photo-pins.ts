import { readFileSync } from 'node:fs';

type Observation = { id: string; date: string; time: string; xy: [number, number] };
type Place = { date: string; xy: [number, number]; observations: Observation[] };

function valid(item: unknown): item is Observation {
  if (!item || typeof item !== 'object') return false;
  const row = item as Partial<Observation>;
  return typeof row.id === 'string' && row.id.trim().length > 0 &&
    typeof row.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(row.date) &&
    Number.isFinite(Date.parse(row.date + 'T12:00:00Z')) &&
    new Date(row.date + 'T12:00:00Z').toISOString().slice(0, 10) === row.date &&
    typeof row.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?$/.test(row.time) &&
    Array.isArray(row.xy) && row.xy.length === 2 && row.xy.every(Number.isFinite) &&
    Math.abs(row.xy[0]) <= 85 && Math.abs(row.xy[1]) <= 180;
}

function meters(a: Observation['xy'], b: Observation['xy']): number {
  const rad = Math.PI / 180;
  const latitude = (a[0] - b[0]) * rad;
  const longitude = (a[1] - b[1]) * rad;
  const h = Math.sin(latitude / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(longitude / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

const rows: unknown = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(rows) || !rows.every(valid)) throw Error('Expected id, date, local time and valid coordinates for each observation.');
const places: Place[] = [];
const seen = new Set<string>();
for (const row of rows.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id))) {
  if (seen.has(row.id)) continue;
  seen.add(row.id);
  const nearby = places.filter(place => place.date === row.date && meters(place.xy, row.xy) <= 100);
  nearby.sort((a, b) => meters(a.xy, row.xy) - meters(b.xy, row.xy));
  const match = nearby[0];
  if (match) match.observations.push(row);
  else places.push({ date: row.date, xy: row.xy, observations: [row] });
}
console.log(JSON.stringify(places));
