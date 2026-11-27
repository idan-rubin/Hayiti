// Increment when an older client would discard persisted fields during a full save.
export const journalSchemaVersion = 1;

export class JournalSchemaError extends Error {
  constructor() {
    super('This journal uses a different app version. Reload this page before saving again. Your saved journal has not been changed.');
  }
}

export function requireJournalSchema(version: unknown, allowLegacy = false) {
  if (version !== journalSchemaVersion && !(allowLegacy && version === undefined)) throw new JournalSchemaError();
}
