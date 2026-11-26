import { element as $, errorMessage } from './dom.ts';
import { member, reportSources, statesBySource, validOutcome, isRecord } from '../domain/core.ts';
import type { Trip, Stop, Source, CheckStatus, Point, MergeResult } from '../domain/core.ts';
import type { ImportResult } from '../domain/importers.ts';
import { language, locale, bindLanguageControl } from './language.ts';
import { displayTripTitle, messages, t, quantity } from './journal-messages.ts';
import { enableSharing } from './share-ui.ts';
import { routeStops, indexEdges, offRoute, suggest, walkingStats } from '../domain/daily-route.ts';
import { createDateReel } from './date-reel.ts';
import { cleanTrip, cleanStop, mergeStops, combineEvidence, journalCharacterLimit } from '../domain/core.ts';
import { importCsv, importIcs, pastedStop } from '../domain/importers.ts';
import { checkGuestBackup, discardGuest } from './guest-draft.ts';
import { JournalSession, localToday } from './journal-session.ts';
import { preparePhoto } from './photos.ts';
import { ask, clearError, showError } from './confirm.ts';
import sampleTrip from '../../public/sample-trip.json' with { type: 'json' };
const hebrewLabels = Object.fromEntries(Object.entries(messages).map(([he, en]) => [en, he]));
bindLanguageControl(hebrewLabels, refreshLanguage);
const portable = document.documentElement.hasAttribute('data-portable');
const hostedView = !portable && location.hash.startsWith('#route=');
if (hostedView) document.body.classList.add('hosted-view', 'route-copy');
const embeddedRoute = portable ? document.getElementById('hayiti-route') : null;
const sharedRoute = hostedView || embeddedRoute;
const session = new JournalSession();
let draftPhotos: string[] = [],
  photoBusy = false,
  fileEpoch = 0;
function dom<K extends keyof HTMLElementTagNameMap>(tag: K, str?: string, cls?: string) {
  const e = document.createElement(tag);
  if (str !== undefined) e.textContent = str;
  if (cls) e.className = cls;
  return e;
}
const label = {
  card: 'כרטיס אשראי',
  email: 'מייל',
  calendar: 'יומן',
  ticket: 'כרטיס לאירוע',
  whatsapp: 'WhatsApp',
  manual: 'ידני',
  taxi: 'קבלת מונית',
  transfer: 'העברה',
  diary: 'יומן אישי',
  photo: 'תמונה'
};
function formats(region: string) {
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(region, {
    ...options,
    timeZone: 'UTC'
  });
  return {
    full: format({
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    }),
    short: format({
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    }),
    range: format({
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }),
    distance: new Intl.NumberFormat(region, {
      maximumFractionDigits: 1
    })
  };
}
const dateFormats = {
  he: formats('he-IL'),
  en: formats('en-US')
};
const dateLabel = (iso: string, style: 'full' | 'short' | 'range' = 'full') => dateFormats[language][style].format(new Date(iso + 'T12:00:00Z'));
const rangeDate = (iso: string) => language === 'he' ? iso.split('-').reverse().join('.') : dateLabel(iso, 'range');
let selected = '',
  draftId = '',
  pick = false,
  creating = false;
type Tone = '' | 'warning' | 'error';
let currentStatus = () => '',
  currentTone: Tone = '';
let heldStatus: [() => string, Tone] | null = null;
function msg(message: string | (() => string), tone: Tone = '') {
  heldStatus = null;
  currentStatus = typeof message === 'function' ? message : () => t(message);
  currentTone = tone;
  $('status').textContent = currentStatus();
  $('status').dataset.tone = tone;
}
// A hint answers the last action. The status it covered returns when the traveler moves on.
function hint(message: () => string, tone: Tone = '') {
  const held = heldStatus ?? [currentStatus, currentTone];
  msg(message, tone);
  heldStatus = held;
}
function endHint() {
  if (heldStatus) msg(...heldStatus);
}
// Failures appear in the open dialog, or in the status line when none is open.
const fail = (message: string) => showError(message, text => msg(() => text, 'error'));
const button = (title: string, fn: () => void) => {
  const b = dom('button', title);
  b.type = 'button';
  b.onclick = fn;
  return b;
};
const map = L.map('map', {
  zoomControl: true,
  scrollWheelZoom: true,
  trackResize: false,
  zoomSnap: .25
}).setView([30, 15], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  referrerPolicy: 'strict-origin',
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const overlay = L.layerGroup().addTo(map);
const rows = new Map<string, HTMLElement>(),
  marks = new Map<string, MapMarker>();
let popupFor = '';
let routeBounds = L.latLngBounds([]),
  fitFrame = 0;
function fitDailyRoute() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const {
      clientWidth: width,
      clientHeight: height
    } = map.getContainer();
    if (!width || !height) return;
    map.stop();
    map.invalidateSize({
      pan: false,
      animate: false
    });
    if (!routeBounds.isValid()) {
      map.setView([30, 15], 2, {
        animate: false
      });
    } else if (routeBounds.getSouthWest().equals(routeBounds.getNorthEast())) {
      map.setView(routeBounds.getCenter(), 15, {
        animate: false
      });
    } else {
      const margin = Math.min(36, Math.round(Math.min(width, height) * .12));
      map.fitBounds(routeBounds, {
        padding: [margin, margin],
        maxZoom: 16,
        animate: false
      });
    }
    // Opening after the fit lets the map pan just enough to show the whole popup.
    const mark = marks.get(popupFor);
    if (mark) {
      map.closePopup();
      mark.openPopup();
    }
  });
}
new ResizeObserver(fitDailyRoute).observe(map.getContainer());
function points(v: string): Point | null {
  if (!v?.trim()) return null;
  const a = v.split(/[,;\s]+/).filter(Boolean).map(Number);
  if (a.length !== 2 || !a.every(Number.isFinite) || Math.abs(a[0]) > 85 || Math.abs(a[1]) > 180) throw Error(t('המיקום צריך לכלול קו רוחב וקו אורך תקינים'));
  return [a[0], a[1]];
}
function dateRange(t: Trip) {
  const days = [];
  for (let ms = Date.parse(t.start + 'T12:00Z'); ms <= Date.parse(t.end + 'T12:00Z'); ms += 864e5) days.push(new Date(ms).toISOString().slice(0, 10));
  return days;
}
function renderSelection() {
  selected = '';
  render();
}
const ui = (en: string, he: string) => language === 'en' ? en : he;
const sourceNames = {
  finances: 'Finances',
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive'
};
const outcomeText: Record<CheckStatus | 'unchecked', [string, string]> = {
  unchecked: ['Not checked for this trip', 'טרם נבדק לטיול הזה'],
  checked: ['Checked for these dates', 'נבדק לתאריכי הטיול'],
  disconnected: ['Connect this source in ChatGPT to include its stops.', 'כדי להוסיף תחנות מהמקור הזה, אפשר לחבר אותו ב־ChatGPT.'],
  no_accounts: ['Finances is connected. Link a credit card or a checking account used for debit purchases to find stops from payments.', 'Finances מחובר. כדי למצוא תחנות לפי חיובים, יש לקשר כרטיס אשראי או חשבון עו״ש המשמש לרכישות בדביט.'],
  no_transactions: ['No transactions in the accounts checked for these dates. You can still add a stop by hand or use receipts from Gmail.', 'לא נמצאו עסקאות בחשבונות שנבדקו בתאריכים האלה. עדיין אפשר להוסיף תחנה ידנית או להיעזר בקבלות מ־Gmail.'],
  no_places: ['Purchases found, but none could be placed on the map.', 'נמצאו רכישות, אך לא זוהה עבורן מקום במפה.'],
  syncing: ['Still syncing. Check again later.', 'הסנכרון עדיין מתבצע. כדאי לבדוק שוב בהמשך.'],
  failed: ['Couldn’t finish the check. Retry this source in ChatGPT.', 'הבדיקה לא הושלמה. אפשר לנסות שוב ב־ChatGPT.'],
  partial: ['Only part of the requested data was checked.', 'רק חלק מהנתונים המבוקשים נבדקו.'],
  unavailable: ['Unavailable in this session. You can still add stops manually.', 'המקור אינו זמין בשיחה הזאת. אפשר להוסיף תחנות ידנית.']
};
const types = {
  email: ['✉', '#225e9c'],
  calendar: ['▦', '#714b9a'],
  card: ['▤', '#197256'],
  transfer: ['⇄', '#197256'],
  ticket: ['◆', '#8d561b'],
  manual: ['✎', '#56616b'],
  diary: ['✎', '#56616b'],
  taxi: ['T', '#8d561b'],
  photo: ['▣', '#73506e'],
  whatsapp: ['✆', '#276a58']
};
const glyphs: Partial<Record<Source, string>> = {
  email: '<rect x="2" y="4" width="16" height="12" rx="2"/><path d="m3 5 7 5 7-5"/>',
  calendar: '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M6 2v4m8-4v4M3 8h14m-10 4h2m2 0h2"/>',
  card: '<rect x="2" y="4" width="16" height="12" rx="2"/><path d="M2 8h16M5 12h4"/>'
};
function pinSymbol(key: Source) {
  return glyphs[key] ? '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' + glyphs[key] + '</svg>' : types[key][0];
}
function showConnections() {
  const { trip } = session;
  const chip = $('connections');
  const rows = $('checkRows');
  // Only a signed-in journal is visible to ChatGPT. Every other journal imports the stops file it returns.
  const viaFile = portable || session.mode !== 'account';
  $('connected').querySelector('h3')!.textContent = t(viaFile ? 'ייבוא נתונים מ־ChatGPT' : 'הצלבה דרך ChatGPT');
  $('connected').querySelector('p')!.textContent = portable
    ? t('העתק את בקשת הסנכרון לשיחה שלך. אפשר לייבא כאן את קובץ התחנות שמתקבל.')
    : viaFile
      ? ui('You are not signed in, so ChatGPT cannot add stops to this trip directly. Copy the sync request into your conversation, then import the stops file it returns under Files. Sign in with ChatGPT to have stops added for you.',
        'לא נכנסת לחשבון, ולכן ChatGPT לא יכול להוסיף תחנות לטיול הזה ישירות. אפשר להעתיק את בקשת הסנכרון לשיחה ולייבא את קובץ התחנות שמתקבל בלשונית ״קבצים״. אחרי כניסה עם ChatGPT התחנות יתווספו עבורך.')
      : t('עם חיבור ״הייתי״ בשיחה, ChatGPT יכול לקרוא את המקורות שאישרת ולהוסיף את התחנות לטיול הזה. בחר אילו מקורות לכלול בבקשה. לפני שמירה, אשר רק מקומות ופרטי ביקור שברצונך להעביר ליומן.');
  const controls = [...$('connected').querySelectorAll('label.check')];
  rows.replaceChildren();
  let disconnected = 0,
    attention = 0;
  for (const key of reportSources) {
    const name = sourceNames[key];
    const item = trip?.checks?.[key];
    const status = item?.status || 'unchecked';
    if (status === 'disconnected') disconnected++;
    if (['failed', 'partial', 'no_accounts', 'unavailable', 'syncing'].includes(status)) attention++;
    const row = dom('div', undefined, 'check-row');
    row.dataset.status = status;
    const control = controls.find(label => label.querySelector('input')?.value === name);
    row.append(control || dom('strong', name), dom('span', ui(...(outcomeText[status] || outcomeText.unchecked))));
    if (!item && key === 'finances') row.append(dom('small', ui('Purchase lookup needs a linked credit card or debit account.', 'לחיפוש רכישות נדרש חשבון מקושר המשמש לרכישות באשראי או בדביט.')));
    if (item) row.append(dom('small', ui('Last checked ', 'בדיקה אחרונה ') + new Date(item.at).toLocaleString(locale())));
    rows.append(row);
  }
  const financeStatus = trip?.checks.finances?.status;
  chip.dataset.notice = disconnected || attention ? 'attention' : 'info';
  if (disconnected) {
    chip.textContent = disconnected === 1
      ? ui('1 source disconnected', 'מקור אחד מנותק')
      : ui(disconnected + ' sources disconnected', disconnected + ' מקורות מנותקים');
  } else if (financeStatus === 'no_accounts') {
    chip.textContent = ui('Link a payment account', 'חיבור חשבון לתשלומים');
  } else if (attention) {
    chip.textContent = ui('Review connections', 'בדיקת חיבורים');
  } else if (financeStatus === 'no_transactions') {
    chip.textContent = ui('No transactions for these dates', 'אין עסקאות בתאריכים האלה');
  } else if (financeStatus === 'no_places') {
    chip.textContent = ui('Purchases without a location', 'חיובים ללא מיקום');
  } else {
    chip.textContent = ui('Connections', 'חיבורים');
    delete chip.dataset.notice;
  }
  // Without a notice the chip only repeats Sources and import.
  chip.hidden = !!sharedRoute || !chip.dataset.notice;
}
function render() {
  const { trip, day } = session;
  showConnections();
  $('title').textContent = trip ? displayTripTitle(trip.title) : t('הטיולים שלי');
  $('range').textContent = trip ? rangeDate(trip.start) + t(' עד ') + rangeDate(trip.end) + (trip.home ? t(' · יציאה מ') + trip.home : '') : t('אפשר להתחיל מטיול חדש או לייבא טיול קיים.');
  $('trips').replaceChildren(...session.trips.map(t => new Option(displayTripTitle(t.title), t.id)));
  if (trip) $('trips').value = trip.id;
  $('trips').hidden = session.trips.length < 2;
  for (const id of ['add', 'export', 'settings', 'organize'] as const) $(id).disabled = !trip;
  const days = trip ? dateRange(trip) : [];
  setDates(days, day, days.map(date => {
    const count = trip?.stops.filter(stop => stop.date === date && stop.kind !== 'origin' && !offRoute(stop)).length ?? 0;
    return count ? stopCount(count) : '';
  }));
  $('dayTitle').hidden = !!trip;
  document.body.classList.toggle('no-trip', !trip);
  $('welcome').hidden = !!trip || !!sharedRoute || !journalReady;
  draw();
}
const stopCount = (count: number) => count === 1 ? t('תחנה אחת') : count + t(' תחנות');
const setDates = createDateReel($('dayReel'), $('tripDate'), dateLabel, next => {
  if (next === session.day) return;
  session.select(session.trip, next);
  selected = '';
  endHint();
  draw();
});
function distanceLabel(meters: number) {
  return meters < 1000 ? Math.max(1, Math.round(meters / 10) * 10) + t(' מ׳') : dateFormats[language].distance.format(meters / 1000) + t(' ק״מ');
}
function showDailyStats(stats: ReturnType<typeof walkingStats>) {
  const { trip } = session;
  const stopLabel = stopCount(stats.stopCount);
  $('count').textContent = stopLabel;
  $('dayStats').hidden = !trip;
  if (!trip) return;
  const meters = stats.estimatedWalkingMeters;
  const excluded = stats.unknownLegs;
  $('statStops').textContent = stopLabel;
  const onlyRide = meters === null && stats.taxiLegs > 0 && !excluded;
  $('walkSummary').textContent = meters !== null ? t('כ־') + distanceLabel(meters) + t(' הליכה') + (excluded ? t(' · אומדן חלקי') : language === 'he' ? ' משוערת' : '') : onlyRide ? t('אין מקטע הליכה מתועד') : t('אין מספיק מידע לאומדן הליכה');
  const minutesAt = (kph: number) => Math.max(1, Math.round((meters ?? 0) * 60 / (1000 * kph)));
  const low = minutesAt(4),
    high = minutesAt(3);
  $('walkTime').textContent = meters === null ? '' : t('כ־') + (low === high ? low : low + '–' + high) + t(' דק׳ הליכה בקצב של 3–4 קמ״ש.');
  const coverage = [];
  if (stats.walkingLegs) coverage.push(stats.walkingLegs === 1 ? t('מקטע הליכה אחד באומדן') : stats.walkingLegs + t(' מקטעי הליכה באומדן'));
  if (stats.taxiLegs) coverage.push(stats.taxiLegs === 1 ? t('נסיעה אחת במונית') : stats.taxiLegs + t(' נסיעות במונית'));
  if (excluded) coverage.push(excluded === 1 ? t('מקטע אחד הושמט בגלל מידע חסר על ההליכה') : excluded + t(' מקטעים הושמטו בגלל מידע חסר על ההליכה'));
  $('walkCoverage').textContent = coverage.join(' · ') || t('נדרשים לפחות שני מקומות ומקטע הליכה ביניהם כדי לחשב מרחק.');
  const leg = stats.longest;
  $('longestWalk').textContent = stats.walkingLegs > 1 && leg ? t('מקטע ההליכה הארוך במסלול המשוער הוא מ') + leg.from + t(' ל') + leg.to + t(', כ־') + distanceLabel(leg.meters) + '.' : '';
}
function draw() {
  const { trip, day } = session;
  const list = routeStops(trip, day, t('נקודת מוצא')),
    edges = indexEdges(trip);
  showDailyStats(walkingStats(list, edges));
  $('stops').replaceChildren();
  overlay.clearLayers();
  routeBounds = L.latLngBounds([]);
  rows.clear();
  marks.clear();
  popupFor = '';
  let prev = null;
  for (const [i, s] of list.entries()) {
    const li = dom('li', undefined, 'stop');
    li.classList.toggle('activeStop', selected === s.id);
    rows.set(s.id, li);
    const number = s.kind === 'origin' ? '⌂' : String(i + (list[0]?.kind === 'origin' ? 0 : 1));
    if (s.xy) {
      const locate = button(number, () => reveal(s.id, 'pin'));
      locate.className = 'num';
      locate.setAttribute('aria-label', ui('Show on map: ', 'הצגה במפה: ') + s.name);
      li.append(locate);
    } else li.append(dom('span', number, 'num'));
    const col = dom('div');
    const open = sharedRoute ? dom('strong', s.name) : button(s.name, () => {
      if (s.id === 'base') {
        openSettings(false);
        return;
      }
      openStop(s);
    });
    open.className = 'stopname';
    col.append(open);
    const hints = [s.time, s.address, s.band, s.approx ? t('מיקום משוער') : '', s.xy ? '' : t('ללא סיכה')].filter(Boolean);
    col.append(dom('div', hints.join(' · '), 'meta'));
    const evidence = [...(s.sources || []).map(k => t(label[k])), s.count ? quantity(s.count, ' חיובים', 'charge', 'charges') : '', s.photos?.length ? quantity(s.photos.length, ' תמונות', 'photo', 'photos') : ''].filter(Boolean).join(' · ');
    if (evidence) col.append(dom('span', evidence, 'src'));
    if (s.notes) col.append(dom('div', s.notes, 'meta'));
    const actions = dom('div', undefined, 'tools');
    if (s.kind !== 'origin') {
      for (const [sign, delta] of [['↑', -1], ['↓', 1]] as const) {
        const b = button(sign, () => void move(s, delta));
        b.setAttribute('aria-label', delta < 0 ? t('הקדמת ') + s.name : t('דחיית ') + s.name);
        b.disabled = !list[i + delta] || list[i + delta].kind === 'origin';
        actions.append(b);
      }
    }
    li.append(col, actions);
    $('stops').append(li);
    if (s.xy) {
      routeBounds.extend(s.xy);
      const keys = (s.sources || []).filter(k => Object.hasOwn(types, k));
      const primary = keys[0];
      const badge = s.kind !== 'origin' && primary ? '<span class="pin-source" style="background:' + types[primary][1] + '">' + pinSymbol(primary) + '</span>' : '';
      const description = [s.name, ...keys.map(k => k === 'card' ? ui('Transaction', 'עסקה') : t(label[k]))].join(' · ');
      const icon = L.divIcon({
        className: 'pin ' + (s.kind === 'origin' ? 'home ' : '') + (s.approx ? 'soft' : ''),
        html: s.kind === 'origin' ? '⌂' : String(i + (list[0]?.kind === 'origin' ? 0 : 1)) + badge,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
      const mark = L.marker(s.xy, {
        icon,
        title: description,
        alt: description
      }).addTo(overlay);
      const content = dom('div');
      content.append(dom('strong', s.name), dom('div', [s.time, s.address].filter(Boolean).join(' · ')));
      if (keys.length) content.append(dom('div', keys.map(k => types[k][0] + ' ' + (k === 'card' ? ui('Transaction', 'עסקה') : t(label[k]))).join(' · '), 'popup-sources'));
      if (!sharedRoute) content.append(button(ui('Edit details', 'עריכת הפרטים'), () => {
        map.closePopup();
        if (s.id === 'base') openSettings(false);
        else openStop(s);
      }));
      mark.bindPopup(content);
      mark.on('click', () => reveal(s.id, 'row'));
      marks.set(s.id, mark);
      if (prev?.xy) {
        const edge = edges.get(prev.id + '|' + s.id);
        if (edge?.type !== 'same') {
          const line = edge?.line?.length ? edge.line : [prev.xy, s.xy];
          const taxi = edge?.type === 'taxi';
          L.polyline(line, {
            color: taxi ? '#b96331' : '#267957',
            weight: 3,
            dashArray: taxi ? '9 7' : edge?.type === 'walk' ? null : '5 7',
            opacity: .85
          }).addTo(overlay);
          routeBounds.extend(line);
        }
      }
    }
    prev = s;
  }
  // A day without pins keeps the map on the rest of the trip instead of zooming out to the world.
  if (!routeBounds.isValid() && trip) {
    for (const stop of trip.stops) if (stop.xy) routeBounds.extend(stop.xy);
    if (trip.homeXY) routeBounds.extend(trip.homeXY);
  }
  fitDailyRoute();
  if (!list.length && $('welcome').hidden) $('stops').append(dom('li', trip ? t('עדיין אין תחנות ליום הזה.') : t('כאן יופיעו תחנות הטיול לפי יום.'), 'empty'));
  $('dayNote').textContent = trip?.dayNotes?.[day] || '';
  $('dayNote').hidden = !$('dayNote').textContent;
  const other = trip?.stops.filter(s => s.date === day && offRoute(s)) || [];
  $('other').hidden = !other.length;
  $('otherList').replaceChildren(...other.map(s => button(s.name + (s.kind === 'remote' ? t(' · מרחוק') : t(' · לבירור')), () => openStop(s))));
}
// Connects a stop's row with its pin: choosing one points at the other.
function reveal(id: string, target: 'row' | 'pin') {
  selected = id;
  for (const [key, row] of rows) row.classList.toggle('activeStop', key === id);
  if (target === 'row') {
    rows.get(id)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  // On a phone the map was hidden behind the list and is measured again as it appears.
  popupFor = id;
  map.closePopup();
  viewList(false);
  setTimeout(() => {
    if (popupFor === id) popupFor = '';
  }, 600);
}
// A journal kept only in this tab is lost when the tab closes.
const tabOnly = () => session.mode === 'guest' || session.mode === 'memory';
const saveTone = (): Tone => tabOnly() && session.trips.length ? 'warning' : '';
function noTimeCopy() {
  return portable ? session.mode === 'portable' ? 'נשמר בדפדפן הזה.' : 'השינויים בזיכרון הלשונית. לשמירה יש להוריד גיבוי.' : session.mode === 'account' ? 'השינויים נשמרו ביומן האישי.' : 'השינויים נשמרו בלשונית הזאת. אפשר לייצא גיבוי או להיכנס ל־ChatGPT.';
}
let viewRequest = 0,
  loadedHosted = false;
async function loadHostedRoute() {
  const epoch = ++viewRequest;
  if (!loadedHosted) msg(() => ui('Loading the shared route…', 'טוען את המסלול המשותף…'));
  const res = await fetch('/api/route-links', {
    method: loadedHosted ? 'HEAD' : 'GET',
    cache: 'no-store',
    headers: {
      'X-Hayiti-View': location.hash.slice(7)
    },
    referrerPolicy: 'no-referrer'
  });
  if (epoch !== viewRequest) return;
  if (!res.ok) {
    // Only a revoked link removes a route that is already on screen. Other failures are retried on the next check.
    if (loadedHosted && res.status !== 404) return;
    session.showSnapshot(null);
    loadedHosted = false;
    document.body.classList.remove('route-ready');
    renderSelection();
    map.closePopup();
    $('routeGone').hidden = res.status !== 404;
    msg(res.status === 404 ? 'הקישור בוטל או אינו זמין.' : 'לא ניתן לטעון את המסלול כרגע.', 'error');
    return;
  }
  if (loadedHosted) return;
  $('routeGone').hidden = true;
  const snapshot = cleanTrip(await res.json());
  if (epoch !== viewRequest) return;
  session.showSnapshot(snapshot);
  loadedHosted = true;
  document.body.classList.add('route-ready');
  renderSelection();
  msg('מסלול משותף · לצפייה בלבד');
}
if (hostedView) {
  const check = () => {
    if (!document.hidden) loadHostedRoute().catch(() => {
      if (!loadedHosted) msg('לא ניתן לטעון את המסלול כרגע.', 'error');
    });
  };
  setInterval(check, 15000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pageshow', e => {
    if (e.persisted) check();
  });
}
window.addEventListener('hashchange', () => {
  if (hostedView || location.hash.startsWith('#route=')) location.reload();
});
let journalReady = false;
// A quiet load is the automatic check when the traveler returns to the tab. It redraws only when the journal changed.
async function load(afterConflict = false, quiet = false) {
  if (hostedView) return loadHostedRoute();
  if (embeddedRoute) {
    session.showSnapshot(cleanTrip(JSON.parse(embeddedRoute.textContent ?? 'null')));
    document.body.classList.add('route-copy');
    renderSelection();
    msg('עותק של המסלול לצפייה');
    return;
  }

  const revision = session.revision;
  const result = await session.load(portable, title => {
    const suffix = ui(' (before sign-in)', ' (לפני הכניסה)');
    return displayTripTitle(title).slice(0, 100 - suffix.length) + suffix;
  }, afterConflict);
  if (result.kind === 'unchanged') return;
  if (quiet && result.kind === 'account' && session.revision === revision) return result.kind;
  const unreadable = result.kind === 'unreadable-draft';
  journalReady = !unreadable;
  $('retryLoad').hidden = true;
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-requires-journal]')) control.disabled = unreadable;
  if (unreadable) tab('connected');
  $('range').hidden = unreadable;
  $('discardDraft').hidden = !unreadable;
  $('login').hidden = result.kind !== 'guest' && result.kind !== 'signed-out';
  renderSelection();
  switch (result.kind) {
    case 'unreadable-draft':
      msg(() => t(result.reason) + ui(' Choose Discard unreadable draft to continue.',
        ' כדי להמשיך, בחרו ב״מחיקת טיוטה שלא ניתן לקרוא״.'));
      break;
    case 'portable':
      msg(session.mode === 'portable' ? 'עותק אישי בדפדפן הזה' : 'אפשר ליצור טיול. לשמירה בדפדפן זה יש להוריד גיבוי.', saveTone());
      break;
    case 'signed-out':
      msg(() => ui('You are signed out. Sign in with ChatGPT to open your journal.', 'יצאת מהחשבון. כדי לפתוח את היומן נכנסים שוב עם ChatGPT.'));
      break;
    case 'guest':
      msg(session.trips.length ? noTimeCopy() : 'אפשר להתנסות כאן. לשמירה בין מכשירים נכנסים עם ChatGPT.', saveTone());
      break;
    case 'account':
      msg('היומן האישי מעודכן.');
      break;
    case 'merge-conflict':
      msg(() => ui('Your journal changed during sign-in. Your trips are still in this tab. Choose Refresh journal to add them.',
        'היומן השתנה במהלך הכניסה. הטיולים עדיין שמורים בלשונית הזאת. כדי להוסיף אותם, בחרו ברענון היומן.'));
      break;
    case 'merge-not-sent':
      msg(() => ui('This tab couldn’t prepare the save. No trips were sent this time. Use Back up trip for each trip, then import the backups in a new tab.',
        'הלשונית לא הצליחה להכין את הטיולים לשמירה. הפעם לא נשלחו טיולים. גבו כל טיול בנפרד וייבאו את הגיבויים בלשונית חדשה.'));
      break;
    case 'unconfirmed':
      msg(() => ui('We couldn’t confirm the save. Your trips are still in this tab. Choose Refresh journal to check.',
        'לא התקבל אישור שמירה. הטיולים עדיין שמורים בלשונית הזאת. לבדיקה, בחרו ברענון היומן.'));
      break;
    case 'refused':
      msg(() => {
        const reason = t(result.reason).replace(/\.$/, '');
        return ui('Signed in, but your journal could not take the trips from this tab (' + reason + '). Back them up or delete them here, then choose Refresh journal to open your journal.',
          'הכניסה הצליחה, אבל היומן לא קיבל את הטיולים מהלשונית הזאת (' + reason + '). אפשר לגבות או למחוק אותם כאן, ואז לבחור ברענון היומן כדי לפתוח את היומן.');
      });
      break;
    case 'merged':
      msg(() => result.copies
        ? ui('Your changes from before signing in were kept as a separate copy of the trip.', 'השינויים שנעשו לפני הכניסה נשמרו כעותק נפרד של הטיול.')
        : result.trips === 1
          ? ui('The trip you started before signing in is now in your journal.', 'הטיול שהתחלת לפני הכניסה נוסף ליומן האישי.')
          : ui('The trips you started before signing in are now in your journal.', 'הטיולים שהתחלת לפני הכניסה נוספו ליומן האישי.'));
  }
  return result.kind;
}

// Trips edited in a tab-only journal since their last backup. Leaving the page with any of them asks first.
const unbacked = new Set<string>();
let signingIn = false;
// `fromFile` marks a change that only loads a trip the traveler already has as a file.
async function change(edit: () => void, fromFile = false) {
  for (const dialog of document.querySelectorAll<HTMLElement>('dialog[open]')) clearError(dialog);
  try {
    const result = await session.change(edit);
    if (result === 'ignored') return false;
    if (result === 'loading') {
      fail(ui('Please try this edit again when the journal is ready.', 'נסו לשמור את השינוי שוב כשהיומן יהיה מוכן.'));
      return false;
    }
    if (result === 'superseded') {
      fail(t('העריכה לא נשמרה. היומן השתנה. בדקו את הטיול הנוכחי לפני שתנסו שוב.'));
      return false;
    }
    if (result === 'saved-after-refresh') return true;
    renderSelection();
    if (result === 'conflict') {
      const loaded = await load(true);
      fail(t(loaded === 'account' ? 'הטיול השתנה במכשיר אחר. הגרסה העדכנית נטענה. אפשר לחזור על העריכה.'
        : 'העריכה לא נשמרה. היומן השתנה. בדקו את הטיול הנוכחי לפני שתנסו שוב.'));
      return false;
    }
    if (result === 'storage-error') {
      fail(ui('This browser could not save the edit. Back up your trip, then free storage or remove a photo and try again.',
        'הדפדפן לא הצליח לשמור את העריכה. גבו את הטיול, פנו מקום או הסירו תמונה ונסו שוב.'));
      return false;
    }
    if (tabOnly() && !fromFile && session.trip) unbacked.add(session.trip.id);
    for (const id of unbacked) if (!session.trips.some(trip => trip.id === id)) unbacked.delete(id);
    msg(noTimeCopy(), saveTone());
    return true;
  } catch (error) {
    renderSelection();
    fail(t(errorMessage(error)));
    return false;
  }
}
for (const id of ['login', 'hostedSignIn'] as const) $(id).addEventListener('click', () => {
  signingIn = true; // The draft travels through sign-in in this tab, so leaving for it needs no warning.
});
window.addEventListener('beforeunload', event => {
  if (signingIn || !tabOnly() || !unbacked.size) return;
  event.preventDefault();
});

$('trips').onchange = () => {
  session.select(session.trips.find(trip => trip.id === $('trips').value));
  endHint();
  renderSelection();
};
async function move(s: Stop, delta: number) {
  const { trip, day } = session;
  if (!trip) return;
  const moved = await change(() => {
    const list = routeStops(trip, day, t('נקודת מוצא')).filter(x => x.id !== 'base'),
      i = list.findIndex(x => x.id === s.id);
    if (!list[i + delta] || list[i + delta].kind === 'origin') return;
    [list[i], list[i + delta]] = [list[i + delta], list[i]];
    list.forEach((x, j) => x.rank = j);
    delete trip.dayNotes[day];
  });
  if (!moved) return;
  // The list was redrawn. Return focus to the same arrow, or its neighbor at the end of the list.
  const arrows = [...rows.get(s.id)?.querySelectorAll<HTMLButtonElement>('.tools button') ?? []];
  (arrows[delta < 0 ? 0 : 1]?.disabled ? arrows[delta < 0 ? 1 : 0] : arrows[delta < 0 ? 0 : 1])?.focus();
}
$('organize').onclick = async () => {
  const { trip, day } = session;
  if (!trip) return;
  const list = routeStops(trip, day, t('נקודת מוצא')).filter(x => x.id !== 'base');
  if (list.some(s => ['pickup', 'dropoff'].includes(s.kind))) {
    hint(() => t('ביום הזה יש נסיעת מונית מתועדת. אפשר להזיז תחנות בנפרד ולשמור על זמני האיסוף וההגעה.'));
    return;
  }
  if (list.filter(s => s.kind === 'visit').length < 2) {
    hint(() => ui('Add at least two stops to this day to get a suggested order.', 'כדי לקבל הצעה לסדר, יש להוסיף ליום הזה שתי תחנות לפחות.'));
    return;
  }
  try {
    const proposed = suggest(list, trip);
    if (proposed.every((s, i) => s.id === list[i].id)) {
      hint(() => ui('These stops are already in the suggested order.', 'התחנות כבר מסודרות לפי הסדר המוצע.'));
      return;
    }
    if (await ask(t('לשמור את הסדר המוצע?\n') + proposed.map(s => s.name).join(language === 'he' ? ' ← ' : ' → '), ui('Save order', 'שמירת הסדר'))) await change(() => {
      if (!trip) return;
      proposed.forEach((s, i) => s.rank = i);
      delete trip.dayNotes[day];
    });
  } catch (e) {
    fail(t(errorMessage(e)));
  }
};
function field<K extends 'input' | 'select' | 'textarea'>(form: HTMLFormElement, name: string, tag: K): HTMLElementTagNameMap[K] {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLElement) || control.localName !== tag) throw Error('Missing ' + name);
  return control as HTMLElementTagNameMap[K];
}
const editForm = $('editForm'),
  tripForm = $('tripForm');
const ef = {
  name: field(editForm, 'name', 'input'),
  date: field(editForm, 'date', 'input'),
  address: field(editForm, 'address', 'input'),
  time: field(editForm, 'time', 'input'),
  coords: field(editForm, 'coords', 'input'),
  source: field(editForm, 'source', 'select'),
  slot: field(editForm, 'slot', 'select'),
  kind: field(editForm, 'kind', 'select'),
  linkStop: field(editForm, 'linkStop', 'select'),
  notes: field(editForm, 'notes', 'textarea')
};
const tf = {
  title: field(tripForm, 'title', 'input'),
  start: field(tripForm, 'start', 'input'),
  end: field(tripForm, 'end', 'input'),
  home: field(tripForm, 'home', 'input'),
  coords: field(tripForm, 'coords', 'input'),
  rules: field(tripForm, 'rules', 'textarea')
};
function openSettings(fresh: boolean) {
  const { trip } = session;
  creating = fresh;
  $('deleteTrip').hidden = fresh || !trip;
  const t: Partial<Trip> = fresh ? {} : trip ?? {};
  tf.title.value = t.title || '';
  tf.title.required = fresh || !!t.title;
  tf.title.placeholder = fresh || t.title ? '' : displayTripTitle('');
  tf.start.value = t.start || localToday();
  tf.end.value = t.end || localToday();
  tf.home.value = t.home || '';
  tf.coords.value = t.homeXY?.join(', ') || '';
  tf.rules.value = t.rules || '';
  $('configTitle').textContent = fresh ? ui('New trip', 'טיול חדש') : ui('Trip settings', 'הגדרות טיול');
  $('moreTrip').open = !!(t.homeXY || t.rules);
  $('homeResults').replaceChildren();
  showPin($('homeState'), tf.coords.value);
  $('config').showModal();
}
// Says in words whether a place has a map pin, since the coordinates sit under the extra fields.
function showPin(target: HTMLElement, coordinates: string) {
  target.textContent = coordinates.trim() ? ui('Pin set', 'הסיכה נקבעה') : ui('No map pin yet', 'עדיין אין סיכה במפה');
}
tf.coords.oninput = () => showPin($('homeState'), tf.coords.value);
tf.start.onchange = () => {
  if (tf.end.value && tf.end.value < tf.start.value) tf.end.value = tf.start.value;
};
$('newTrip').onclick = () => openSettings(true);
$('settings').onclick = () => openSettings(false);
$('deleteTrip').onclick = async () => {
  const { trip } = session;
  if (!trip || creating || !await ask(t('למחוק לצמיתות את הטיול ואת כל התחנות שבו?'), t('מחיקת הטיול'))) return;
  const tripId = trip.id;
  if (await change(() => {
    session.trips = session.trips.filter(item => item.id !== tripId);
    session.select(null);
  })) $('config').close();
};
$('tripForm').onsubmit = async e => {
  e.preventDefault();
  clearError($('config'));
  if (tf.end.value < tf.start.value) {
    fail(ui('The end date cannot be before the start date.', 'תאריך הסיום אינו יכול להיות לפני תאריך ההתחלה.'));
    return;
  }
  try {
    const fields = {
      title: tf.title.value,
      start: tf.start.value,
      end: tf.end.value,
      home: tf.home.value,
      homeXY: points(tf.coords.value),
      rules: tf.rules.value
    };
    const ok = await change(() => {
      if (creating) {
        const trip = cleanTrip({
          ...fields,
          stops: []
        });
        session.trips.push(trip);
        session.select(trip);
      } else {
        const { trip } = session;
        if (!trip) return;
        if (fields.home !== trip.home || JSON.stringify(fields.homeXY) !== JSON.stringify(trip.homeXY)) {
          for (const s of trip.stops.filter(s => s.kind === 'origin')) {
            const matchesHome = s.xy && trip.homeXY
              ? s.xy[0] === trip.homeXY[0] && s.xy[1] === trip.homeXY[1]
              : trip.home && (s.name === trip.home || s.address === trip.home);
            if (!matchesHome) continue;
            s.name = fields.home || t('נקודת מוצא');
            s.xy = fields.homeXY;
            s.address = '';
            trip.edges = trip.edges.filter(edge => edge.a !== s.id && edge.b !== s.id);
          }
        }
        Object.assign(trip, fields);
      }
    });
    if (ok) $('config').close();
  } catch (ex) {
    fail(t(errorMessage(ex)));
  }
};
function hostedSizeWithPhotos(photos: string[]) {
  const { trip } = session;
  const saved = trip?.stops.find(stop => stop.id === draftId)?.photos ?? [];
  return JSON.stringify({ trips: session.trips }).length + JSON.stringify(photos).length - JSON.stringify(saved).length;
}
function updatePhotos() {
  const panel = $('photoPanel');
  panel.hidden = !draftPhotos.length;
  panel.replaceChildren(...draftPhotos.map((src, i) => {
    const figure = dom('figure'),
      image = dom('img');
    image.src = src;
    image.alt = t('תמונה מצורפת ') + (i + 1);
    figure.append(image, button(t('הסרת תמונה ') + (i + 1), () => {
      draftPhotos.splice(i, 1);
      if (!draftPhotos.length && ef.source.value === 'photo') ef.source.value = '';
      updatePhotos();
    }));
    return figure;
  }));
  const attached = draftPhotos.length ? quantity(draftPhotos.length, ' תמונות מצורפות', 'photo attached', 'photos attached') : '';
  const percent = session.mode === 'account' ? Math.min(100, Math.round(hostedSizeWithPhotos(draftPhotos) * 100 / journalCharacterLimit)) : 0;
  const usage = session.mode === 'account' ? ui(percent + '% of journal storage used', percent + '% משטח היומן בשימוש') : '';
  $('photoStatus').textContent = [attached, usage].filter(Boolean).join(' · ');
}
function relatedStops() {
  const { trip } = session;
  const select = ef.linkStop;
  select.replaceChildren(new Option(t('תחנה עצמאית'), ''));
  if (!trip) return;
  for (const s of trip.stops.filter(s => s.date === ef.date.value && s.id !== draftId && s.kind === 'visit').sort((a, b) => a.rank - b.rank)) {
    select.add(new Option(s.name + (s.time ? ' · ' + s.time : ''), s.id));
  }
}
async function addPhoto(file: File | undefined) {
  if (!file) return;
  if (draftPhotos.length >= 3) {
    $('photoStatus').textContent = t('ניתן לצרף עד שלוש תמונות לתחנה');
    return;
  }
  const generation = fileEpoch;
  photoBusy = true;
  $('photoStatus').textContent = t('מכין את התמונה…');
  try {
    const content = await preparePhoto(file);
    if (generation !== fileEpoch) return;
    if (session.mode === 'account' && hostedSizeWithPhotos([...draftPhotos, content]) > journalCharacterLimit - 32000) {
      throw Error(t('אין די מקום לתמונה זו. אפשר לגבות את הטיול ולהסיר תמונות ישנות.'));
    }
    draftPhotos.push(content);
    if (!ef.source.value) ef.source.value = 'photo';
    updatePhotos();
  } catch (e) {
    if (generation === fileEpoch) $('photoStatus').textContent = t(errorMessage(e));
  } finally {
    if (generation === fileEpoch) photoBusy = false;
    $('photo').value = '';
  }
}
$('photo').onchange = () => addPhoto($('photo').files?.[0]);
ef.date.onchange = relatedStops;
const primarySource = (sources: Source[]) => sources.find(source => source !== 'photo') ?? sources[0];
function openStop(s: Partial<Stop> = {}) {
  const { trip, day } = session;
  if (!trip) return;
  fileEpoch++;
  photoBusy = false;
  draftPhotos = [...(s.photos || [])];
  draftId = s.id || '';
  updatePhotos();
  ef.name.value = s.name || '';
  ef.date.value = s.date || day;
  ef.date.min = trip.start;
  ef.date.max = trip.end;
  ef.address.value = s.address || '';
  ef.time.value = s.time || '';
  ef.source.value = primarySource(s.sources ?? []) ?? (s.id ? '' : 'manual');
  ef.slot.value = s.slot || '';
  ef.kind.value = s.kind || 'visit';
  ef.coords.value = s.xy?.join(', ') || '';
  ef.notes.value = s.notes || '';
  $('georesults').replaceChildren();
  $('removeStop').hidden = !draftId;
  // A new stop needs only a name. A saved stop shows everything recorded about it.
  $('moreStop').open = !!draftId;
  showPin($('pinState'), ef.coords.value);
  relatedStops();
  $('edit').showModal();
}
ef.coords.oninput = () => showPin($('pinState'), ef.coords.value);
$('add').onclick = () => openStop();
$('editForm').onsubmit = async e => {
  e.preventDefault();
  clearError($('edit'));
  if (photoBusy) {
    fail(t('התמונה עדיין בעיבוד'));
    return;
  }
  try {
    const xy = points(ef.coords.value);
    const ok = await change(() => {
      const { trip } = session;
      if (!trip) return;
      const old = trip.stops.find(x => x.id === draftId);
      const previous = old?.sources ?? [];
      const primary = primarySource(previous);
      let evidence: string[] = previous;
      if (ef.source.value !== (primary ?? '')) evidence = [ef.source.value, ...previous.filter(source => source !== primary)];
      if (draftPhotos.length) evidence = [...evidence, 'photo'];
      else if (old?.photos.length && ef.source.value !== 'photo') evidence = evidence.filter(source => source !== 'photo');
      const s = cleanStop({
        ...old,
        photos: draftPhotos,
        id: draftId || undefined,
        name: ef.name.value,
        date: ef.date.value,
        address: ef.address.value,
        time: ef.time.value,
        xy,
        slot: ef.slot.value,
        kind: ef.kind.value,
        notes: ef.notes.value,
        sources: evidence,
        rank: old?.date === ef.date.value ? old.rank : 1 + Math.max(0, ...trip.stops.filter(s => s.date === ef.date.value).map(s => s.rank))
      });
      if (ef.linkStop.value) {
        const target = trip.stops.find(x => x.id === ef.linkStop.value && x.date === s.date);
        if (!target) throw Error(t('התחנה שנבחרה אינה זמינה'));
        combineEvidence(target, s);
        if (s.name !== target.name) {
          const note = t('אירוע מקושר: ') + s.name;
          if (!target.notes.includes(note)) target.notes = [target.notes, note].filter(Boolean).join(' · ');
        }
        if (old) {
          trip.stops = trip.stops.filter(x => x.id !== old.id);
          trip.edges = trip.edges.filter(e => e.a !== old.id && e.b !== old.id);
          delete trip.dayNotes[old.date];
        }
      } else if (old) {
        if (JSON.stringify(old.xy) !== JSON.stringify(s.xy) || old.date !== s.date) {
          trip.edges = trip.edges.filter(edge => edge.a !== s.id && edge.b !== s.id);
          delete trip.dayNotes[old.date];
        }
        Object.assign(old, s);
      } else {
        mergeStops(trip, [s]);
      }
      session.select(trip, s.date);
    });
    if (ok) $('edit').close();
  } catch (ex) {
    $('moreStop').open = true; // The coordinates that failed to parse sit under the extra fields.
    fail(t(errorMessage(ex)));
  }
};
$('removeStop').onclick = async () => {
  if (!await ask(t('למחוק את התחנה מהטיול?'), t('מחיקת התחנה'))) return;
  const ok = await change(() => {
    const { trip, day } = session;
    if (!trip) return;
    trip.stops = trip.stops.filter(s => s.id !== draftId);
    trip.edges = trip.edges.filter(e => e.a !== draftId && e.b !== draftId);
    delete trip.dayNotes[day];
  });
  if (ok) $('edit').close();
};
function endPick() {
  pick = false;
  map.getContainer().classList.remove('pickmode');
  endHint();
  $('edit').showModal();
}
$('pick').onclick = () => {
  pick = true;
  map.getContainer().classList.add('pickmode');
  $('edit').close();
  hint(() => t('לחץ על המקום במפה. אפשר להתקרב לפני הבחירה.') + ui(' Press Escape to cancel.', ' Escape מבטל את הבחירה.'), 'warning');
  viewList(false);
};
map.on('click', e => {
  if (!pick) return;
  ef.coords.value = [e.latlng.lat, e.latlng.lng].map(n => n.toFixed(6)).join(', ');
  showPin($('pinState'), ef.coords.value);
  endPick();
});
document.addEventListener('keydown', event => {
  if (pick && event.key === 'Escape') endPick();
});
// Looks an address up only when the traveler asks, and lets them choose among the matches.
async function findOnMap(query: string, target: HTMLElement, trigger: HTMLButtonElement, choose: (coordinates: string) => void) {
  const q = query.trim();
  if (!q) {
    target.textContent = ui('Enter an address or a place name first.', 'יש להזין תחילה כתובת או שם מקום.');
    return;
  }
  target.textContent = t('מחפש ב־OpenStreetMap…');
  trigger.disabled = true;
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&accept-language=' + locale() + '&q=' + encodeURIComponent(q));
    if (!res.ok) throw Error();
    const payload: unknown = await res.json();
    if (!Array.isArray(payload)) throw Error();
    const results = payload.filter((a): a is {
      display_name: string;
      lat: string;
      lon: string;
    } => isRecord(a) && typeof a.display_name === 'string' && typeof a.lat === 'string' && typeof a.lon === 'string');
    target.replaceChildren(...results.map(a => button(a.display_name, () => {
      choose(a.lat + ', ' + a.lon);
      target.textContent = t('המיקום נבחר.');
    })));
    if (!results.length) target.textContent = t('לא נמצאה כתובת. אפשר לבחור נקודה במפה.');
  } catch {
    target.textContent = t('חיפוש כתובת אינו זמין כרגע. אפשר לבחור נקודה במפה.');
  } finally {
    setTimeout(() => trigger.disabled = false, 1100);
  }
}
$('findPlace').onclick = () => findOnMap(ef.address.value.trim() || ef.name.value, $('georesults'), $('findPlace'), coordinates => {
  ef.coords.value = coordinates;
  showPin($('pinState'), coordinates);
});
$('findHome').onclick = () => findOnMap(tf.home.value, $('homeResults'), $('findHome'), coordinates => {
  tf.coords.value = coordinates;
  showPin($('homeState'), coordinates);
});
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]')) b.onclick = () => b.closest('dialog')?.close();
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => clearError(dialog));
  dialog.addEventListener('input', () => clearError(dialog));
}
enableSharing(() => session.trip, portable, () => session.day, () => session.mode === 'account');
$('export').onclick = () => {
  const { trip } = session;
  if (!trip) return;
  const blob = new Blob([JSON.stringify({
    format: 'hayiti/1',
    trip
  })], {
    type: 'application/json'
  });
  const u = URL.createObjectURL(blob),
    a = dom('a');
  a.href = u;
  a.download = 'Hayiti-' + trip.start + '.json';
  a.click();
  unbacked.delete(trip.id);
  setTimeout(() => URL.revokeObjectURL(u), 1000);
};
$('connections').onclick = () => {
  $('sources').showModal();
  tab('connected');
};
$('import').onclick = () => {
  $('sources').showModal();
  tab(session.trip ? 'connected' : 'files');
};
function tab(name: string | undefined) {
  for (const n of ['files', 'connected', 'paste'] as const) $(n).hidden = n !== name;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.classList.toggle('selected', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.onclick = () => tab(b.dataset.tab);
$('copyPrompt').onclick = async () => {
  const { trip } = session;
  const selectedNames = new Set([...$('connected').querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value));
  const requested = reportSources.filter(source => selectedNames.has(sourceNames[source]));
  const checks = requested.map(source => sourceNames[source]).join(', ');
  if (!trip || !checks) {
    $('promptResult').textContent = t('בחר טיול ומקור אחד לפחות.');
    return;
  }
  let prompt = t('שחזר את המסלול שלי מ־') + trip.start + t(' עד ') + trip.end + t(' לפי ') + checks + t('. הצלֵב מקומות ותאריכי אירועים, שמור בנפרד רכישות מרחוק וסמן אי־ודאות. השתמש בכללי הטיול שלי. באמצעות אפליקציית ״הייתי״ קרא תחילה list_trips ו-get_day והצג לי תחנות מוצעות לאישור. רק אחרי שאאשר, שמור את התחנות שבחרתי באמצעות add_trip_stops בטיול ') + trip.id + t('. העבר רק את פרטי המסלול הנחוצים, ללא מספרי חשבון, קודי כרטיס או גוף המייל. אם החיבור לאפליקציית ״הייתי״ אינו זמין, החזר קובץ JSON לייבוא במבנה {"format":"hayiti-stops/1","stops":[{"name":"שם","date":"YYYY-MM-DD","sources":["email"],"refs":["מזהה מקור יציב"]}]}.');
  if (portable || session.mode !== 'account') prompt = t('לפי ') + checks + t(' חשב את תחנות הטיול שלי מ־') + trip.start + t(' עד ') + trip.end + t('. החזר קובץ JSON במבנה {"format":"hayiti-stops/1","stops":[{"name":"שם","date":"YYYY-MM-DD","address":"","sources":["email"],"refs":["מזהה יציב"]}]}. לכל תחנה צרף רק מקור משלה (card/email/calendar/ticket/whatsapp) ומיקום מאומת במערך xy בסדר קו רוחב, קו אורך. הימנע מקודי כרטיס ומספרי חשבונות.');
  prompt += ui(' Report the actual outcome for each requested source over these dates. For Finances, check for linked credit or debit purchase accounts before searching transactions. Distinguish missing access, no accounts, syncing, incomplete searches, errors, zero transactions, and purchases without a place. Never infer disconnection from missing results.', ' יש לדווח מה נבדק בכל מקור ובאילו תאריכים. ב־Finances יש לבדוק תחילה אם קיים חשבון מקושר לרכישות באשראי או בדביט. יש להבחין בין מקור מנותק, חוסר בחשבונות, סנכרון, חיפוש חלקי, שגיאה, אפס עסקאות ורכישות ללא מקום מזוהה.');
  const outcomes = requested.map(source => source + ' (' + statesBySource[source].join(', ') + ')').join(', ');
  prompt += ui(' Include start, end, and sourceChecks in add_trip_stops or the import JSON, even when stops is empty. Report only sources you checked. Use these values for each source. ',
    ' יש לכלול start, end ו־sourceChecks בקריאה ל־add_trip_stops או בקובץ הייבוא, גם כאשר stops ריק. יש לדווח רק על מקורות שנבדקו. אלה הערכים המותרים לכל מקור. ') + outcomes + '.';
  try {
    await navigator.clipboard.writeText(prompt);
    $('promptResult').textContent = t('הבקשה הועתקה. אפשר להדביק אותה בשיחה עם החיבורים שלך.');
  } catch {
    $('promptResult').textContent = prompt;
  }
};
$('discardDraft').onclick = async () => {
  if (!await ask(t('למחוק את טיוטת הטיול שלא ניתן לקרוא מהלשונית הזאת לצמיתות?'), t('מחיקת טיוטה שלא ניתן לקרוא'))) return;
  try {
    discardGuest();
    $('discardDraft').hidden = true;
    await load();
  } catch (error) {
    msg(errorMessage(error));
  }
};
$('reload').onclick = () => load().catch(e => msg(errorMessage(e)));
$('parseText').onclick = () => {
  const { trip, day } = session;
  if (!trip) return fail(t('בחר טיול תחילה'));
  if (!$('pasted').value.trim()) return;
  $('sources').close();
  openStop(pastedStop($('pasted').value, day, $('pasteSource').value));
};
$('file').onchange = () => {
  const file = $('file').files?.[0];
  if (file) void previewFile(file);
};
async function previewFile(f: File, order?: 'day-first' | 'month-first') {
  const target = $('preview');
  target.replaceChildren();
  try {
    if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|gif|avif)$/i.test(f.name)) {
      if (!session.trip) throw Error(t('יש לבחור טיול לפני צירוף תמונה'));
      $('sources').close();
      openStop({
        sources: ['ticket']
      });
      await addPhoto(f);
      return;
    }
    if (f.size > 7500000 && !(portable && /\.json$/i.test(f.name))) throw Error(t('הקובץ גדול מדי'));
    const raw = await f.text();
    let result: ImportResult = {
        stops: [],
        omitted: 0
      },
      backup: Trip | undefined;
    if (/\.json$/i.test(f.name)) {
      const o = JSON.parse(raw);
      if (['hayiti/1', 'masluli/1'].includes(o.format)) backup = cleanTrip(o.trip);else if (['hayiti-stops/1', 'masluli-stops/1'].includes(o.format) && Array.isArray(o.stops)) result = {
        stops: o.stops.map(cleanStop),
        omitted: 0,
        checks: o.start === session.trip?.start && o.end === session.trip?.end ? o.sourceChecks : null
      };else throw Error(t('פורמט גיבוי לא מוכר'));
    } else if (/\.csv$/i.test(f.name)) {
      result = await importCsv(raw, order);
      if (result.needsDateOrder) {
        target.append(dom('p', ui('Which date order does this file use?', 'מהו סדר התאריכים בקובץ?')),
          button(ui('Month / day / year', 'חודש / יום / שנה'), () => previewFile(f, 'month-first')),
          button(ui('Day / month / year', 'יום / חודש / שנה'), () => previewFile(f, 'day-first')));
        return;
      }
    } else if (/\.ics$/i.test(f.name)) result = await importIcs(raw, t);else {
      if (!session.trip) throw Error(t('יש לבחור טיול תחילה'));
      $('sources').close();
      openStop(pastedStop(raw, session.day, /\.eml$/i.test(f.name) ? 'email' : 'manual'));
      return;
    }
    if (backup && session.mode === 'guest') checkGuestBackup(session.trips, backup);
    if (!backup && !session.trip) throw Error(t('יש ליצור טיול לפני ייבוא תחנות'));
    const active = session.trip;
    const valid = backup || !active ? [] : result.stops.filter(s => s.date >= active.start && s.date <= active.end);
    target.append(dom('p', backup ? displayTripTitle(backup.title) + ' · ' + quantity(backup.stops.length, ' רשומות', 'record', 'records') : (language === 'en' && valid.length === 1 ? '1 record within the trip dates · ' : valid.length + t(' רשומות בטווח הטיול · ')) + (result.omitted + result.stops.length - valid.length) + t(' דולגו')));
    const checks = Object.entries(isRecord(result.checks) ? result.checks : {}).filter(([key, status]) => validOutcome(key, status));
    if (!backup && !valid.length && !checks.length) return;
    target.append(button(backup ? t('טעינת הטיול') : t('מיזוג התחנות'), async () => {
      let test: MergeResult | undefined;
      const ok = await change(() => {
        if (backup) {
          const existing = session.trips.find(t => t.id === backup.id);
          if (existing) {
            test = mergeStops(existing, backup.stops);
          } else {
            session.trips.push(backup);
          }
          session.select(existing ?? backup);
        } else {
          const { trip } = session;
          if (!trip || !active || trip.id !== active.id || trip.start !== active.start || trip.end !== active.end) {
            throw Error(t('הטיול השתנה. יש לבחור את קובץ הייבוא מחדש.'));
          }
          test = mergeStops(trip, valid);
          trip.checks ||= {};
          for (const [key, status] of checks) if (member(reportSources, key) && validOutcome(key, status)) trip.checks[key] = {
            status,
            start: trip.start,
            end: trip.end,
            at: new Date().toISOString()
          };
        }
      }, !!backup);
      if (ok) {
        $('sources').close();
        const done = test;
        if (done && session.trip?.id === (backup?.id ?? active?.id)) msg(() => language === 'he' ? 'נוספו ' + done.added + ' תחנות · הוצלבו ' + done.linked + ' · כבר קיימות ' + done.skipped : 'Added: ' + done.added + ' · Matched: ' + done.linked + ' · Already present: ' + done.skipped);
      }
    }));
  } catch (e) {
    target.textContent = t(errorMessage(e));
  } finally {
    $('file').value = '';
  }
}
function viewList(value: boolean) {
  document.body.classList.toggle('showList', value);
  $('listTab').setAttribute('aria-pressed', String(value));
  $('mapTab').setAttribute('aria-pressed', String(!value));
  if (!value) fitDailyRoute();
}
$('mapTab').onclick = () => viewList(false);
$('listTab').onclick = () => viewList(true);
$('edit').addEventListener('cancel', () => {
  fileEpoch++;
  photoBusy = false;
});
function localizeControls() {
  for (const [direction, hebrew, english] of [['in', 'התקרבות', 'Zoom in'], ['out', 'התרחקות', 'Zoom out']]) {
    const zoom = map.getContainer().querySelector<HTMLElement>('.leaflet-control-zoom-' + direction);
    if (!zoom) continue;
    zoom.title = language === 'he' ? hebrew : english;
    zoom.setAttribute('aria-label', zoom.title);
  }
}
function refreshLanguage() {
  localizeControls();
  render();
  $('status').textContent = currentStatus();
}
$('trySample').onclick = () => void change(() => {
  const sample = cleanTrip(sampleTrip.trip);
  if (!session.trips.some(trip => trip.id === sample.id)) session.trips.push(sample);
  session.select(session.trips.find(trip => trip.id === sample.id));
}, true);
$('welcomeNew').onclick = () => openSettings(true);
function start() {
  $('retryLoad').hidden = true;
  load().catch(e => {
    msg(() => t(errorMessage(e)) + ui(' Choose Try again.', ' אפשר לבחור ב״ניסיון נוסף״.'), 'error');
    $('retryLoad').hidden = false;
  });
}
$('retryLoad').onclick = start;
// Stops that ChatGPT saved while the traveler was away appear when they come back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || portable || sharedRoute || session.mode !== 'account') return;
  if (document.querySelector('dialog[open]:not(#sources)')) return;
  load(false, true).catch(() => { /* The journal on screen stays as it is. Refresh journal reports failures. */ });
});
localizeControls();
showConnections();
start();
