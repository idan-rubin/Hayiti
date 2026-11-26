import { cleanTrip, type Trip } from '../domain/core.ts';
import { prepareGuestMerge, UnreadableDraft } from './guest-draft.ts';
import { journalStorage, SaveRejected } from './journal-storage.ts';

type Mode = 'initial' | 'snapshot' | 'portable' | 'memory' | 'guest' | 'account';
type LoadResult =
  | { kind: 'portable' | 'guest' | 'signed-out' | 'account' | 'unchanged' | 'merge-conflict' | 'merge-not-sent' | 'unconfirmed' }
  | { kind: 'merged'; trips: number; copies: number }
  | { kind: 'refused' | 'unreadable-draft'; reason: string };
type EditResult = 'saved' | 'saved-after-refresh' | 'ignored' | 'loading' | 'superseded' | 'conflict' | 'storage-error';

class LocalSaveFailed extends Error {}

export function localToday() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

export class JournalSession {
  trips: Trip[] = [];
  day = localToday();
  mode: Mode = 'initial';
  private selectedId?: string;
  private rev = '';
  private epoch = 0;
  private saving = false;
  private loading: Promise<LoadResult> | null = null;
  private readonly storage: typeof journalStorage;

  constructor(storage = journalStorage) {
    this.storage = storage;
  }

  /** Identifies the stored journal version this tab last read or wrote. */
  get revision() {
    return this.rev;
  }

  get trip() {
    return this.trips.find(trip => trip.id === this.selectedId) ?? null;
  }

  select(trip: Trip | null | undefined, day?: string) {
    this.selectedId = trip?.id;
    this.day = trip && day && day >= trip.start && day <= trip.end ? day : trip?.start ?? localToday();
  }

  private replace(mode: Mode, trips: Trip[], rev = '', preferredId = this.selectedId) {
    this.epoch++;
    this.mode = mode;
    this.trips = trips;
    this.rev = rev;
    this.select(trips.find(trip => trip.id === preferredId) ?? trips[0], this.day);
  }

  /** Another tab saved the guest draft. Show its version so this tab never writes over it with an older one. */
  adoptGuestDraft() {
    if (this.mode !== 'guest' || this.saving) return false;
    this.replace('guest', this.storage.readGuest());
    return true;
  }

  showSnapshot(trip: Trip | null) {
    this.replace('snapshot', trip ? [trip] : []);
    this.select(trip);
  }

  async load(portable: boolean, copyTitle: (title: string) => string, afterConflict = false): Promise<LoadResult> {
    const revision = this.rev;
    // A read started before the rejected write can still return its old revision.
    if (afterConflict && this.loading) await this.loading.catch(() => {});
    this.loading ??= this.read(portable, copyTitle).catch((error): LoadResult => {
      if (!(error instanceof UnreadableDraft)) throw error;
      this.replace('initial', []);
      return { kind: 'unreadable-draft', reason: error.message };
    }).finally(() => { this.loading = null; });
    const result = await this.loading;
    if (afterConflict && result.kind === 'account' && this.rev === revision) return { kind: 'unchanged' };
    return result;
  }

  private async read(portable: boolean, copyTitle: (title: string) => string): Promise<LoadResult> {
    if (portable) {
      if (this.mode !== 'memory') {
        const trips = await this.storage.readPortable();
        if (trips) this.replace('portable', trips);
        else this.mode = 'memory';
      }
      return { kind: 'portable' };
    }
    const revisionAtRead = this.rev;
    const account = await this.storage.readAccount();
    if (!account) {
      const expired = this.mode === 'account';
      if (expired) this.replace('guest', []);
      if (!this.trips.length || this.mode !== 'guest') this.replace('guest', this.storage.readGuest());
      return { kind: expired && !this.trips.length ? 'signed-out' : 'guest' };
    }

    if (this.mode === 'account' && (this.rev !== revisionAtRead || (this.saving && account.rev === this.rev))) {
      return { kind: 'unchanged' };
    }
    const guest = this.storage.readGuest();
    let started: Trip[] | undefined;
    let copies: number;
    try {
      ({ changed: started, copies } = await prepareGuestMerge(account.trips, guest, copyTitle));
      if (started.length) account.rev = await this.storage.writeAccount(account);
    } catch (error) {
      if (this.mode !== 'guest' || !this.trip) this.replace('guest', guest);
      if (!started) return { kind: 'merge-not-sent' };
      if (!(error instanceof SaveRejected) || error.status >= 500) return { kind: 'unconfirmed' };
      if (error.status === 409) return { kind: 'merge-conflict' };
      return { kind: 'refused', reason: error.message };
    }
    const preferred = started.find(trip => trip.id === this.selectedId) ?? started[0];
    this.replace('account', account.trips, account.rev, preferred?.id);
    try {
      if (guest.length) this.storage.writeGuest([]);
    } catch { /* An already-merged draft is safe to reconcile on the next load. */ }
    return started.length ? { kind: 'merged', trips: started.length, copies } : { kind: 'account' };
  }

  async change(edit: () => void): Promise<EditResult> {
    if (this.saving || this.mode === 'snapshot') return 'ignored';
    if ((this.loading && this.mode !== 'account') || this.mode === 'initial') return 'loading';
    this.saving = true;
    const epoch = this.epoch;
    const previous = structuredClone(this.trips);
    const previousId = this.selectedId;
    const previousDay = this.day;
    try {
      edit();
      this.trips = this.trips.map(cleanTrip);
      if (this.mode === 'account') {
        const rev = await this.storage.writeAccount({ trips: this.trips, rev: this.rev });
        if (epoch === this.epoch) this.rev = rev;
      } else if (this.mode === 'guest' || this.mode === 'portable') {
        try {
          if (this.mode === 'guest') this.storage.writeGuest(this.trips);
          else await this.storage.writePortable(this.trips);
        } catch {
          throw new LocalSaveFailed();
        }
      }
      if (epoch !== this.epoch) return 'saved-after-refresh';
      this.select(this.trip ?? this.trips[0], this.day);
      return 'saved';
    } catch (error) {
      if (epoch !== this.epoch) return 'superseded';
      this.trips = previous;
      this.select(previous.find(trip => trip.id === previousId), previousDay);
      if (error instanceof LocalSaveFailed) return 'storage-error';
      if (error instanceof SaveRejected && error.status === 409) return 'conflict';
      throw error;
    } finally {
      this.saving = false;
    }
  }
}
