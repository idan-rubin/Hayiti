// Compatibility harness for the guest reader, stale-save guard and storage handler in main 304a74e.
// The parser and storage-handler branches are copied unchanged; the DOM adapter keeps this fixture small.
import { cleanTrip, isRecord, type Trip } from '../../src/domain/core.ts';

const guestKey = 'hayiti-unsigned-journal';
class UnreadableDraft extends Error {
  constructor() { super('לא ניתן לקרוא את טיוטת הטיול בדפדפן הזה.'); }
}
function parseDraft(raw: string): Trip[] | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (isRecord(data) && Array.isArray(data.trips)) return data.trips.map(cleanTrip);
  } catch { /* The caller decides what an unreadable draft means. */ }
  return null;
}
function readGuest(): Trip[] {
  let raw: string | null;
  try { raw = localStorage.getItem(guestKey); }
  catch { return []; }
  if (raw === null) return [];
  const trips = parseDraft(raw);
  if (!trips) throw new UnreadableDraft();
  return trips;
}
function guestSnapshot(): string | null {
  try { return localStorage.getItem(guestKey); }
  catch { return null; }
}
const session = {
  mode: 'guest', saving: false, trips: readGuest(), draftSeen: guestSnapshot(),
  adoptGuestDraft() {
    if (this.mode !== 'guest' || this.saving) return false;
    this.takeDraft();
    return true;
  },
  takeDraft() {
    const trips = readGuest();
    this.draftSeen = guestSnapshot();
    this.trips = trips;
  }
};
const portable = false, sharedRoute = false;
const t = (text: string) => text === 'לא ניתן לקרוא את טיוטת הטיול בדפדפן הזה.'
  ? 'The guest draft in this browser could not be read.' : text;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function msg(message: () => string, tone: string) {
  const status = document.getElementById('legacy-status')!;
  status.textContent = message();
  status.dataset.tone = tone;
}
function renderSelection() {
  document.getElementById('legacy-trips')!.textContent = session.trips.map(trip => trip.title).join(' · ');
}
let starts = 0;
function start() { starts++; session.takeDraft(); renderSelection(); }

// Verbatim handler from src/web/journal-app.ts at 304a74e.
window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || event.key !== guestKey || portable || sharedRoute) return;
  try {
    if (session.adoptGuestDraft()) renderSelection();
  } catch (error) {
    msg(() => t(errorMessage(error)), 'error');
  }
  // An emptied draft may mean its trips joined an account after sign-in, so this tab checks whether it is signed in.
  if (event.newValue === null) start();
});

document.getElementById('legacy-edit')!.onclick = () => {
  try {
    // Verbatim pre-edit guard from JournalSession.apply at 304a74e.
    if (session.mode === 'guest' && guestSnapshot() !== session.draftSeen) {
      session.takeDraft();
      return;
    }
    session.trips[0].title = 'Unsafe stale edit';
    localStorage.setItem(guestKey, JSON.stringify({ trips: session.trips }));
    renderSelection();
  } catch (error) { msg(() => t(errorMessage(error)), 'error'); }
};
Object.assign(window, { legacyUpgradeReview: { starts: () => starts } });
renderSelection();
