import assert from 'node:assert/strict';
import { retainedReleases } from '../release/postflight.mjs';

export async function failurePostflight(probe, policy, evidence) {
  const { state, volumes } = await retainedReleases(probe);
  assert.deepEqual(state.files, ['artifacts', 'session']); assert.equal(state.artifacts.length, 3);
  assert.deepEqual(state.artifacts.map(value => value.digest).sort(), [policy.releases.artifacts.fast, policy.releases.artifacts.fast, policy.releases.artifacts.sparse].sort());
  for (const artifact of state.artifacts) assert.equal(artifact.actual, artifact.digest);
  assert.equal(new Set(state.artifacts.map(value => value.secretRevision)).size, 1);
  assert.equal(state.active.digest, policy.releases.artifacts.fast); assert.equal(state.active.status, 'active');
  assert.equal(state.app.dispatch.desired, 'paused'); assert.equal(state.app.dispatch.observed, 'paused'); assert.equal(state.app.dispatch.operation, null); assert.equal(state.app.dispatch.hold, null);
  assert.equal(evidence.controller.step, 'complete'); assert.equal(evidence.controller.release, 'final');
  assert.equal(probe.cronComparisons.at(-1).operation, 'pause'); assert.equal(probe.cronComparisons.at(-1).guarded.paused, true);
  return { retainedVolumes: volumes, noOwnedContainersOrNetworks: true, artifacts: state.artifacts,
    active: { deployment: state.active.id, digest: state.active.digest, secretRevision: state.active.secretRevision }, desired: state.app.dispatch.desired };
}
