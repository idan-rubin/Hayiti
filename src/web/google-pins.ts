import type { GooglePin, Point, Trip } from '../domain/core.ts';
import { language, locale } from './language.ts';

export function assignGooglePinDay(pin: GooglePin, day: string) {
  if (day) pin.date = day;
  else delete pin.date;
  pin.dayEdited = true;
}

type AssignDay = (pin: GooglePin, day: string) => void;
export interface PinActions {
  assignDay: AssignDay;
  remove(pin: GooglePin): void;
}

function pinPopup(trip: Trip, pin: GooglePin, actions?: PinActions) {
  const he = language === 'he';
  const format = new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: 'UTC' });
  const dateLabel = (day: string) => format.format(new Date(day + 'T12:00:00Z'));
  const content = document.createElement('div');
  content.className = 'google-pin-popup';
  const name = document.createElement('strong');
  name.dir = 'auto';
  name.textContent = pin.name;
  const source = document.createElement('span');
  source.className = 'popup-sources';
  source.textContent = he ? 'סיכת Google' : 'Google Pin';
  const saved = document.createElement('span');
  if (pin.savedAt) {
    const time = document.createElement('time');
    time.dateTime = pin.savedAt;
    time.textContent = dateLabel(pin.savedAt.slice(0, 10));
    if (pin.savedAt.includes('T')) {
      const clock = document.createElement('bdi');
      clock.dir = 'ltr';
      const zone = pin.savedAt.endsWith('Z') ? '' : pin.savedAt.slice(-6);
      clock.textContent = pin.savedAt.slice(11, 16) + ' UTC' + zone;
      time.append(' · ', clock);
    }
    saved.append(he ? 'נשמר בגוגל מפות ב־' : 'Saved in Google Maps on ', time);
  } else saved.textContent = he ? 'תאריך השמירה בגוגל אינו ידוע' : 'Google save date unavailable';
  content.append(name, source, saved);

  const dayLabel = he ? 'יום בטיול' : 'Trip day';
  const unassigned = he ? 'ללא שיוך ליום' : 'No trip day';
  if (actions) {
    const { assignDay, remove } = actions;
    const label = document.createElement('label');
    label.textContent = dayLabel;
    const select = document.createElement('select');
    select.setAttribute('aria-label', dayLabel);
    select.add(new Option(unassigned, ''));
    const end = Date.parse(trip.end + 'T12:00:00Z');
    for (let day = Date.parse(trip.start + 'T12:00:00Z'); day <= end; day += 86_400_000) {
      const date = new Date(day);
      select.add(new Option(format.format(date), date.toISOString().slice(0, 10)));
    }
    select.value = pin.date ?? '';
    select.onchange = () => assignDay(pin, select.value);
    label.append(select);
    const removal = document.createElement('button');
    removal.type = 'button';
    removal.textContent = he ? 'הסרה מהטיול' : 'Remove from trip';
    removal.onclick = () => remove(pin);
    content.append(label, removal);
  } else {
    const assigned = document.createElement('span');
    assigned.textContent = pin.date ? dayLabel + ' · ' + dateLabel(pin.date) : unassigned;
    content.append(assigned);
  }
  return content;
}

/** A null day is the trip overview. Saved places have their own markers, outside the route sequence. */
export function drawGooglePins(trip: Trip, day: string | null, overlay: LayerGroup, actions?: PinActions,
  locate: (xy: Point) => Point = xy => xy, popup?: PopupOptions): Point[] {
  const points: Point[] = [];
  for (const pin of trip.googlePins ?? []) {
    if (day !== null && pin.date !== day) continue;
    const xy = locate(pin.xy);
    const description = pin.name + (language === 'he' ? ' · סיכת Google' : ' · Google Pin');
    const icon = L.divIcon({
      className: 'google-pin',
      html: '<span aria-hidden="true">★</span>',
      iconSize: [30, 30],
      iconAnchor: [0, 30]
    });
    L.marker(xy, { icon, title: description, alt: description }).addTo(overlay)
      .bindPopup(() => pinPopup(trip, pin, actions), popup);
    points.push(xy);
  }
  return points;
}
