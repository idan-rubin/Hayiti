import { cleanTrip, isRecord, type Trip } from '../domain/core.ts';

export const guestKey = 'hayiti-unsigned-journal';
const attemptsKey = 'hayiti-guest-merge';
export class UnreadableDraft extends Error {
  constructor() { super('לא ניתן לקרוא את טיוטת הטיול בדפדפן הזה.'); }
}

function parseDraft(raw: string): Trip[] | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (isRecord(data) && Array.isArray(data.trips)) return data.trips.map(cleanTrip);
  } catch { /* The caller decides what an unreadable draft means. */ }
  return null;
}

// Drafts used to live in their tab. Every tab that still holds one adds its trips to the browser's draft.
function adoptTabDraft() {
  const fromTab = sessionStorage.getItem(guestKey);
  if (fromTab === null) return;
  const stored = localStorage.getItem(guestKey);
  if (stored === null) {
    localStorage.setItem(guestKey, fromTab);
    const attempts = sessionStorage.getItem(attemptsKey);
    if (attempts !== null && localStorage.getItem(attemptsKey) === null) localStorage.setItem(attemptsKey, attempts);
  } else {
    const kept = parseDraft(stored),
      mine = parseDraft(fromTab);
    // An unreadable draft stays where it is until the traveler discards it.
    if (!kept || !mine) return;
    for (const trip of mine) {
      const same = kept.find(other => other.id === trip.id);
      if (!same) kept.push(trip);
      else if (JSON.stringify(same) !== JSON.stringify(trip)) kept.push({ ...trip, id: crypto.randomUUID() });
    }
    localStorage.setItem(guestKey, JSON.stringify({ trips: kept }));
  }
  sessionStorage.removeItem(guestKey);
  sessionStorage.removeItem(attemptsKey);
}

/** Legacy tab drafts that cannot yet fit beside the browser's stored trips. */
export function tripsWaitingInTab(): number {
  try {
    const fromTab = sessionStorage.getItem(guestKey);
    return fromTab === null ? 0 : parseDraft(fromTab)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Migrate legacy tab drafts under the cross-tab save lock. */
export async function moveTabDraft() {
  let waiting: boolean;
  try {
    waiting = sessionStorage.getItem(guestKey) !== null;
  } catch {
    return; // A browser that blocks tab storage never held a draft there.
  }
  if (!waiting) return;
  await withGuestLock(() => {
    try {
      adoptTabDraft();
    } catch {
      // The browser has no room for both drafts. Each stays where it is, and the next load tries again.
    }
  });
}

export function readGuest(): Trip[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(guestKey);
  } catch { return []; }
  if (raw === null) return [];
  // Keep the original until the traveler explicitly discards it.
  const trips = parseDraft(raw);
  if (!trips) throw new UnreadableDraft();
  return trips;
}

/** The stored draft exactly as saved, to tell whether another tab has saved since this tab last looked. */
export function guestSnapshot(): string | null {
  try {
    return localStorage.getItem(guestKey);
  } catch {
    return null;
  }
}

/** Keep the draft version check and write atomic across browser tabs. */
export function withGuestLock<T>(save: () => T | Promise<T>): Promise<T> {
  const locks: LockManager | undefined = navigator.locks;
  if (!locks) return Promise.resolve().then(save);
  return locks.request('hayiti-guest-draft', async () => {
    // A turn of the event loop lets this tab receive what the previous holder of the lock just saved.
    await new Promise(resolve => setTimeout(resolve));
    return save();
  });
}

/** After sign-in, removes only the trips that were uploaded. One that another tab added or changed meanwhile stays. */
export function retireGuest(uploaded: Trip[]) {
  const sent = new Set(uploaded.map(trip => JSON.stringify(trip)));
  writeGuest(readGuest().filter(trip => !sent.has(JSON.stringify(trip))));
}

const requestKey = 'hayiti-guest-merge-requested';
/**
 * Choosing Sign in from the tab that shows the draft is the traveler's request to keep that draft in their
 * account. The request records the draft as it was at that moment, so trips added afterwards are not covered.
 * A browser that blocks or cannot fit the record has no request, and the traveler is asked after sign-in instead.
 */
export function requestGuestMerge(requested: boolean) {
  try {
    sessionStorage.removeItem(requestKey);
    const draft = requested ? localStorage.getItem(guestKey) : null;
    if (draft !== null) sessionStorage.setItem(requestKey, draft);
  } catch { /* No request is recorded. */ }
}

/** Whether the traveler asked, by choosing Sign in, to keep exactly the draft that is stored now. */
export function guestMergeRequested() {
  try {
    const requested = sessionStorage.getItem(requestKey);
    return requested !== null && requested === localStorage.getItem(guestKey);
  } catch {
    return false;
  }
}

export function discardGuest() {
  localStorage.removeItem(attemptsKey);
  localStorage.removeItem(guestKey);
}

export function writeGuest(trips: Trip[]) {
  const covered = guestMergeRequested();
  if (trips.length) localStorage.setItem(guestKey, JSON.stringify({ trips }));
  else discardGuest();
  // The tab that asked to keep the draft in an account goes on asking as the traveler edits the draft there.
  if (covered) requestGuestMerge(true);
}

// Test the extra space required by the same projected trip shown in the backup preview.
export function checkGuestBackup(trips: Trip[], restored: Trip) {
  const projected = [...trips];
  const index = projected.findIndex(trip => trip.id === restored.id);
  if (index < 0) projected.push(restored);
  else projected[index] = restored;
  const probe = 'hayiti-guest-space';
  try {
    const current = localStorage.getItem(guestKey);
    const size = guestKey.length + JSON.stringify({ trips: projected }).length;
    const extra = size - (current === null ? 0 : guestKey.length + current.length);
    if (extra <= 0) return;
    localStorage.setItem(probe, ' '.repeat(Math.max(0, extra - probe.length)));
    localStorage.removeItem(probe);
  } catch {
    throw Error('אין מספיק מקום בדפדפן לייבוא הגיבוי. פתחו את הגיבוי ביומן הנייד או היכנסו לחשבון ונסו שוב.');
  }
}

async function fingerprint(trip: Trip) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(trip)));
  return Array.from(new Uint8Array(bytes, 0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}

interface Attempt { guestId: string; targetId: string; before: string; sent: string }

export async function prepareGuestMerge(account: Trip[], guest: Trip[], copyTitle: (title: string) => string) {
  const changed: Trip[] = [];
  let copies = 0;
  if (!guest.length) return { changed, copies };
  const raw = localStorage.getItem(attemptsKey);
  const previous: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(previous)) throw Error('השמירה נכשלה');
  const attempts: Attempt[] = [];
  for (const draft of guest) {
    let next = draft;
    const attempt: unknown = previous.find(item => isRecord(item) && item.guestId === draft.id);
    const target = isRecord(attempt) && account.find(trip => trip.id === attempt.targetId);
    const existing = account.find(trip => trip.id === draft.id);
    let replace: Trip | undefined;
    if (target && isRecord(attempt)) {
      const hash = await fingerprint(target);
      // Only update the version previously submitted or its unchanged predecessor.
      if (hash === attempt.sent || hash === attempt.before) replace = target;
    }
    if (replace && replace.id !== draft.id) next = { ...draft, id: replace.id, title: copyTitle(draft.title) };
    if (!replace && existing) {
      if (JSON.stringify(existing) === JSON.stringify(draft)) continue;
      next = { ...draft, id: 'guest-' + await fingerprint(draft), title: copyTitle(draft.title) };
      if (account.some(trip => trip.id === next.id)) continue;
    }
    const sent = await fingerprint(next);
    const before = replace ? await fingerprint(replace) : '';
    attempts.push({ guestId: draft.id, targetId: next.id, before, sent });
    if (sent === before) continue;
    if (replace) account[account.indexOf(replace)] = next;
    else account.push(next);
    changed.push(next);
    if (next.id !== draft.id) copies++;
  }
  // Save small fingerprints before POST so a dropped reply or reload can be reconciled.
  if (changed.length) localStorage.setItem(attemptsKey, JSON.stringify(attempts));
  return { changed, copies };
}
