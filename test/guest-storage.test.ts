import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readGuest } from '../src/web/guest-storage.ts';

await test('missing draft storage reports recovery options before accessing browser globals', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    await assert.rejects(readGuest(), /Saved drafts are unavailable.*Enable browser storage.*sign in/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
