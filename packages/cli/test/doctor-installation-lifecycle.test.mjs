import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, symlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installationLifecycleFinding } from '../src/doctor/installation-lifecycle.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-doctor-fence-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('an absent lifecycle marker is observed without creating or reserving one', async t => {
  const root = await directory(t), report = await installationLifecycleFinding(root);
  assert.equal(report.status, 'supported'); assert.deepEqual(await readdir(root), []);
});
test('a retained operation stays unverified without reading or rewriting its private fields', async t => {
  const root = await directory(t), marker = join(root, 'launch.pending.json'), bytes = '{"private":"private-operation-value"}';
  await writeFile(marker, bytes); const report = await installationLifecycleFinding(root);
  assert.equal(report.status, 'unverified'); assert.equal(await readFile(marker, 'utf8'), bytes); assert.ok(!JSON.stringify(report).includes('private-operation-value'));
});
for (const kind of ['symlink', 'directory']) test(`a ${kind} at the lifecycle marker path cannot be treated as a clear fence`, async t => {
  const root = await directory(t), marker = join(root, 'launch.pending.json');
  if (kind === 'symlink') await symlink('/private/absent-operation', marker); else await mkdir(marker);
  assert.equal((await installationLifecycleFinding(root)).status, 'unverified'); assert.deepEqual(await readdir(root), ['launch.pending.json']);
});
