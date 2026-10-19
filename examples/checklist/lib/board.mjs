import { parseOperation } from './input.mjs';
const key = value => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
const rejected = (opId, reason) => ({ type: 'rejected', opId, reason });
const acknowledged = (opId, revision) => ({ type: 'ack', opId, revision });

export class Board {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS board_meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO board_meta (id, revision) VALUES (1, 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS board_items (id TEXT PRIMARY KEY, text TEXT NOT NULL, checked INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS board_receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL, reason TEXT)');
    if (![...this.sql.exec('PRAGMA table_info(board_receipts)')].some(column => column.name === 'reason')) this.sql.exec('ALTER TABLE board_receipts ADD COLUMN reason TEXT');
  }
  first(query, ...bindings) { return [...this.sql.exec(query, ...bindings)][0]; }
  snapshot() {
    const { revision } = this.first('SELECT revision FROM board_meta WHERE id = 1');
    const items = [...this.sql.exec('SELECT id, text, checked FROM board_items ORDER BY id')].map(row => ({ ...row, checked: Boolean(row.checked) }));
    return { type: 'snapshot', revision, items };
  }
  apply(opId, value) {
    if (!key(opId)) return rejected('', 'invalid-operation-id');
    return this.storage.transactionSync(() => this.commit(opId, value));
  }
  commit(opId, value) {
    const receipt = this.first('SELECT payload, revision, reason FROM board_receipts WHERE id = ?', opId);
    if (receipt) return this.replay(opId, value, receipt);
    if (this.first('SELECT COUNT(*) AS count FROM board_receipts').count >= 1000) return rejected(opId, 'operation-capacity');
    const operation = parseOperation(value);
    const refusal = operation ? this.mutate(operation) : 'invalid-operation';
    if (!refusal) this.sql.exec('UPDATE board_meta SET revision = revision + 1 WHERE id = 1');
    const { revision } = this.first('SELECT revision FROM board_meta WHERE id = 1');
    this.sql.exec('INSERT INTO board_receipts (id, payload, revision, reason) VALUES (?, ?, ?, ?)', opId, JSON.stringify(operation ?? value) ?? 'undefined', revision, refusal);
    return refusal ? rejected(opId, refusal) : acknowledged(opId, revision);
  }
  replay(opId, value, receipt) {
    const operation = parseOperation(value);
    if ((JSON.stringify(operation ?? value) ?? 'undefined') !== receipt.payload) return rejected(opId, 'operation-conflict');
    return receipt.reason ? rejected(opId, receipt.reason) : acknowledged(opId, receipt.revision);
  }
  mutate(operation) {
    const exists = this.first('SELECT id FROM board_items WHERE id = ?', operation.itemId);
    if (operation.kind === 'set') {
      if (!exists) return 'unknown-item';
      this.sql.exec('UPDATE board_items SET checked = ? WHERE id = ?', Number(operation.checked), operation.itemId);
      return null;
    }
    if (exists) return 'item-exists';
    if (this.first('SELECT COUNT(*) AS count FROM board_items').count >= 100) return 'item-capacity';
    this.sql.exec('INSERT INTO board_items (id, text, checked) VALUES (?, ?, 0)', operation.itemId, operation.text);
    return null;
  }
}
