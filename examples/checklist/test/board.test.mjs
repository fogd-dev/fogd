import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Board } from '../lib/board.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  let fail = null;
  const storage = {
    sql: { exec(query, ...bindings) {
      if (fail && query.includes(fail)) throw new Error('injected write failure');
      const statement = db.prepare(query);
      return statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    } },
    transactionSync(callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, storage, board: new Board(storage), failAt: value => { fail = value; } };
}
const add = { kind: 'add', itemId: 'item-1', text: 'Ship a demo' };

test('an acknowledged operation and its receipt survive reconstruction; duplicate does not undo a later edit', () => {
  const f = fixture();
  try {
    assert.equal(f.board.apply('op-1', add).revision, 1);
    assert.equal(f.board.apply('op-2', { kind: 'set', itemId: 'item-1', checked: true }).revision, 2);
    const restored = new Board(f.storage);
    assert.deepEqual(restored.apply('op-1', { text: add.text, itemId: add.itemId, kind: add.kind }), { type: 'ack', opId: 'op-1', revision: 1 });
    assert.equal(restored.snapshot().revision, 2); assert.equal(restored.snapshot().items[0].checked, true);
    assert.equal(restored.apply('op-1', { ...add, text: 'Different' }).reason, 'operation-conflict');
  } finally { f.db.close(); }
});

test('a receipt write failure rolls back the item and revision, permitting safe retry', () => {
  const f = fixture();
  try {
    f.failAt('INSERT INTO board_receipts');
    assert.throws(() => f.board.apply('op-1', add), /injected/);
    assert.deepEqual(f.board.snapshot(), { type: 'snapshot', revision: 0, items: [] });
    f.failAt(null);
    assert.equal(f.board.apply('op-1', add).revision, 1);
  } finally { f.db.close(); }
});

test('invalid operations and missing items produce typed rejection without state changes', () => {
  const f = fixture();
  try {
    let index = 0;
    for (const input of [null, [], { ...add, text: '' }, { ...add, text: 'x'.repeat(161) }, { ...add, extra: true }, { kind: 'toggle', itemId: 'item-1' }]) {
      assert.equal(f.board.apply(`invalid-${index++}`, input).reason, 'invalid-operation');
    }
    assert.equal(f.board.apply('unknown', { kind: 'set', itemId: 'missing', checked: true }).reason, 'unknown-item');
    assert.equal(f.board.apply('', add).reason, 'invalid-operation-id');
    assert.equal(f.board.snapshot().revision, 0);
  } finally { f.db.close(); }
});

test('capacity refuses new work but still resolves receipts and conflicts', () => {
  const f = fixture();
  try {
    f.board.apply('add', add);
    for (let i = 1; i < 1000; i++) assert.equal(f.board.apply(`set-${i}`, { kind: 'set', itemId: 'item-1', checked: i % 2 === 0 }).type, 'ack');
    assert.equal(f.board.apply('overflow', add).reason, 'operation-capacity');
    assert.equal(f.board.apply('add', add).revision, 1);
    assert.equal(f.board.apply('add', { ...add, text: 'Different' }).reason, 'operation-conflict');
    assert.equal(f.board.snapshot().revision, 1000);
  } finally { f.db.close(); }
});

test('item capacity and existing-item refusal do not consume revisions', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) f.board.apply(`op-${i}`, { ...add, itemId: `item-${i}` });
    assert.equal(f.board.apply('overflow', { ...add, itemId: 'item-100' }).reason, 'item-capacity');
    assert.equal(f.board.apply('existing', add).reason, 'item-exists');
    assert.equal(f.board.snapshot().revision, 100);
  } finally { f.db.close(); }
});


test('semantic rejection stays terminal when room state changes', () => {
  const f = fixture();
  try {
    const set = { kind: 'set', itemId: 'item-1', checked: true };
    assert.equal(f.board.apply('set', set).reason, 'unknown-item');
    f.board.apply('add', add);
    assert.equal(f.board.apply('set', set).reason, 'unknown-item');
    assert.equal(f.board.apply('set', { ...set, checked: false }).reason, 'operation-conflict');
    assert.equal(f.board.snapshot().revision, 1); assert.equal(f.board.snapshot().items[0].checked, false);
  } finally { f.db.close(); }
});

test('additive receipt reason column preserves the earlier accepted-receipt schema', () => {
  const f = fixture();
  try {
    f.db.exec('ALTER TABLE board_receipts DROP COLUMN reason');
    f.db.prepare('INSERT INTO board_receipts (id, payload, revision) VALUES (?, ?, ?)').run('old', JSON.stringify(add), 7);
    const upgraded = new Board(f.storage);
    assert.deepEqual(upgraded.apply('old', add), { type: 'ack', opId: 'old', revision: 7 });
  } finally { f.db.close(); }
});
