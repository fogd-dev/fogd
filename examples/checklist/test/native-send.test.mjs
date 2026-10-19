import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'void/ws';
import { ChecklistSession } from '../lib/session.mjs';

test('patched native client never buffers guarded sends across a closing window or before rollback checks', () => {
  const original = globalThis.WebSocket;
  class Socket extends EventTarget {
    static instances = []; readyState = 0; messages = [];
    constructor() { super(); Socket.instances.push(this); }
    send(message) { this.messages.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  }
  globalThis.WebSocket = Socket;
  try {
    const rows = new Map();
    const storage = { get length() { return rows.size; }, key: i => [...rows.keys()][i], getItem: k => rows.get(k) ?? null, setItem: (k, v) => rows.set(k, v), removeItem: k => rows.delete(k) };
    const socket = connect('/rooms/shared', { baseURL: 'http://localhost', reconnect: false });
    const raw = Socket.instances[0]; let view;
    assert.equal(socket.sendIfOpen({ type: 'connecting' }), false);
    raw.readyState = 3; assert.equal(socket.sendIfOpen({ type: 'closed' }), false);
    assert.equal(raw.messages.length, 0);
    const model = new ChecklistSession(storage, 'shared', event => { if (!socket.sendIfOpen(event)) throw Error('not open'); }, value => { view = value; });
    raw.open(); model.opened(); model.receive({ type: 'snapshot', revision: 3, items: [], release: 'v1' });
    raw.readyState = 2; // Before a close event can notify the app.
    model.submit('pending', { kind: 'add', itemId: 'first', text: 'Durable pending' });
    assert.equal(raw.messages.length, 0);
    raw.open(); model.opened(); assert.equal(raw.messages.length, 0, 'SDK buffer must remain empty at open');
    model.receive({ type: 'snapshot', revision: 2, items: [], release: 'v1' });
    assert.equal(view.status, 'Writes stopped'); assert.equal(raw.messages.length, 0);
    model.acceptRestored(); assert.equal(raw.messages.length, 1);
    raw.readyState = 0; socket.send({ type: 'legacy' }); raw.open();
    assert.equal(raw.messages.at(-1).type, 'legacy', 'Existing buffered send remains backward compatible');
    socket.close();
  } finally { globalThis.WebSocket = original; }
});
