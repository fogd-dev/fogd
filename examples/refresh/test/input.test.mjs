import test from 'node:test';
import assert from 'node:assert/strict';
import { readMode } from '../lib/input.mjs';
test('source mode input accepts a known mode and rejects malformed or unsupported settings', async () => {
  assert.equal(await readMode(new Request('http://refresh.localhost/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"offline"}' })), 'offline');
  await assert.rejects(readMode(new Request('http://refresh.localhost/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"other"}' })), error => error.status === 400);
  await assert.rejects(readMode(new Request('http://refresh.localhost/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })), error => error.status === 400);
});
test('source settings cancel oversized chunked input without relying on Content-Length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } });
  await assert.rejects(readMode(new Request('http://refresh.localhost/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' })), error => error.status === 413);
  assert.equal(cancelled, true);
});
