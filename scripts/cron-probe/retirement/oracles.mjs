import assert from 'node:assert/strict';

export function assertQueuedSurvivor(point, name, id) {
  const { import_jobs: jobs, import_results: results } = point.before[name];
  assert.equal(jobs.find(row => row.id === id)?.status, 'accepted', 'The survivor input must still be queued in the snapshot');
  assert.ok(!results.some(row => row.job_id === id), 'The survivor input must have no completed result before recovery');
  assert.ok(point.manifest.queueRecovery.apps[name].observation.backlogCount >= 1, 'The survivor snapshot must retain queued messages');
}

export function assertSurvivorApproval(state, name, expected) {
  const app = state.apps[name], active = state.deployments[app.active];
  assert.deepEqual({ slot: app.slot, deployment: active.id, digest: active.digest, secretRevision: active.secretRevision ?? null, version: active.version }, expected, 'Survivor approval differs from the source snapshot');
}
export function assertUnpublishedNamespace(prefix, objects) {
  assert.ok(objects.every(value => value.key === `${prefix}/wake/format.json`), 'Unpublished native fleets may retain wake-format metadata, but no app ownership, deployment, cells or timer entries');
}
