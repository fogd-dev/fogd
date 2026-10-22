import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedJson } from '../src/client-http.mjs';
for (const name of ['AbortError', 'TimeoutError']) test(`${name} during body read is distinguished from malformed JSON without private details`, async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('private transport details', name)); } }));
  await assert.rejects(boundedJson(response, { limit: 64, invalid: 'unreadable', interrupted: 'interrupted' }), { message: 'interrupted' });
});
test('a body exactly at the byte limit is accepted', async () => {
  assert.deepEqual(await boundedJson(new Response('{"x":1}'), { limit: 7, invalid: 'invalid', oversized: 'too large' }), { x: 1 });
});
test('one byte beyond the limit is refused before parsing', async () => {
  await assert.rejects(boundedJson(new Response(' {"x":1}'), { limit: 7, invalid: 'invalid', oversized: 'too large' }), { message: 'too large' });
});
test('a socket reset during the body read is an interruption rather than malformed JSON', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('private socket reset')); } }));
  await assert.rejects(boundedJson(response, { limit: 64, invalid: 'unreadable', interrupted: 'interrupted' }), { message: 'interrupted' });
});
