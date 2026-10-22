import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { stageManagedBuild, submitManagedBuild } from '../src/build-cache/lifecycle.mjs';
import { buildTree } from '../src/build-cache/tree.mjs';
import { buildFixture, origin } from './fixtures/build-cache.mjs';
const record = async root => JSON.parse(await readFile(join(root, 'record.json'), 'utf8'));
const receipt = release => ({ id: randomUUID(), app: release.app, digest: release.digest, status: 'pending' });

test('managed staging keeps private metadata outside the unchanged artifact digest', async t => {
  const { root, release } = await buildFixture(t);
  assert.equal(await artifactDigest(release.outputDir), release.digest);
  assert.equal((await buildTree(root, true)).artifactDigest, release.digest);
  assert.deepEqual(await readdir(root), ['artifact', 'record.json']);
  assert.deepEqual(await record(root), { schema: 1, app: release.app, id: release.localBuildId, phase: 'staged', digest: release.digest });
  assert.equal((await stat(join(root, 'record.json'))).mode & 0o777, 0o600);
});
test('an acknowledged upload records its normalized controller and exact submission', async t => {
  const { home, root, release } = await buildFixture(t), result = receipt(release);
  const ack = await submitManagedBuild(home, release, origin + '/', async () => {
    assert.equal((await record(root)).phase, 'uploading'); return result;
  });
  assert.deepEqual(ack, { result, receiptSaved: true });
  assert.deepEqual(await record(root), { schema: 1, app: release.app, id: release.localBuildId, phase: 'submitted', digest: release.digest, server: origin, submission: result.id });
});
test('a lost upload response stays uncertain and rethrows the original error without persisting it', async t => {
  const { home, root, release } = await buildFixture(t), failure = new Error('private-network-diagnostic');
  await assert.rejects(submitManagedBuild(home, release, origin, async () => { throw failure; }), error => error === failure);
  assert.equal((await record(root)).phase, 'uncertain');
  assert.equal((await readFile(join(root, 'record.json'), 'utf8')).includes(failure.message), false);
});
for (const change of [{ id: 'invalid' }, { app: 'other' }, { digest: 'b'.repeat(64) }]) test(`inconsistent controller receipt ${JSON.stringify(change)} remains uncertain`, async t => {
  const { home, root, release } = await buildFixture(t);
  await assert.rejects(submitManagedBuild(home, release, origin, async () => ({ ...receipt(release), ...change })), /inconsistent submission receipt/);
  assert.equal((await record(root)).phase, 'uncertain');
});
test('an unfamiliar acknowledgment status preserves the usable ID without echoing private fields', async t => {
  const { home, root, release } = await buildFixture(t), result = { ...receipt(release), status: 'private-unrecognized', diagnostic: 'private-text' };
  const ack = await submitManagedBuild(home, release, origin, async () => result);
  assert.deepEqual(ack, { result: { id: result.id, app: release.app, digest: release.digest, status: 'unconfirmed' }, receiptSaved: false });
  assert.equal((await record(root)).phase, 'uncertain');
});
test('unsupported staging records failure and retains partial output for inspection', async t => {
  const { home, project, release } = await buildFixture(t);
  await writeFile(join(project, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', unsupported_binding: 'yes' }));
  await assert.rejects(stageManagedBuild(home, { app: release.app, project, settings: {} }), /Unsupported binding/);
  const parent = join(home, '.fogd/build-cache', release.app);
  const other = (await readdir(parent)).find(id => id !== release.localBuildId);
  assert.equal((await record(join(parent, other))).phase, 'failed');
});
