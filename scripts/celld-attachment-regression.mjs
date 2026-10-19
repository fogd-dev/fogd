// Focused source regression for the upstream candidate. Full isolate replacement
// is independently exercised by live-update.mjs against the compiled runtime.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serialize, deserialize } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
assert.ok(process.argv[2], 'Supply the pinned celld js/harness.js source file');
const source = await readFile(process.argv[2], 'utf8');
function method(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'Upstream method boundaries changed; inspect before updating the regression');
  return source.slice(from, to);
}
function fixture() {
  const rows = new Map();
  const context = {
    __heap_over_admission_share: () => false,
    __sockets: new Map(),
    __sc_encode: serialize,
    // Mirror the Rust seam: a pre-accept write has no metadata entry yet.
    __ws_attachment_set: (id, bytes) => { if (rows.has(id)) rows.get(id).bytes = Buffer.from(bytes); },
    __ws_accept: id => { if (!rows.has(id)) rows.set(id, {}); },
  };
  const methods = runInNewContext(`({${method('  serializeAttachment(value) {', '  deserializeAttachment()')},${method('  acceptWebSocket(ws, tags = []) {', '  _socket(id) {')}})`, context);
  const socket = { _id: 1, serializeAttachment: methods.serializeAttachment };
  return { rows, socket, accept: () => methods.acceptWebSocket.call({ _scope: 'test' }, socket), value: () => deserialize(rows.get(1).bytes) };
}
test('pre-accept clone bytes survive registry creation and later argument mutation', () => {
  const f = fixture(), value = { params: { room: 'shared' }, state: new Map([['date', new Date(0)]]) };
  f.socket.serializeAttachment(value); value.params.room = 'changed';
  assert.equal(f.rows.size, 0); f.accept();
  assert.equal(f.value().params.room, 'shared'); assert.equal(f.value().state.get('date').getTime(), 0);
});
test('the last pre-accept serialization wins, including undefined', () => {
  const f = fixture(); f.socket.serializeAttachment('first'); f.socket.serializeAttachment(undefined); f.accept(); assert.equal(f.value(), undefined);
});
test('post-accept serialization replaces the retained attachment', () => {
  const f = fixture(); f.socket.serializeAttachment('before'); f.accept(); f.socket.serializeAttachment('after'); assert.equal(f.value(), 'after');
});
test('failed clone preserves the last valid pre-accept bytes', () => {
  const f = fixture(); f.socket.serializeAttachment('valid'); assert.throws(() => f.socket.serializeAttachment(() => {})); f.accept(); assert.equal(f.value(), 'valid');
});
