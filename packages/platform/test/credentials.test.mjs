import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Credentials } from '../src/credentials.mjs';

test('deploy credentials retain scopes and revocation without storing raw tokens', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-credentials-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Credentials(dir); await store.init();
  const issued = await store.issue('Demo builder', ['accounts']);
  const header = `Bearer ${issued.token}`;
  assert.equal(store.authenticate(header).id, issued.id);
  assert.equal(store.authenticate(header + 'x'), null);
  assert.equal(store.authenticate('Bearer wrong'), null);
  store.requireScope(issued.id, 'accounts');
  assert.throws(() => store.requireScope(issued.id, 'notebook'), /scope/);
  assert.ok(!(await readFile(store.path, 'utf8')).includes(issued.token));
  assert.ok(!JSON.stringify(store.describe()).includes(issued.token));
  assert.equal(store.describe()[0].hash, undefined);
  const restarted = new Credentials(dir); await restarted.init();
  assert.equal(restarted.authenticate(header).id, issued.id);
  await restarted.revoke(issued.id);
  assert.equal(restarted.authenticate(header), null);
  assert.throws(() => restarted.requireScope(issued.id, 'accounts'), /revoked/);
  const restored = new Credentials(dir); await restored.init();
  assert.equal(restored.authenticate(header), null);
  assert.ok(restored.describe()[0].revokedAt);
});
