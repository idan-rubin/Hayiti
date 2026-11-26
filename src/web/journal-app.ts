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
let currentStatus = () => '';
function msg(message: string | (() => string)) {
  currentStatus = typeof message === 'function' ? message : () => t(message);
  $('status').textContent = currentStatus();
}
const button = (title: string, fn: () => void) => {
  const b = dom('button', title);
  b.type = 'button';
  b.onclick = fn;
  return b;
};
const map = L.map('map', {
  zoomControl: true,
  scrollWheelZoom: false,
  trackResize: false,
  zoomSnap: .25
}).setView([30, 15], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  referrerPolicy: 'strict-origin',
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const overlay = L.layerGroup().addTo(map);
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
  chip.hidden = !!sharedRoute;
  const rows = $('checkRows');
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
  setDates(trip ? dateRange(trip) : [], day);
  $('dayTitle').hidden = !!trip;
  draw();
}
const setDates = createDateReel($('dayReel'), $('tripDate'), dateLabel, next => {
  if (next === session.day) return;
  session.select(session.trip, next);
  selected = '';
  draw();
});
function distanceLabel(meters: number) {
  return meters < 1000 ? Math.max(1, Math.round(meters / 10) * 10) + t(' מ׳') : dateFormats[language].distance.format(meters / 1000) + t(' ק״מ');
}
function showDailyStats(stats: ReturnType<typeof walkingStats>) {
  const { trip } = session;
  const stopLabel = stats.stopCount === 1 ? t('תחנה אחת') : stats.stopCount + t(' תחנות');
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
  let prev = null;
  for (const [i, s] of list.entries()) {
    const li = dom('li', undefined, 'stop');
    li.classList.toggle('activeStop', selected === s.id);
    li.append(dom('span', s.kind === 'origin' ? '⌂' : String(i + (list[0]?.kind === 'origin' ? 0 : 1)), 'num'));
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
        const b = button(sign, () => move(s, delta));
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
      mark.bindPopup(content);
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
  fitDailyRoute();
  if (!list.length) $('stops').append(dom('li', trip ? t('עדיין אין תחנות ליום הזה.') : t('כאן יופיעו תחנות הטיול לפי יום.'), 'empty'));
  $('dayNote').textContent = trip?.dayNotes?.[day] || '';
  $('dayNote').hidden = !$('dayNote').textContent;
  const other = trip?.stops.filter(s => s.date === day && offRoute(s)) || [];
  $('other').hidden = !other.length;
  $('otherList').replaceChildren(...other.map(s => button(s.name + (s.kind === 'remote' ? t(' · מרחוק') : t(' · לבירור')), () => openStop(s))));
}
function noTimeCopy() {
  return portable ? session.mode === 'portable' ? 'נשמר בדפדפן הזה.' : 'השינויים בזיכרון הלשונית. לשמירה יש להוריד גיבוי.' : session.mode === 'account' ? 'השינויים נשמרו ביומן האישי.' : 'השינויים נשמרו בלשונית הזאת. אפשר לייצא גיבוי או להיכנס ל־ChatGPT.';
}
let viewRequest = 0,
  loadedHosted = false;
async function loadHostedRoute() {
  const epoch = ++viewRequest;
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
    msg(res.status === 404 ? 'הקישור בוטל או אינו זמין.' : 'לא ניתן לטעון את המסלול כרגע.');
    return;
  }
  if (loadedHosted) return;
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
      if (!loadedHosted) msg('לא ניתן לטעון את המסלול כרגע.');
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
async function load(afterConflict = false) {
  if (hostedView) return loadHostedRoute();
  if (embeddedRoute) {
    session.showSnapshot(cleanTrip(JSON.parse(embeddedRoute.textContent ?? 'null')));
    document.body.classList.add('route-copy');
    renderSelection();
    msg('עותק של המסלול לצפייה');
    return;
  }

  const result = await session.load(portable, title => {
    const suffix = ui(' (before sign-in)', ' (לפני הכניסה)');
    return displayTripTitle(title).slice(0, 100 - suffix.length) + suffix;
  }, afterConflict);
  if (result.kind === 'unchanged') return;
  const unreadable = result.kind === 'unreadable-draft';
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
      msg(session.mode === 'portable' ? 'עותק אישי בדפדפן הזה' : 'אפשר ליצור טיול. לשמירה בדפדפן זה יש להוריד גיבוי.');
      break;
    case 'signed-out':
      msg(() => ui('You are signed out. Sign in with ChatGPT to open your journal.', 'יצאת מהחשבון. כדי לפתוח את היומן נכנסים שוב עם ChatGPT.'));
      break;
    case 'guest':
      msg(session.trips.length ? noTimeCopy() : 'אפשר להתנסות כאן. לשמירה בין מכשירים נכנסים עם ChatGPT.');
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

async function change(edit: () => void) {
  try {
    const result = await session.change(edit);
    if (result === 'ignored') return false;
    if (result === 'loading') {
      alert(ui('Please try this edit again when the journal is ready.', 'נסו לשמור את השינוי שוב כשהיומן יהיה מוכן.'));
      return false;
    }
    if (result === 'superseded') {
      alert(t('העריכה לא נשמרה. היומן השתנה. בדקו את הטיול הנוכחי לפני שתנסו שוב.'));
      return false;
    }
    if (result === 'saved-after-refresh') return true;
    renderSelection();
    if (result === 'conflict') {
      const loaded = await load(true);
      alert(t(loaded === 'account' ? 'הטיול השתנה במכשיר אחר. הגרסה העדכנית נטענה. אפשר לחזור על העריכה.'
        : 'העריכה לא נשמרה. היומן השתנה. בדקו את הטיול הנוכחי לפני שתנסו שוב.'));
      return false;
    }
    if (result === 'storage-error') {
      alert(ui('This browser could not save the edit. Back up your trip, then free storage or remove a photo and try again.',
        'הדפדפן לא הצליח לשמור את העריכה. גבו את הטיול, פנו מקום או הסירו תמונה ונסו שוב.'));
      return false;
    }
    msg(noTimeCopy());
    return true;
  } catch (error) {
    renderSelection();
    alert(t(errorMessage(error)));
    return false;
  }
}

$('trips').onchange = () => {
  session.select(session.trips.find(trip => trip.id === $('trips').value));
  renderSelection();
};
function move(s: Stop, delta: number) {
  const { trip, day } = session;
  if (!trip) return;
  return change(() => {
    const list = routeStops(trip, day, t('נקודת מוצא')).filter(x => x.id !== 'base'),
      i = list.findIndex(x => x.id === s.id);
    if (!list[i + delta] || list[i + delta].kind === 'origin') return;
    [list[i], list[i + delta]] = [list[i + delta], list[i]];
    list.forEach((x, j) => x.rank = j);
    delete trip.dayNotes[day];
  });
}
$('organize').onclick = async () => {
  const { trip, day } = session;
  if (!trip) return;
  const list = routeStops(trip, day, t('נקודת מוצא')).filter(x => x.id !== 'base');
  if (list.some(s => ['pickup', 'dropoff'].includes(s.kind))) {
    msg('ביום הזה יש נסיעת מונית מתועדת. אפשר להזיז תחנות בנפרד ולשמור על זמני האיסוף וההגעה.');
    return;
  }
  try {
    const proposed = suggest(list, trip);
    if (confirm(t('לשמור את הסדר המוצע?\n') + proposed.map(s => s.name).join(language === 'he' ? ' ← ' : ' → '))) await change(() => {
      if (!trip) return;
      proposed.forEach((s, i) => s.rank = i);
      delete trip.dayNotes[day];
    });
  } catch (e) {
    alert(t(errorMessage(e)));
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
  $('config').showModal();
}
$('newTrip').onclick = () => openSettings(true);
$('settings').onclick = () => openSettings(false);
$('deleteTrip').onclick = async () => {
  const { trip } = session;
  if (!trip || creating || !confirm(t('למחוק לצמיתות את הטיול ואת כל התחנות שבו?'))) return;
  const tripId = trip.id;
  if (await change(() => {
    session.trips = session.trips.filter(item => item.id !== tripId);
    session.select(null);
  })) $('config').close();
};
$('tripForm').onsubmit = async e => {
  e.preventDefault();
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
    alert(t(errorMessage(ex)));
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
    alert(t('ניתן לצרף עד שלוש תמונות לתחנה'));
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
  relatedStops();
  $('edit').showModal();
}
$('add').onclick = () => openStop();
$('editForm').onsubmit = async e => {
  e.preventDefault();
  if (photoBusy) {
    alert(t('התמונה עדיין בעיבוד'));
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
    alert(t(errorMessage(ex)));
  }
};
$('removeStop').onclick = async () => {
  if (!confirm(t('למחוק את התחנה מהטיול?'))) return;
  const ok = await change(() => {
    const { trip, day } = session;
    if (!trip) return;
    trip.stops = trip.stops.filter(s => s.id !== draftId);
    trip.edges = trip.edges.filter(e => e.a !== draftId && e.b !== draftId);
    delete trip.dayNotes[day];
  });
  if (ok) $('edit').close();
};
$('pick').onclick = () => {
  pick = true;
  $('edit').close();
  msg('לחץ על המקום במפה. אפשר להתקרב לפני הבחירה.');
  viewList(false);
};
map.on('click', e => {
  if (!pick) return;
  pick = false;
  ef.coords.value = [e.latlng.lat, e.latlng.lng].map(n => n.toFixed(6)).join(', ');
  $('edit').showModal();
});
$('findPlace').onclick = async () => {
  const q = ef.address.value.trim() || ef.name.value.trim();
  if (!q) return;
  const target = $('georesults');
  target.textContent = t('מחפש ב־OpenStreetMap…');
  $('findPlace').disabled = true;
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
      ef.coords.value = a.lat + ', ' + a.lon;
      target.textContent = t('המיקום נבחר.');
    })));
    if (!results.length) target.textContent = t('לא נמצאה כתובת. אפשר לבחור נקודה במפה.');
  } catch {
    target.textContent = t('חיפוש כתובת אינו זמין כרגע. אפשר לבחור נקודה במפה.');
  } finally {
    setTimeout(() => $('findPlace').disabled = false, 1100);
  }
};
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]')) b.onclick = () => b.closest('dialog')?.close();
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
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.classList.toggle('selected', b.dataset.tab === name);
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
  if (portable) prompt = t('לפי ') + checks + t(' חשב את תחנות הטיול שלי מ־') + trip.start + t(' עד ') + trip.end + t('. החזר קובץ JSON במבנה {"format":"hayiti-stops/1","stops":[{"name":"שם","date":"YYYY-MM-DD","address":"","sources":["email"],"refs":["מזהה יציב"]}]}. לכל תחנה צרף רק מקור משלה (card/email/calendar/ticket/whatsapp) ומיקום מאומת במערך xy בסדר קו רוחב, קו אורך. הימנע מקודי כרטיס ומספרי חשבונות.');
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
  if (!confirm(t('למחוק את טיוטת הטיול שלא ניתן לקרוא מהלשונית הזאת לצמיתות?'))) return;
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
  if (!trip) return alert(t('בחר טיול תחילה'));
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
      });
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
  if (portable) {
    $('connected').querySelector('h3')!.textContent = t('ייבוא נתונים מ־ChatGPT');
    $('connected').querySelector('p')!.textContent = t('העתק את בקשת הסנכרון לשיחה שלך. אפשר לייבא כאן את קובץ התחנות שמתקבל.');
  }
}
function refreshLanguage() {
  localizeControls();
  render();
  $('status').textContent = currentStatus();
}
localizeControls();
showConnections();
load().catch(e => {
  msg(() => t(errorMessage(e)) + t(' אפשר לרענן את הדף כדי לנסות שוב.'));
});
