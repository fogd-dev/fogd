import { DurableObject } from 'cloudflare:workers';
import { defineDurableObject } from 'void/durable';

class Ledger extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY)');
  }

  record(id: string) {
    // The unique insert makes retries of the same operation idempotent.
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO operations(id) VALUES (?)', id);
    return this.count();
  }

  count() {
    return this.ctx.storage.sql.exec('SELECT COUNT(*) AS total FROM operations').one().total;
  }
}

export default defineDurableObject({ class: Ledger });
