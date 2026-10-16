import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { password } from '../src/password.ts';

test('celld password adapter is byte-compatible with Void native Node scrypt', async () => {
  const value = 'Ａ long test password 🔐';
  const hash = await password.hash(value);
  const [salt, key] = hash.split(':');
  const native = scryptSync(value.normalize('NFKC'), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 67108864 });
  assert.equal(key, native.toString('hex'));
  assert.equal(await password.verify({ hash, password: value }), true);
  assert.equal(await password.verify({ hash, password: 'wrong password' }), false);
  assert.equal(await password.verify({ hash: 'invalid', password: value }), false);
  const nativeHash = `${salt}:${native.toString('hex')}`;
  assert.equal(await password.verify({ hash: nativeHash, password: value }), true);
});
