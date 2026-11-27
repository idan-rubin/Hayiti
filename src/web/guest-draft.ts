import { type Trip, isRecord } from '../domain/core.ts';
import { GuestConflict, discardUnreadableGuest, guestPersistence, readGuest, readGuestRecord, updateGuest } from './guest-storage.ts';
import type { LoadedGuestDraft } from './guest-storage.ts';
export { guestKey, readGuest, onGuestChange, UnreadableDraft, GuestConflict } from './guest-storage.ts';

const requestKey = 'hayiti-guest-merge-requested';

export function requestGuestMerge(requested: boolean, trips: Trip[] = []) {
  try {
    sessionStorage.removeItem(requestKey);
    if (requested) sessionStorage.setItem(requestKey, JSON.stringify(trips));
  } catch {}
}

export function guestMergeRequested(trips: Trip[]) {
  try { return sessionStorage.getItem(requestKey) === JSON.stringify(trips); }
  catch { return false; }
}

export async function writeGuest(trips: Trip[], expectedVersion: string) {
  const saved = await updateGuest(record => {
    if (record.version !== expectedVersion) return { result: { conflict: true, draft: { version: record.version, trips: record.trips }, covered: false } };
    const covered = guestMergeRequested(record.trips);
    record.trips = trips;
    record.version = crypto.randomUUID();
    if (!trips.length) record.attempts = [];
    return { write: true, result: { conflict: false, draft: { version: record.version, trips }, covered } };
  });
  const persistence = guestPersistence();
  const draft: LoadedGuestDraft = { ...saved.draft, ...(persistence !== 'shared' ? { persistence } : {}) };
  if (saved.conflict) throw new GuestConflict(draft);
  if (saved.covered) requestGuestMerge(true, trips);
  return draft;
}

export async function discardGuest() {
  await discardUnreadableGuest();
  requestGuestMerge(false);
}

export async function retireGuest(uploaded: Trip[]) {
  const sent = new Set(uploaded.map(trip => JSON.stringify(trip)));
  await updateGuest(record => {
    const trips = record.trips.filter(trip => !sent.has(JSON.stringify(trip)));
    if (trips.length === record.trips.length) return { result: undefined };
    record.trips = trips;
    record.version = crypto.randomUUID();
    if (!trips.length) record.attempts = [];
    return { write: true, result: undefined };
  });
}

export function tripsWaitingInTab(): number {
  try {
    const raw = sessionStorage.getItem('hayiti-unsigned-journal');
    if (raw === null) return 0;
    try {
      const value: unknown = JSON.parse(raw);
      return isRecord(value) && Array.isArray(value.trips) ? value.trips.length : 0;
    } catch { return 0; }
  } catch { return 0; }
}

export async function checkGuestBackup() {
  await readGuest();
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
  const approved = guest.map(trip => JSON.stringify(trip));
  const stillApproved = (trips: Trip[]) => {
    const current = new Set(trips.map(trip => JSON.stringify(trip)));
    return approved.every(trip => current.has(trip));
  };
  const stored = await readGuestRecord();
  // Consent covers the trips shown, not a later trip another tab added to the browser.
  if (!stillApproved(stored.trips)) throw new GuestConflict(stored);
  const previous = stored.attempts;
  if (!Array.isArray(previous)) throw Error('השמירה נכשלה');
  const attempts: Attempt[] = [];
  for (const draft of guest) {
    let next = draft;
    const existing = account.find(trip => trip.id === draft.id);
    let replace: Trip | undefined;
    for (const attempt of previous) {
      if (!isRecord(attempt) || attempt.guestId !== draft.id) continue;
      const target = account.find(trip => trip.id === attempt.targetId);
      if (!target) continue;
      const hash = await fingerprint(target);
      // Only update the version previously submitted or its unchanged predecessor.
      if (hash === attempt.sent || hash === attempt.before) {
        replace = target;
        break;
      }
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
  if (changed.length) {
    const conflict = await updateGuest(record => {
      if (!stillApproved(record.trips)) return { result: { version: record.version, trips: record.trips } };
      if (!Array.isArray(record.attempts)) throw Error('השמירה נכשלה');
      const approvedIds = new Set(guest.map(trip => trip.id));
      record.attempts = [
        ...record.attempts.filter(item => !isRecord(item) || !approvedIds.has(String(item.guestId))),
        ...attempts
      ];
      return { write: true, result: null };
    });
    if (conflict) throw new GuestConflict(conflict);
  }
  return { changed, copies };
}
