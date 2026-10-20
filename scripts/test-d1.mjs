// SQL-backed D1 stand-in for application integration tests, not runtime evidence.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function d1Fixture(migration) {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(migration, 'utf8'));
  const executions = new WeakMap();
  function prepare(text) {
    let args = [];
    const statement = {
      bind(...values) { args = values; return this; },
      async first() { return sql.prepare(text).get(...args) || null; },
      async all() { return { results: sql.prepare(text).all(...args) }; },
      async run() { return sql.prepare(text).run(...args); },
    };
    executions.set(statement, () => sql.prepare(text).run(...args));
    return statement;
  }
  const db = { prepare, async batch(statements) {
    sql.exec('BEGIN');
    try { const results = statements.map(statement => executions.get(statement)()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  return { db, sql, close: () => sql.close() };
}
