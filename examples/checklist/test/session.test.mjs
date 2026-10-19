import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChecklistSession } from '../lib/session.mjs';
class Storage {
  rows = new Map(); fail = false;
  get length() { return this.rows.size; }
  key(i) { return [...this.rows.keys()][i] ?? null; }
  getItem(k) { return this.rows.get(k) ?? null; }
  setItem(k, v) { if (this.fail) throw Error('Storage quota'); this.rows.set(k, String(v)); }
  removeItem(k) { if (this.fail) throw Error('Storage quota'); this.rows.delete(k); }
}
const add = { kind: 'add', itemId: 'first', text: 'Shared item' };
const snapshot = revision => ({ type: 'snapshot', revision, items: [], release: 'v1' });
const ack = (opId, revision) => ({ type: 'ack', opId, revision, release: 'v1' });
function fixture(storage = new Storage(), room = 'shared') {
  const sent = []; let view;
  const model = new ChecklistSession(storage, room, value => sent.push(value), value => { view = value; });
  return { model, storage, sent, get view() { return view; } };
}
function open(f, revision = 0) { f.model.opened(); f.model.receive(snapshot(revision)); }

test('persist before send, wait for snapshot, and replay unknown outcomes with the same ID after reload', () => {
  const f = fixture(); f.model.submit('op-1', add); assert.equal(f.sent.length, 0);
  f.model.opened(); assert.equal(f.sent.length, 0); f.model.receive(snapshot(0));
  assert.equal(f.sent[0].opId, 'op-1');
  const reloaded = fixture(f.storage); open(reloaded, 1);
  assert.equal(reloaded.sent[0].opId, 'op-1'); assert.equal(reloaded.view.pending, 1, 'Snapshot does not acknowledge pending work');
  reloaded.model.receive(ack('op-1', 1)); assert.equal(reloaded.view.pending, 0);
  reloaded.model.disconnected(); open(reloaded, 1); assert.equal(reloaded.sent.length, 1);
});

test('terminal rejection removes pending work and does not resend across reconnect', () => {
  const f = fixture(); open(f); f.model.submit('op-1', add);
  f.model.receive({ type: 'rejected', opId: 'op-1', reason: 'operation-capacity', release: 'v1' });
  assert.equal(f.view.pending, 0); assert.match(f.view.error, /operation-capacity/);
  f.model.disconnected(); open(f); assert.equal(f.sent.length, 1);
});

test('two tabs retain independent pending keys and room scopes; observed revision never decreases', () => {
  const a = fixture(), b = fixture(a.storage), other = fixture(a.storage, 'other');
  a.model.submit('op-a', add); b.model.submit('op-b', { ...add, itemId: 'second' });
  assert.equal(a.model.pending().length, 2); assert.equal(other.model.pending().length, 0);
  open(a); a.model.receive(ack('op-a', 1)); b.model.storageChanged();
  assert.equal(b.view.pending, 1); open(b, 1); b.model.receive(snapshot(3)); b.model.receive(snapshot(2));
  assert.equal(b.view.revision, 3);
});

test('a lower fresh server revision stops automatic writes without discarding pending work', () => {
  const f = fixture(); open(f, 5); f.model.disconnected(); f.model.submit('pending', add);
  open(f, 4); assert.equal(f.view.status, 'Writes stopped'); assert.match(f.view.error, /older/);
  assert.equal(f.model.pending().length, 1); assert.equal(f.sent.length, 0);
});

test('a concurrent tab advancing storage after connection started does not masquerade as rollback', () => {
  const f = fixture(); f.storage.setItem(f.model.prefix + 'revision', '1');
  open(f, 0); assert.equal(f.view.status, 'Connected'); assert.equal(f.storage.getItem(f.model.prefix + 'revision'), '1');
  f.model.receive(snapshot(1)); assert.equal(f.view.revision, 1);
});

test('storage failure prevents send; corrupt persisted operations never enter the native buffer', () => {
  const f = fixture(); open(f); f.storage.fail = true;
  assert.throws(() => f.model.submit('op-1', add), /quota/); assert.equal(f.sent.length, 0); assert.equal(f.view.status, 'Writes stopped');
  f.storage.fail = false; f.storage.setItem(f.model.pendingKey('bad'), '{bad');
  assert.throws(() => fixture(f.storage));
});

test('send failure keeps pending data recoverable and unknown future message types are ignored', () => {
  const f = fixture(); open(f); f.model.send = () => { throw Error('Network'); }; f.model.submit('op-1', add);
  assert.equal(f.view.status, 'Reconnecting'); assert.equal(f.model.pending().length, 1);
  f.model.receive({ type: 'new-feature', revision: 999 }); assert.equal(f.model.watermark, 0);
  f.model.send = value => f.sent.push(value); open(f); assert.equal(f.sent.length, 1);
});

test('a concurrent tab settling a key during enumeration does not block other pending operations', () => {
  const f = fixture(); f.model.submit('op-a', add); f.model.submit('op-b', { ...add, itemId: 'second' });
  const original = f.storage.getItem.bind(f.storage);
  f.storage.getItem = key => { if (key === f.model.pendingKey('op-a')) { f.storage.removeItem(key); return null; } return original(key); };
  f.model.storageChanged(); assert.notEqual(f.view.status, 'Writes stopped');
  open(f); assert.equal(f.sent.at(-1).opId, 'op-b');
});

test('shared-tab revision at disconnect blocks restored state, displays it, and needs explicit acceptance', () => {
  const a = fixture(), b = fixture(a.storage); open(b, 3); open(a, 10);
  b.model.disconnected(); b.model.submit('pending', add); open(b, 7);
  assert.equal(b.view.status, 'Writes stopped'); assert.equal(b.view.revision, 7);
  assert.equal(b.sent.length, 0); assert.equal(b.view.canAcceptRestored, true);
  b.model.acceptRestored(); assert.equal(b.view.status, 'Connected'); assert.equal(b.sent[0].opId, 'pending');
});
