import test from 'node:test';
import assert from 'node:assert/strict';
import { positiveLimit, uploadBytes } from '../src/quota.mjs';

test('numeric limits fail closed and artifact accounting uses decoded bytes', () => {
  for (const value of ['abc', '', 0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => positiveLimit(value, 'limit'), /positive safe integer/);
  assert.equal(positiveLimit('17', 'limit'), 17);
  const bytes = Buffer.from('Unicode café and binary\x00');
  assert.equal(uploadBytes({ files: [{ data: bytes.toString('base64') }] }), bytes.length);
  assert.throws(() => uploadBytes({ files: [{ data: null }] }), /Invalid/);
});
