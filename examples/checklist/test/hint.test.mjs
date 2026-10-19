import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishHint } from '../lib/hint.mjs';

test('publication failure is a separate result, including synchronous throws', async () => {
  assert.equal(await publishHint(() => { throw Error('unavailable'); }), 'failed');
  assert.equal(await publishHint(() => Promise.reject(Error('refused'))), 'failed');
  assert.equal(await publishHint(() => Promise.resolve()), 'published');
});

test('stalled publication is bounded and a later rejection stays handled', async () => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  assert.equal(await publishHint(() => pending, 5), 'timed-out');
  reject(Error('late publication failure'));
  await new Promise(resolve => setImmediate(resolve));
});
