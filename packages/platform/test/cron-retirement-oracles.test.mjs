import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSurvivorApproval, assertUnpublishedNamespace, assertQueuedSurvivor } from '../../../scripts/cron-probe/retirement/oracles.mjs';
import { query, selectApps, completedImport } from '../../../scripts/cron-probe/retirement/applications.mjs';

test('survivor completion requires a snapshot with accepted input, no result and real queue backlog', () => {
  const point = { before: { replacement: { import_jobs: [{ id: 'pending', status: 'accepted' }], import_results: [] } }, manifest: { queueRecovery: { apps: { replacement: { observation: { backlogCount: 1 } } } } } };
  assertQueuedSurvivor(point, 'replacement', 'pending');
  for (const corrupt of [
    value => { value.before.replacement.import_jobs[0].status = 'complete'; },
    value => { value.before.replacement.import_jobs = []; },
    value => { value.before.replacement.import_results.push({ job_id: 'pending' }); },
    value => { value.manifest.queueRecovery.apps.replacement.observation.backlogCount = 0; },
  ]) {
    const changed = structuredClone(point); corrupt(changed);
    assert.throws(() => assertQueuedSurvivor(changed, 'replacement', 'pending'));
  }
});

test('restored queue completion is observed through GET without resubmitting input or sending another message', async () => {
  const probe = { async appRequest(name, path, options = {}) {
    assert.equal(name, 'replacement'); assert.equal(path, '/api/imports?id=restored-job');
    assert.ok(!options.method || options.method === 'GET'); assert.equal(options.body, undefined);
    return { status: 200, json: async () => ({ status: 'complete', results: [{ label: 'RETAINED' }] }) };
  } };
  const job = await completedImport(probe, 'replacement', 'restored-job', ['RETAINED']);
  assert.equal(job.status, 'complete');
});

test('fixture selection caches declared database names for normal and privately renamed apps and drops retired bindings', async () => {
  const state = { apps: {
    old: { retirement: { previous: { prefix: 'old' } } },
    replacement: { slot: 'two', active: 'queued', resources: { queues: {} } },
    'scheduled-next': { slot: 'one', active: 'scheduled', resources: { crons: ['* * * * *'] } },
  }, deployments: {
    queued: { id: 'queued', digest: 'a'.repeat(64), version: 'queue-version', resources: { d1: [{ database_name: 'replacement-db', database_id: 'different-identity' }] } },
    scheduled: { id: 'scheduled', digest: 'b'.repeat(64), version: 'cron-version', secretRevision: 'selected', resources: { d1: [{ database_name: 'refresh-db', database_id: 'refresh-db' }] } },
  } };
  const probe = { databases: { old: 'must-not-survive' }, compose: async () => JSON.stringify(state) };
  await selectApps(probe);
  assert.deepEqual(probe.databases, { replacement: 'replacement-db', 'scheduled-next': 'refresh-db' });
  assert.deepEqual(probe.backgroundApps, { replacement: 'delivery', 'scheduled-next': 'dispatch' });
});

test('a renamed fixture queries its approved database name in the replacement fleet', async () => {
  const slot = { id: 'replacement-fleet', prefix: 'replacement/prefix' };
  const probe = { approvals: { replacement: { slot: slot.id, deployment: 'approved-replacement' } }, slots: [slot], databases: { replacement: 'replacement-db' },
    async cli(args, selected) {
      assert.equal(selected, slot); assert.equal(args[2], 'replacement-db');
      assert.ok(args.includes('/var/lib/fogd/artifacts/approved-replacement'));
      return '{"id":"new-app-row"}\n';
    } };
  assert.deepEqual(await query(probe, 'replacement', 'SELECT id FROM import_jobs;'), [{ id: 'new-app-row' }]);
});

test('retirement approval evidence compares source pins and detects a changed target even if the target is internally consistent', () => {
  const original = { slot: 'one', deployment: 'approved', digest: 'a'.repeat(64), secretRevision: 'secret-one', version: 'version-one' };
  const source = { apps: { survivor: { slot: 'one', active: 'approved' } }, deployments: { approved: { id: 'approved', digest: original.digest, secretRevision: original.secretRevision, version: original.version } } };
  assertSurvivorApproval(source, 'survivor', original);
  for (const field of ['digest', 'secretRevision', 'version']) {
    const changed = structuredClone(source); changed.deployments.approved[field] = 'changed-target';
    assert.throws(() => assertSurvivorApproval(changed, 'survivor', original), /differs from the source snapshot/);
  }
  const moved = structuredClone(source); moved.apps.survivor.slot = 'two';
  assert.throws(() => assertSurvivorApproval(moved, 'survivor', original), /differs from the source snapshot/);
});

test('idle wake format is permitted, while ownership, deployment, timer and database state disqualify an unpublished fleet', () => {
  const prefix = 'replacement/new';
  assertUnpublishedNamespace(prefix, []);
  assertUnpublishedNamespace(prefix, [{ key: `${prefix}/wake/format.json` }]);
  for (const key of ['fogd-owner.json', 'deploy/current.json', 'cells/.cron:old/control.json', 'cells/.d1:old/log', 'wake/entries/old.json']) {
    assert.throws(() => assertUnpublishedNamespace(prefix, [{ key: `${prefix}/${key}` }]), /no app ownership, deployment, cells or timer entries/);
  }
});
