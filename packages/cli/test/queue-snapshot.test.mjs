import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queueRetentionContract, queueExpiry } from '@fogd/platform/queue-snapshot';
import { queueSnapshotEvidence, prepareQueueBackup } from '../src/recovery/queue-backup.mjs';
import { restoredQueueState } from '../src/recovery/queue-restore.mjs';
import { execute } from '../src/recovery/execute.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { config, services, volumes } from './fixtures/recovery-layout.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

function source(at = Date.now()) {
  const id = randomUUID(), deployment = randomUUID(), digest = 'a'.repeat(64);
  const observation = { paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: at - 1000 };
  const receipt = { schema: 1, id, deployment, digest, version: 'private-version', queue: 'jobs', slot: 'one', at, completedAt: at, observation, contract: queueRetentionContract, expiresAt: queueExpiry(observation, at) };
  const app = { active: deployment, slot: 'one', route: 'active', resources: { queues: {} }, queueBootstrap: { phase: 'application' }, delivery: { queue: 'jobs', desired: 'paused', observed: 'paused', hold: null, operation: null, version: 'private-version' }, queueSnapshot: receipt };
  return { receipt, expected: { imports: id }, state: { requirements: ['fogd-queue-activation-v1'], apps: { imports: app }, deployments: { [deployment]: { id: deployment, app: 'imports', status: 'active', digest, version: 'private-version', resources: { queues: {} } } } } };
}

test('stopped evidence refuses stale identities, mutations, interrupted approvals, and expiration', async () => {
  const { state, expected, receipt } = source();
  assert.equal(queueSnapshotEvidence(state, expected).apps.imports.id, receipt.id);
  assert.throws(() => queueSnapshotEvidence(state, { imports: randomUUID() }), /preparation changed/);
  assert.throws(() => queueSnapshotEvidence(state, {}, receipt.at), /inventory changed/);
  assert.throws(() => queueSnapshotEvidence(state, expected, receipt.expiresAt), /expired/);
  assert.equal(queueSnapshotEvidence(state, expected, receipt.expiresAt - 1).schema, 1);
  state.apps.imports.queueRecovery = { status: 'pending' };
  assert.throws(() => queueSnapshotEvidence(state, expected), /Acknowledge existing/);
  delete state.apps.imports.queueRecovery;
  state.apps.imports.route = 'paused';
  assert.throws(() => queueSnapshotEvidence(state, expected), /active routing/);
  state.apps.imports.route = 'active'; state.apps.imports.delivery.desired = 'running';
  assert.throws(() => queueSnapshotEvidence(state, expected), /operator pause/);
  state.apps.imports.delivery.desired = 'paused';
  await assert.rejects(prepareQueueBackup({}, state, { controller: 'image-a', replica: 'image-b' }, ['replica']), /identical pinned/);
});

test('offline restore writes a fresh pending receipt only for matching unexpired evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-queue-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { state, expected, receipt } = source();
  state.apps.imports.queueRecovery = { status: 'acknowledged', previousAudit: 'retained' };
  const manifest = { queueRecovery: queueSnapshotEvidence(state, expected) };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  const restored = await restoredQueueState(dir, manifest, null, receipt.at);
  const app = restored.apps.imports;
  assert.deepEqual(app.queueRecovery.previous, state.apps.imports.queueRecovery);
  assert.equal(app.queueSnapshot, undefined); assert.equal(app.queueRecovery.status, 'pending');
  assert.equal(app.route, 'paused'); assert.ok(restored.requirements.includes('fogd-queue-recovery-v1'));
  const second = await restoredQueueState(dir, manifest, null, receipt.at);
  assert.notEqual(app.queueRecovery.id, second.apps.imports.queueRecovery.id);
  await assert.rejects(restoredQueueState(dir, manifest, null, receipt.expiresAt), /expired/);
  await assert.rejects(restoredQueueState(dir, {}, null, receipt.at), /legacy queued/);
  await assert.rejects(restoredQueueState(dir, manifest, { kind: 'expansion' }, receipt.at), /not qualified/);
  const tampered = structuredClone(manifest); tampered.queueRecovery.apps.imports.observation.backlogBytes++;
  await assert.rejects(restoredQueueState(dir, tampered, null, receipt.at), /differs/);
});


test('real CLI refuses an expired checksummed queue bundle before contacting Docker', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-expired-queue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { state, expected, receipt } = source(Date.now() - queueRetentionContract.retentionMs);
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  const files = {};
  for (const name of ['compose.json', 'images.tar', ...volumes.map(v => `${v}.tar`)]) {
    if (name !== 'controller.tar') await writeFile(join(dir, name), name === 'compose.json' ? JSON.stringify(config()) : 'unused');
    files[name] = await fingerprint(join(dir, name));
  }
  const manifest = { format: 'fogd-stopped-v1', sourceProject: 'original', files, images: Object.fromEntries(services.map(s => [s, 'sha256:' + 'a'.repeat(64)])), queueRecovery: queueSnapshotEvidence(state, expected, receipt.at) };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const target = join(dir, 'target');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'restore', dir, '--project', 'fresh', '--output', target], { env: { ...process.env, DOCKER_HOST: 'unix:///nonexistent-fogd-recovery-test.sock' } }), error => error.stderr.includes('snapshot is expired'));
  await assert.rejects(access(target), /ENOENT/);
});
