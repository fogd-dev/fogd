import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../db/migrations/0001_imports.sql', import.meta.url), 'utf8'));
  function prepare(text) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return sql.prepare(text).get(...args) || null; },
      async all() { return { results: sql.prepare(text).all(...args) }; },
      async run() { return sql.prepare(text).run(...args); },
    };
  }
  const db = { prepare, async batch(statements) { sql.exec('BEGIN'); try { for (const statement of statements) await statement.run(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
  const blobs = new Map(), messages = [];
  const storage = { async put(key, value) { blobs.set(key, value); }, async get(key) { const value = blobs.get(key); return value === undefined ? null : { size: new TextEncoder().encode(value).length, async text() { return value; } }; } };
  const queue = { async send(body) { messages.push(structuredClone(body)); } };
  return { db, storage, queue, blobs, messages, close: () => sql.close() };
}
