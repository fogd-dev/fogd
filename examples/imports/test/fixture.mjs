import { d1Fixture } from '../../../scripts/test-d1.mjs';
export function fixture() {
  const { db, close } = d1Fixture(new URL('../db/migrations/0001_imports.sql', import.meta.url));
  const blobs = new Map(), messages = [];
  const storage = { async put(key, value) { blobs.set(key, value); }, async get(key) { const value = blobs.get(key); return value === undefined ? null : { size: new TextEncoder().encode(value).length, async text() { return value; } }; } };
  const queue = { async send(body) { messages.push(structuredClone(body)); } };
  return { db, storage, queue, blobs, messages, close };
}
