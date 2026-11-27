import { cleanStop, isRecord, member, mergeGooglePins, safeDate, sources, type MergeResult, type Stop, type Trip } from './core.ts';
export interface ImportResult {
  stops: Stop[];
  omitted: number;
  checks?: unknown;
  googlePins?: unknown[];
  pinPreview?: MergeResult;
  needsDateOrder?: boolean;
}

/** Preview an agent evidence package against the selected trip without changing its stops or bookmarks. */
export function importEvidencePackage(data: unknown, trip: Trip | null): ImportResult {
  if (!isRecord(data) || !['hayiti-stops/1', 'masluli-stops/1'].includes(String(data.format)) || !Array.isArray(data.stops)) {
    throw Error('פורמט גיבוי לא מוכר');
  }
  if (!trip) throw Error('יש ליצור טיול לפני ייבוא תחנות');
  if (data.tripId !== undefined && data.tripId !== trip.id) throw Error('הטיול השתנה. יש לבחור את קובץ הייבוא מחדש.');
  const stops = data.stops.map(cleanStop);
  const googlePins = data.googlePins;
  let pinPreview: MergeResult | undefined;
  if (googlePins !== undefined) {
    if (!Array.isArray(googlePins)) throw Error('Invalid Google Pins collection');
    if (googlePins.length) pinPreview = mergeGooglePins({ ...trip }, googlePins);
  }
  return {
    stops, omitted: 0,
    ...(googlePins ? { googlePins, pinPreview } : {}),
    checks: data.start === trip.start && data.end === trip.end ? data.sourceChecks : null
  };
}
type DateOrder = 'day-first' | 'month-first';
export function parseDate(s = '', order: DateOrder = 'day-first') {
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso && safeDate(iso[0])) return iso[0];
  const date = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2}|\d{2})\b/);
  if (!date) return '';
  const year = date[3].length === 2 ? '20' + date[3] : date[3];
  const [month, day] = order === 'month-first' ? [date[1], date[2]] : [date[2], date[1]];
  const result = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
  return safeDate(result) ? result : '';
}
export function csvRows(txt: string) {
  txt = txt.replace(/^\uFEFF/, '');
  const delimiter = txt.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : txt.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',';
  const rows = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (ch === '"') {
      if (quoted && txt[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      row.push(field);
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && txt[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw Error('מרכאות לא סגורות בקובץ CSV');
  row.push(field);
  rows.push(row);
  return rows.filter(r => r.some(v => v.trim()));
}
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
function csvTime(raw = ''): string | null {
  if (!raw.trim()) return '';
  const parts = raw.trim().match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)?$/i);
  if (!parts) return null;
  let hour = Number(parts[1]);
  if (parts[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (parts[3].toUpperCase() === 'PM' ? 12 : 0);
  }
  return hour < 24 ? String(hour).padStart(2, '0') + ':' + parts[2] : null;
}
export async function importCsv(txt: string, order?: DateOrder): Promise<ImportResult> {
  const [heads, ...rows] = csvRows(txt);
  if (!heads) throw Error('קובץ ריק');
  const labels = heads.map(h => h.trim().toLowerCase());
  // Candidate headers are listed by preference: the first one present in the file wins.
  const col = (...v: string[]) => {
    for (const candidate of v) {
      const index = labels.indexOf(candidate);
      if (index >= 0) return index;
    }
    return -1;
  };
  // A transaction date says when the purchase happened. A bare "date" may be the posting date.
  const date = col('transaction date', 'תאריך עסקה', 'תאריך העסקה', 'date', 'תאריך');
  const name = col('merchant', 'merchant name', 'שם עסק', 'שם בית העסק', 'בית עסק', 'name', 'שם', 'description', 'תיאור');
  if (date < 0 || name < 0) throw Error('חסרות עמודות תאריך ושם עסק');
  const out = [],
    seen = new Map();
  let omitted = 0;
  const apple = labels.includes('clearing date') && labels.includes('transaction date');
  const dates = rows.map(row => ({
    dayFirst: parseDate(row[date]), monthFirst: parseDate(row[date], 'month-first')
  }));
  const dayFirstOnly = dates.some(d => d.dayFirst && !d.monthFirst);
  const monthFirstOnly = dates.some(d => d.monthFirst && !d.dayFirst);
  const inferred = dayFirstOnly !== monthFirstOnly ? (dayFirstOnly ? 'day-first' : 'month-first') : undefined;
  const dateOrder = order ?? inferred ?? (apple && !dayFirstOnly ? 'month-first' : undefined);
  if (!dateOrder && dates.some(d => d.dayFirst && d.monthFirst && d.dayFirst !== d.monthFirst)) {
    return { stops: [], omitted: 0, needsDateOrder: true };
  }
  const timeColumn = col('time', 'שעה');
  for (const [i, r] of rows.entries()) {
    const { dayFirst, monthFirst } = dates[i];
    const dt = dateOrder === 'month-first' ? monthFirst || dayFirst : dayFirst || monthFirst;
    const title = r[name]?.trim();
    const time = csvTime(r[timeColumn]);
    if (!title || !dt || time === null) {
      omitted++;
      continue;
    }
    const signature = r.join('|'),
      seq = seen.get(signature) || 0;
    seen.set(signature, seq + 1);
    const lat = r[col('latitude', 'lat', 'קו רוחב')],
      lon = r[col('longitude', 'lon', 'lng', 'קו אורך')];
    out.push({
      name: title,
      date: dt,
      address: r[col('address', 'כתובת')],
      xy: lat?.trim() && lon?.trim() ? [Number(lat), Number(lon)] : null,
      time,
      sources: ['card'],
      count: 1,
      refs: ['csv:' + (await hash(signature + '#' + seq))]
    });
  }
  return {
    stops: out.map(cleanStop),
    omitted
  };
}
export async function importIcs(raw: string, translate = (value: string) => value): Promise<ImportResult> {
  const txt = raw.replace(/\r?\n[ \t]/g, ''),
    out = [];
  let omitted = 0;
  for (const block of txt.split('BEGIN:VEVENT').slice(1)) {
    const b = block.split('END:VEVENT')[0];
    const prop = (k: string) => b.split(/\r?\n/).find(v => v.startsWith(k + ':') || v.startsWith(k + ';')) || '';
    const val = (k: string) => prop(k).replace(/^[^:]*:/, '').replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
    const start = val('DTSTART').match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(?:\d\d)?(Z)?)?$/);
    if (!start || !val('SUMMARY')) {
      omitted++;
      continue;
    }
    let dt = start[1] + '-' + start[2] + '-' + start[3],
      time = start[4] ? start[4] + ':' + start[5] : '';
    const tz = prop('DTSTART').match(/TZID=([^:;]+)/)?.[1];
    const notes = start[6] ? translate('השעה בקובץ היא UTC. יש לאמת את שעת המקום.') : tz ? translate('שעה מקומית לפי ') + tz : '';
    if (start[6]) time = '';
    out.push({
      date: dt,
      name: val('SUMMARY'),
      address: val('LOCATION'),
      time,
      sources: ['calendar'],
      refs: ['ics:' + (await hash((val('UID') || b) + '|' + val('DTSTART')))],
      notes: notes + (prop('RRULE') ? translate(' · אירוע חוזר, מוצג המופע הראשון בלבד.') : '')
    });
  }
  return {
    stops: out.map(cleanStop),
    omitted
  };
}
export function pastedStop(raw: string, day: string, source = 'whatsapp'): Partial<Stop> {
  if (source === 'email' && /^(From|MIME-Version|Return-Path|Received|Subject|Delivered-To|Date|To):/im.test(raw) && /\r?\n\r?\n/.test(raw)) {
    const split = raw.search(/\r?\n\r?\n/),
      head = raw.slice(0, split).replace(/\r?\n[ \t]/g, ' ');
    const subject = (head.match(/^Subject:\s*(.*)$/im)?.[1] || '').replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, b) => {
      try {
        return new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)));
      } catch {
        return '';
      }
    });
    let body = raw.slice(split).trim();
    if (/Content-Transfer-Encoding:\s*base64/i.test(head)) {
      try {
        body = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s/g, '')), c => c.charCodeAt(0)));
      } catch {}
    }
    if (/quoted-printable/i.test(head)) {
      body = body.replace(/=\r?\n/g, '').replace(/(?:=[A-F0-9]{2})+/gi, c => {
        try {
          return decodeURIComponent(c.replace(/=/g, '%'));
        } catch {
          return c;
        }
      });
    }
    body = body.replace(/<[^>]+>/g, ' ').split(/\n--[^-].*$/m)[0];
    raw = [subject, body].join('\n');
  }
  const cleaned = raw.split(/\r?\n/).filter(l => !/^https?:|\b(?:QR|ticket ID)\b/i.test(l));
  const line = cleaned.find(l => l.trim() && !/^(From:|Date:|To:|Content-|MIME-|Received:)/i.test(l)) || '';
  const name = (cleaned.find(l => /^subject:/i.test(l)) || line).replace(/^subject:\s*/i, '').replace(/^הכרטיס שלי לאירוע\s*/, '').split(/\(\d{1,2}[./]/)[0].trim().slice(0, 145);
  const m = raw.match(/(?:כתובת|מיקום|location|address)\s*[:：]\s*([^\n\r]+)/i);
  return {
    date: parseDate(raw) || day,
    name,
    address: m?.[1] || '',
    time: raw.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0] || '',
    sources: [member(sources, source) ? source : 'manual'],
    notes: ''
  };
}
