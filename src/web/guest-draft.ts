import { cleanTrip, isRecord, mergeStops, type Trip } from '../domain/core.ts';

const guestKey = 'hayiti-unsigned-journal';
const attemptsKey = 'hayiti-guest-merge';
export class UnreadableDraft extends Error {
  constructor() { super('לא ניתן לקרוא את טיוטת הטיול בלשונית הזאת.'); }
}

export function readGuest(): Trip[] {
  let raw: string | null;
  try { raw = sessionStorage.getItem(guestKey); } catch { return []; }
  if (raw === null) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (isRecord(data) && Array.isArray(data.trips)) return data.trips.map(cleanTrip);
  } catch { /* Keep the original until the traveler explicitly discards it. */ }
  throw new UnreadableDraft();
}

export function discardGuest() {
  sessionStorage.removeItem(attemptsKey);
  sessionStorage.removeItem(guestKey);
}

export function writeGuest(trips: Trip[]) {
  if (trips.length) sessionStorage.setItem(guestKey, JSON.stringify({ trips }));
  else discardGuest();
}

// Test the extra space the normalized backup needs without replacing the live draft.
export function checkGuestBackup(trips: Trip[], backup: Trip) {
  const projected = [...trips];
  const index = projected.findIndex(trip => trip.id === backup.id);
  if (index < 0) projected.push(backup);
  else {
    projected[index] = structuredClone(projected[index]);
    mergeStops(projected[index], backup.stops);
  }
  const probe = 'hayiti-guest-space';
  try {
    const current = sessionStorage.getItem(guestKey);
    const size = guestKey.length + JSON.stringify({ trips: projected }).length;
    const extra = size - (current === null ? 0 : guestKey.length + current.length);
    if (extra <= 0) return;
    sessionStorage.setItem(probe, ' '.repeat(Math.max(0, extra - probe.length)));
    sessionStorage.removeItem(probe);
  } catch {
    throw Error('אין מספיק מקום בלשונית לייבוא הגיבוי. פתחו את הגיבוי ביומן הנייד או היכנסו לחשבון ונסו שוב.');
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
  const raw = sessionStorage.getItem(attemptsKey);
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
  if (changed.length) sessionStorage.setItem(attemptsKey, JSON.stringify(attempts));
  return { changed, copies };
}
