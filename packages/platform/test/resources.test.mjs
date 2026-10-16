import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceChanges } from '../src/resources.mjs';

test('R2 additions preserve every existing identity and prohibit unrelated changes', () => {
  const base = { script: 'app', d1: [{ binding: 'DB', database_name: 'app-db' }], durable: { bindings: [] }, r2: [{ binding: 'FILES', bucket_name: 'app-files' }] };
  const grown = { ...base, r2: [...base.r2, { binding: 'STORAGE', bucket_name: 'app-storage' }] };
  assert.deepEqual(resourceChanges(base, grown), { r2Added: [grown.r2[1]] });
  assert.deepEqual(resourceChanges(grown, { ...grown, r2: [...grown.r2].reverse() }), { r2Added: [] });
  for (const next of [
    { ...base, r2: [] },
    { ...base, r2: [{ binding: 'RENAMED', bucket_name: 'app-files' }] },
    { ...base, r2: [{ binding: 'FILES', bucket_name: 'different' }] },
    { ...base, d1: [] },
    { ...base, durable: { bindings: [{ name: 'ROOM', class_name: 'Room' }] } },
    { ...base, script: 'another' },
  ]) assert.throws(() => resourceChanges(base, next), /Resource identities changed/);
});
