import { cleanTrip, isRecord, type Journal, type Trip } from '../domain/core.ts';
import { readPortable, writePortable } from './portable-storage.ts';
import { guestSnapshot, readGuest, retireGuest, writeGuest } from './guest-draft.ts';

function readTrips(value: unknown): Trip[] {
  if (!isRecord(value) || !Array.isArray(value.trips)) throw Error('קריאת היומן נכשלה.');
  return value.trips.map(cleanTrip);
}

function revision(value: unknown): string {
  if (!isRecord(value) || typeof value.rev !== 'string') throw Error('קריאת היומן נכשלה.');
  return value.rev;
}

export class SaveRejected extends Error {
  readonly status: number;
  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
  }
}

export const journalStorage = {
  async readAccount(): Promise<Journal | null> {
    const response = await fetch('/api/journal', { cache: 'no-store' });
    if (response.status === 401) return null;
    if (!response.ok) throw Error('לא ניתן לקרוא את היומן כעת.');
    const value: unknown = await response.json();
    return { rev: revision(value), trips: readTrips(value) };
  },

  async writeAccount(journal: Journal): Promise<string> {
    const response = await fetch('/api/journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(journal)
    });
    if (response.status === 409) throw new SaveRejected(409, 'השמירה נכשלה');
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = isRecord(value) && typeof value.error === 'string' ? value.error : 'השמירה נכשלה';
      throw new SaveRejected(response.status, reason);
    }
    const rev = revision(value);
    if (!rev) throw Error('קריאת היומן נכשלה.');
    return rev;
  },

  readGuest,
  writeGuest,
  retireGuest,
  guestSnapshot,

  async readPortable(): Promise<Trip[] | null> {
    let raw: string | null;
    try {
      raw = await readPortable();
    } catch {
      return null; // Storage is unavailable. Keep the current in-memory journal.
    }
    return raw ? readTrips(JSON.parse(raw)) : [];
  },

  writePortable: (trips: Trip[]) => writePortable(JSON.stringify({ trips }))
};
