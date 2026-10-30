import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { restoreAppArchiveData, readAppArchiveDataPlan } from '../src/recovery/app-archive-data.mjs';
import { restoreDurableData } from '../src/recovery/durable-restore-data.mjs';
import { durableDataTransport } from './fixtures/durable-data-transport.mjs';
import { verifyDurableBundle } from '../src/recovery/durable-bundle.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { archiveDataFixture, packRole, saveManifest, records, archiveConfig } from './fixtures/app-archive-data.mjs';
import { backgroundArchiveSource } from './fixtures/background-archive-data.mjs';

const refused = { code: 'APP_ARCHIVE_DATA_UNCONFIRMED' };

for (const family of ['queue', 'cron']) test(`${family} data restoration tolerates fresh recovery IDs without changing retained evidence`, async t => {
  const f = await archiveDataFixture(t, undefined, t => backgroundArchiveSource(t, family));
  const before = await readAppArchiveDataPlan(f.currentDir, f.retainedDir, f.config, f.selection);
  const after = await readAppArchiveDataPlan(f.currentDir, f.retainedDir, f.config, f.selection);
  const name = f.request.app, key = family + 'Recovery';
  assert.notEqual(before.projected.apps[name][key].id, after.projected.apps[name][key].id);
  assert.deepEqual(before.projected.apps[name][key].prepared, after.projected.apps[name][key].prepared);
  const result = await restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume });
  assert.equal(result.archiveIdentity, f.selection.expectedIdentity);
  assert.deepEqual(records(join(f.volumes['slot-2-a'], 'records.sqlite')), ['alpha-before-archive']);
  assert.deepEqual(records(join(f.volumes['slot-2-b'], 'records.sqlite')), ['alpha-before-archive']);
  assert.equal(await readFile(join(f.volumes.controller, 'state.json'), 'utf8'), '{"fresh":true}');
});

test('archived alpha disks restore into another fleet while current beta SQL, bucket and controller authority survive', async t => {
  const f = await archiveDataFixture(t), retained = await fingerprint(join(f.retainedDir, 'manifest.json')), current = await fingerprint(join(f.currentDir, 'manifest.json'));
  const result = await restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume });
  assert.deepEqual(records(join(f.volumes['slot-2-a'], 'records.sqlite')), ['alpha-before-archive']);
  assert.deepEqual(records(join(f.volumes['slot-2-b'], 'records.sqlite')), ['alpha-before-archive']);
  assert.deepEqual(records(join(f.volumes['slot-1-a'], 'records.sqlite')), ['beta-after-archive']);
  assert.deepEqual(records(join(f.volumes['slot-1-b'], 'records.sqlite')), ['beta-after-archive']);
  assert.equal(await readFile(join(f.volumes.controller, 'operator-secret.key'), 'utf8'), 'current-authority-key');
  assert.equal(await readFile(join(f.volumes.controller, 'state.json'), 'utf8'), '{"fresh":true}');
  assert.equal(await readFile(join(f.volumes.bucket, f.selection.profile.bucket, f.selection.profile.fleets[0].prefix, 'beta'), 'utf8'), 'beta-after-archive');
  assert.deepEqual(await fingerprint(join(f.retainedDir, 'manifest.json')), retained);
  assert.deepEqual(await fingerprint(join(f.currentDir, 'manifest.json')), current);
  assert.deepEqual(result.replicaRoles, ['slot-2-a', 'slot-2-b']);
  assert.equal(result.bucket, 'current-snapshot'); assert.equal(result.services, 'stopped');
});

test('data planning is read-only and binds both snapshots before target access', async t => {
  const f = await archiveDataFixture(t), plan = await readAppArchiveDataPlan(f.currentDir, f.retainedDir, f.config, f.selection);
  assert.deepEqual(plan.replicaSources.roles, { 'slot-2-a': 'slot-1-a', 'slot-2-b': 'slot-1-b' });
  assert.equal(plan.projected.apps.alpha.archiveRecovery.status, 'pending');
  assert.deepEqual(plan.projected.apps.beta, f.currentState.apps.beta);
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.volumes['slot-2-a']), []);
});
test('ordinary durable recovery still refuses archive-capable state', async t => {
  const f = await archiveDataFixture(t);
  await assert.rejects(verifyDurableBundle(f.currentDir, f.selection.currentProfile), { code: 'DURABLE_BUNDLE_REFUSED' });
});
test('a different archive identity refuses before any target helper', async t => {
  const f = await archiveDataFixture(t); f.selection.expectedIdentity = '0'.repeat(64);
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume }), refused);
  assert.deepEqual(f.calls, []);
});
test('changed retained namespace bytes refuse before copying either fleet', async t => {
  const f = await archiveDataFixture(t);
  await writeFile(join(f.currentBucket, f.selection.profile.bucket, f.selection.profile.fleets[1].prefix, 'cells/xl.meta'), 'changed-alpha');
  await packRole(f.currentDir, 'bucket', f.currentBucket); await saveManifest(f.currentDir, f.manifest);
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume }), refused);
  assert.deepEqual(f.calls, []);
});
test('a different original snapshot refuses even if its files still verify internally', async t => {
  const f = await archiveDataFixture(t), path = join(f.retainedDir, 'manifest.json');
  await writeFile(path, await readFile(path, 'utf8')+'\n');
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume }), refused);
  assert.deepEqual(f.calls, []);
});
test('an already occupied restoration fleet refuses before target access', async t => {
  const f = await archiveDataFixture(t); f.selection.slot = 'slot-1';
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume }), refused);
  assert.deepEqual(f.calls, []);
});
test('a namespace alias anywhere in the current bucket refuses before target access', async t => {
  const f = await archiveDataFixture(t); await symlink('slots/slot-1', join(f.currentBucket, 'alias'));
  await packRole(f.currentDir, 'bucket', f.currentBucket); await saveManifest(f.currentDir, f.manifest);
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume }), refused);
  assert.deepEqual(f.calls, []);
});
test('copy failure retains earlier current-data copies and leaves the archived replica targets incomplete', async t => {
  const f = await archiveDataFixture(t);
  const readVolume = async (image, volume, args, options) => {
    if (volume === f.config.volumes['slot-2-a'].name && args[3] === 'extract') throw Error('owned fixture lost copy response');
    return f.readVolume(image, volume, args, options);
  };
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume }), refused);
  assert.deepEqual(records(join(f.volumes['slot-1-a'], 'records.sqlite')), ['beta-after-archive']);
  assert.deepEqual(await readdir(f.volumes['slot-2-a']), []);
  assert.deepEqual(await readdir(f.volumes['slot-2-b']), []);
  assert.equal(await readFile(join(f.volumes.controller, 'operator-secret.key'), 'utf8'), 'current-authority-key');
});
test('a changed current snapshot during copying refuses completion and retains all copied disks', async t => {
  const f = await archiveDataFixture(t); let changed = false;
  const readVolume = async (image, volume, args, options) => {
    const result = await f.readVolume(image, volume, args, options);
    if (!changed && args[3] === 'extract') {
      const path = join(f.currentDir, 'manifest.json'); await writeFile(path, await readFile(path, 'utf8')+'\n'); changed = true;
    }
    return result;
  };
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume }), refused);
  assert.deepEqual(records(join(f.volumes['slot-2-a'], 'records.sqlite')), ['alpha-before-archive']);
  assert.deepEqual(records(join(f.volumes['slot-1-a'], 'records.sqlite')), ['beta-after-archive']);
  assert.equal(await readFile(join(f.volumes.controller, 'state.json'), 'utf8'), '{"fresh":true}');
});
test('a new submission under the reserved archived name refuses before target access', async t => {
  const f = await archiveDataFixture(t), state = JSON.parse(await readFile(join(f.controller, 'state.json')));
  const id = '30000000-0000-4000-8000-000000000003';
  state.deployments[id] = { id, app: 'alpha', digest: 'f'.repeat(64), status: 'pending' };
  await writeFile(join(f.controller, 'state.json'), JSON.stringify(state)); await packRole(f.currentDir, 'controller', f.controller); await saveManifest(f.currentDir, f.manifest);
  await assert.rejects(restoreAppArchiveData(f.currentDir, f.retainedDir, f.config, f.selection, { readVolume: f.readVolume }), refused);
  assert.deepEqual(f.calls, []);
});

test('archival data copying leaves fresh generation disks empty while retaining the old bucket namespace', async t => {
  const f = await archiveDataFixture(t), policy = f.selection.currentProfile;
  const config = archiveConfig(f.config, policy, 'fogd-archive-empty-test');
  const readVolume = durableDataTransport(config, policy, f.volumes, f.calls);
  const result = await restoreDurableData(f.retainedDir, config, policy, { archivedFleet: 'slot-1', readVolume });
  assert.deepEqual(result.emptyRoles, ['slot-1-a', 'slot-1-b']);
  assert.deepEqual(await readdir(f.volumes['slot-1-a']), []);
  assert.deepEqual(await readdir(f.volumes['slot-1-b']), []);
  assert.equal(await readFile(join(f.volumes.bucket, policy.bucket, f.selection.retainedProfile.fleets[0].prefix, 'fogd-owner.json/xl.meta'), 'utf8'), 'retained-alpha-owner');
});
test('archival cannot treat a retained app namespace as a fresh empty generation', async t => {
  const f = await archiveDataFixture(t);
  await assert.rejects(restoreDurableData(f.retainedDir, f.config, f.selection.profile, { archivedFleet: 'slot-2', readVolume: f.readVolume }), { code: 'DURABLE_RESTORE_DATA_UNCONFIRMED' });
  assert.deepEqual(f.calls, []);
});
