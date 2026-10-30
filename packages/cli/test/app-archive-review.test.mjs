import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { readAppArchivePlan, readAppArchiveRestorationPlan } from '../src/runtime/app-archive-plan.mjs';
import { appArchiveReview, assertAppArchiveReview } from '../src/recovery/app-archive-review.mjs';
import { archiveDataFixture, generation } from './fixtures/app-archive-data.mjs';
import { runtimeCli } from './fixtures/runtime-cli.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const f = await archiveDataFixture(t), p = f.selection.retainedProfile;
  const entry = { ...runtimeFamilies()[0], schema: 2, routing: 'durable', id: p.family, admission: 'qualified',
    image: p.image, storageImage: p.storageImage, binarySha256: p.binarySha256, supervisorSha256: p.supervisorSha256 };
  entry.sourceFiles['packages/platform/src/import-app-archive-routes.mjs'] = 'a'.repeat(64);
  const archiveSelection = { runtime: entry.id, expectedIdentity: runtimePolicyIdentity(p) };
  const restoreSelection = { runtime: entry.id, expectedIdentity: runtimePolicyIdentity(f.selection.currentProfile), retainedIdentity: runtimePolicyIdentity(p) };
  const archive = { app: 'alpha', digest: f.request.digest }, restore = { archive: generation, expectedIdentity: f.selection.expectedIdentity, slot: 'slot-2' };
  const choose = { choose: () => entry };
  return { ...f, entry, archiveSelection, restoreSelection, archive, restore, choose,
    archivePlan: request => readAppArchivePlan(f.retainedDir, 'archive-target', archiveSelection, request || archive, choose),
    restorePlan: request => readAppArchiveRestorationPlan(f.currentDir, f.retainedDir, 'restore-target', restoreSelection, request || restore, choose) };
}

test('archive review reports retention, reserved name, downtime and conditional capacity without private metadata', async t => {
  const f = await fixture(t), review = appArchiveReview(await f.archivePlan());
  const files = await Promise.all(Object.keys(f.manifest.files).map(name => stat(join(f.retainedDir, name))));
  assert.equal(review.sources[0].archiveMemberBytes, files.reduce((sum, file) => sum + file.size, 0));
  assert.equal(review.application.name, 'alpha'); assert.equal(review.application.digest, f.request.digest);
  assert.deepEqual(review.capacity, { plannedFleetSlotDelta: 1, availability: 'after-verified-target-completion', liveAvailableFleetSlots: null, isReservation: false });
  assert.equal(review.effects.downtime, 'whole-installation'); assert.equal(review.effects.archivedName, 'reserved');
  assert.equal(review.retention.diskBytesReclaimed, 0); assert.equal(review.retention.appDataBytes, null);
  assert.equal(review.retention.originalSnapshot, 'required-for-later-app-restoration');
  assert.equal(review.checks.cachedImages, 'not-observed'); assert.equal(review.checks.liveSources, 'not-observed');
  const text = JSON.stringify(review);
  for (const value of [f.root, 'private-user', 'private-password', 'private-gateway', 'source-private-value', f.selection.retainedProfile.fleets[0].nodes[0].id, f.selection.retainedProfile.fleets[0].prefix]) assert.ok(!text.includes(value));
});

test('archive review is stable across generated identities without reserving their resources', async t => {
  const f = await fixture(t), first = await f.archivePlan(), second = await f.archivePlan();
  assert.notEqual(first.archiveRecord.id, second.archiveRecord.id);
  assert.deepEqual(appArchiveReview(first), appArchiveReview(second));
  assertAppArchiveReview(second, appArchiveReview(first).plan);
});

test('restoration review binds both snapshot identities, selected archive and occupied target capacity', async t => {
  const f = await fixture(t), plan = await f.restorePlan(), review = appArchiveReview(plan);
  assert.deepEqual(review.sources.map(s => s.role), ['current', 'retained']);
  assert.equal(review.sources[0].identitySha256, f.restoreSelection.expectedIdentity);
  assert.equal(review.sources[1].identitySha256, f.restoreSelection.retainedIdentity);
  assert.deepEqual(review.archive, { id: generation, identity: f.restore.expectedIdentity, retainedSnapshotSha256: plan.retained.snapshot });
  assert.equal(review.application.targetFleet, 'slot-2'); assert.equal(review.capacity.plannedFleetSlotDelta, -1);
  assert.equal(review.effects.restoredExecution, 'requires-owner-approval');
  assert.equal(review.effects.backgroundRecovery, 'requires-separate-acknowledgment-and-resume');
  assert.equal(review.retention.credentials, 'current-snapshot-governs');
});

for (const operation of ['archive', 'restore']) test(`${operation} review refuses changed intent and snapshot bytes`, async t => {
  const f = await fixture(t), original = await f[operation+'Plan'](), expected = appArchiveReview(original).plan;
  const changed = structuredClone(original); changed.target.config.name = 'other-target';
  assert.throws(() => assertAppArchiveReview(changed, expected), /Archive review changed/);
  changed.target.config.name = original.target.config.name;
  changed.target.policy.networks = { control: '10.201.0.0/24', 'fleet-1': '10.201.1.0/24', 'fleet-2': '10.201.2.0/24' };
  assert.throws(() => assertAppArchiveReview(changed, expected), /Archive review changed/);
  const path = join(operation === 'archive' ? f.retainedDir : f.currentDir, 'manifest.json');
  await writeFile(path, await readFile(path, 'utf8')+'\n');
  await assert.rejects(f[operation+'Plan']({ ...f[operation], expectedPlan: expected }), { code: 'APP_ARCHIVE_PLAN_REFUSED' });
});

async function cliFixture(t) {
  const f = await fixture(t), program = await runtimeCli(f.root, 'qualified'); await writeFile(program.catalog, JSON.stringify([f.entry]));
  const bin = join(f.root, 'bin'), log = join(f.root, 'docker-called'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf called >> "$FOGD_TEST_DOCKER_LOG"\nexit 91\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_TEST_DOCKER_LOG: log, FOGD_HOME: join(f.root, 'unused-home') };
  const common = ['--runtime', f.entry.id, '--project'];
  const archiveArgs = [f.retainedDir, '--app', 'alpha', '--digest', f.request.digest, ...common, 'archive-target', '--expected-identity', f.archiveSelection.expectedIdentity];
  const restoreArgs = [f.currentDir, f.retainedDir, '--archive', generation, '--archive-identity', f.restore.expectedIdentity, '--slot', 'slot-2', '--retained-identity', f.restoreSelection.retainedIdentity,
    ...common, 'restore-target', '--expected-identity', f.restoreSelection.expectedIdentity];
  return { ...f, program, log, env, archiveArgs, restoreArgs, invoke: args => exec(process.execPath, [program.cli, 'archive', ...args], { env, timeout: 15000 }) };
}

for (const operation of ['archive', 'restore']) test(`real CLI ${operation} planning and stale execution allocate no target and contact no Docker`, async t => {
  const f = await cliFixture(t), prefix = operation === 'restore' ? ['restore'] : [], args = f[operation+'Args'];
  const first = JSON.parse((await f.invoke([...prefix, 'plan', ...args])).stdout), second = JSON.parse((await f.invoke([...prefix, 'plan', ...args])).stdout);
  assert.equal(first.plan, second.plan); assert.equal(first.effects.targetServices, 'stopped');
  const output = join(f.root, 'not-created');
  await assert.rejects(f.invoke([...prefix, ...args, '--output', output, '--expected-plan', '0'.repeat(64)]), /Durable restore is unconfirmed/);
  await assert.rejects(lstat(output), { code: 'ENOENT' }); await assert.rejects(lstat(f.log), { code: 'ENOENT' });
  await assert.rejects(lstat(f.env.FOGD_HOME), { code: 'ENOENT' });
});

for (const extra of [[], ['--expected-plan','invalid'], ['--expected-plan','0'.repeat(64),'--archive','foreign'], ['--expected-plan','0'.repeat(64),'--retained-identity','0'.repeat(64)]]) test(`execution requires an exact reviewed selection: ${JSON.stringify(extra)}`, async t => {
  const f = await cliFixture(t);
  await assert.rejects(f.invoke([...f.archiveArgs,'--output',join(f.root,'no-output'),...extra]), /Usage: fogd archive/);
  await assert.rejects(lstat(f.log), { code: 'ENOENT' });
});
