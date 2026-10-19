import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { artifactOnlyQueueRequest } from '@fogd/platform/queue-history';
import { queueBackupApps, queueSnapshotEvidence } from '../src/recovery/queue-backup.mjs';
import { assertQueueFreeRecovery } from '../src/recovery/queue-safety.mjs';
function fixture() {
  const id = randomUUID();
  const request = { id, app: 'imports', digest: 'a'.repeat(64), status: 'pending', step: 'submitted', resources: { script: 'imports', queues: { producers: [{ binding: 'QUEUE_IMPORTS', queue: 'imports-imports' }], consumers: [{ queue: 'imports-imports', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }] } } };
  return { request, state: { requirements: ['fogd-queue-activation-v1'], apps: {}, deployments: { [id]: request } } };
}
test('unapproved queue uploads and rejections do not disable backup or queue-free transformations', () => {
  const { state, request } = fixture();
  for (const status of ['pending', 'rejected']) {
    request.status = status;
    assert.equal(artifactOnlyQueueRequest(state, request), true);
    assert.deepEqual(queueBackupApps(state), []);
    assert.equal(queueSnapshotEvidence(state, {}), null);
    assert.doesNotThrow(() => assertQueueFreeRecovery(state));
  }
});
test('approval authority, assignments, invalid shapes, and lost capability cannot masquerade as inert history', () => {
  for (const amend of [r => { r.secretRevision = null; }, r => { r.step = 'preparing-activation'; }, r => { r.status = 'failed'; }, r => { r.status = 'active'; }, r => { r.resources.queues.consumers = []; }, r => { r.digest = 'bad'; }]) {
    const { state, request } = fixture(); amend(request);
    assert.equal(artifactOnlyQueueRequest(state, request), false);
    assert.throws(() => queueBackupApps(state)); assert.throws(() => assertQueueFreeRecovery(state));
  }
  const { state, request } = fixture(); state.apps.imports = { slot: 'one', claim: { deployment: request.id } };
  assert.equal(artifactOnlyQueueRequest(state, request), false);
  delete state.apps.imports; state.requirements = [];
  assert.equal(artifactOnlyQueueRequest(state, request), false);
});
test('a rejected pristine claim needs a matching durable release receipt', () => {
  const { state, request } = fixture();
  Object.assign(request, { status: 'rejected', step: 'preparing-activation', secretRevision: null });
  state.requirements.push('fogd-claim-intent-v1');
  assert.throws(() => queueBackupApps(state));
  request.claimRelease = { schema: 1, deployment: request.id, digest: request.digest, slot: 'one', prefix: 'slots/one', at: new Date().toISOString() };
  assert.deepEqual(queueBackupApps(state), []); assert.doesNotThrow(() => assertQueueFreeRecovery(state));
  for (const [key, value] of [['deployment', randomUUID()], ['digest', 'b'.repeat(64)], ['prefix', ''], ['at', 'invalid']]) {
    const changed = structuredClone(state); changed.deployments[request.id].claimRelease[key] = value;
    assert.throws(() => queueBackupApps(changed)); assert.throws(() => assertQueueFreeRecovery(changed));
  }
});

test('artifact-only accounting uses own app assignments for prototype-named apps', () => {
  const { state, request } = fixture(); request.app = 'constructor'; request.resources.script = request.app;
  for (const entry of [...request.resources.queues.producers, ...request.resources.queues.consumers]) entry.queue = 'constructor-jobs';
  assert.deepEqual(queueBackupApps(state), []); assert.doesNotThrow(() => assertQueueFreeRecovery(state));
  Object.defineProperty(state.apps, 'constructor', { value: { slot: 'one', active: request.id }, enumerable: true });
  assert.equal(artifactOnlyQueueRequest(state, request), false);
});

test('inert uploads do not hide orphaned queue lifecycle metadata on another app', () => {
  for (const key of ['delivery', 'queueBootstrap', 'queueSnapshot', 'queueRecovery', 'deliveryRecoveryError']) {
    const { state } = fixture(); state.apps.other = { [key]: null };
    assert.throws(() => queueBackupApps(state)); assert.throws(() => assertQueueFreeRecovery(state));
  }
});

test('superseded or rejected unapproved queue artifacts remain inert after a non-queue app activates', () => {
  for (const status of ['superseded', 'rejected']) {
    const { state, request } = fixture(); request.status = status;
    state.apps.imports = { slot: 'one', active: 'other', resources: { script: 'imports' } };
    assert.deepEqual(queueBackupApps(state), []); assert.doesNotThrow(() => assertQueueFreeRecovery(state));
    state.apps.imports.uncertain = request.id;
    assert.equal(artifactOnlyQueueRequest(state, request), false);
  }
});
test('a released claim stays inert after another approval uses the app name, but never while referenced', () => {
  const { state, request } = fixture();
  Object.assign(request, { status: 'rejected', step: 'preparing-activation', secretRevision: null,
    claimRelease: { schema: 1, deployment: request.id, digest: request.digest, slot: 'one', prefix: 'slots/one', at: new Date().toISOString() } });
  state.requirements.push('fogd-claim-intent-v1');
  state.apps.imports = { slot: 'one', active: 'another', resources: { script: 'imports' } };
  assert.deepEqual(queueBackupApps(state), []); assert.doesNotThrow(() => assertQueueFreeRecovery(state));
  for (const patch of [{ active: request.id }, { uncertain: request.id }, { claim: { deployment: request.id } }, { delivery: { hold: request.id } }]) {
    Object.assign(state.apps.imports, patch);
    assert.equal(artifactOnlyQueueRequest(state, request), false);
    state.apps.imports = { active: 'another' };
  }
});
