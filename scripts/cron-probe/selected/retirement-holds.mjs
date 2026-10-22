import assert from 'node:assert/strict';
import { stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { controllerState, approvedArtifacts, nativeObservation, vmTime } from './observations.mjs';
import { recoveredData, applicationData } from './recovery-fixtures.mjs';
import { recoveryFence, neverStartedIngress, nativeProcesses } from './recovery-fence.mjs';
import { heldDataInterval } from './recovery-interval.mjs';
import { acknowledgeApp, assertPendingRecovery } from './recovery-holds.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { expectRefusal } from './evidence.mjs';
import { prefixFingerprints } from '../../queue-probe/prefix-fingerprints.mjs';
import { controllerFiles } from '../retirement/preservation.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { assertUnassignedNamespace } from './retirement-policy.mjs';
import { verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';
import { assertArchivedPrefix } from './retirement-bucket.mjs';
import { backgroundSurfaces, assertBackgroundHeld, backgroundRoute } from './recovery-held-state.mjs';

export async function heldRetirement(target, point, installations) {
  const approvals = Object.fromEntries(Object.entries(point.approvals).filter(([name]) => name !== target.retiredApp));
  const before = Object.fromEntries(Object.entries(point.before).filter(([name]) => name !== target.retiredApp));
  const surfaces = backgroundSurfaces(point, approvals);
  const evidence = { fence: await recoveryFence(target, installations), approvals, surfaces };
  await stopped(target.project, Object.values(target.config.volumes).map(volume => volume.name));
  evidence.beforeIngress = await neverStartedIngress(target); evidence.artifacts = await approvedArtifacts(target, point.approvals);
  const nodes = target.policy.fleets.flatMap(fleet => fleet.nodes.map(node => node.host));
  await target.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'minio', 'bucket-init']);
  const restoredState = await controllerState(target);
  assertRetirements(restoredState);
  evidence.sourceArchivePrefixes = {};
  for (const app of Object.values(restoredState.apps)) if (app.retirement) evidence.sourceArchivePrefixes[app.retirement.app] = await assertArchivedPrefix(target, point, app.retirement.previous.prefix);
  const freshFleet = target.policy.fleets.find(fleet => fleet.id === target.retirement.previous.slot); assert.ok(freshFleet);
  evidence.unassignedBefore = await prefixFingerprints(target.compose, freshFleet.prefix, false); assert.deepEqual(evidence.unassignedBefore, []);
  evidence.retainedBefore = await waitFor('retained namespace bytes before native startup', () => retained(false));
  const privateReader = { identity: { image: target.entry.image }, config: target.config };
  evidence.privateFilesBefore = await controllerFiles(privateReader);
  await target.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...nodes]);
  evidence.timingEnvironment = await verifyNativeTimingEnvironment({ ...target, slots: target.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
  evidence.coldBefore = await waitFor('cold retirement survivor state', async () => recoveredData(target, approvals));
  assert.deepEqual(applicationData(evidence.coldBefore), before); verifyHeld(evidence.coldBefore);
  evidence.coldIdentities = [];
  for (const fleet of target.policy.fleets) evidence.coldIdentities.push(await fleetIdentity(fleet));
  evidence.coldKeys = Object.fromEntries(evidence.coldIdentities.map(observed => [observed.slot, verifiedObservationKeys(target.policy, observed.slot, observed)]));
  target.nativeBaseline = await nativeProcesses(target);
  evidence.coldStart = await vmTime(target);
  evidence.coldAfter = await heldDataInterval(target, { approvals, before, until: evidence.coldStart + 62000, verify: verifyHeld, beforeRead: () => neverStartedIngress(target) });
  evidence.coldEnd = await vmTime(target); evidence.afterIngress = await neverStartedIngress(target);
  assert.deepEqual(await nativeProcesses(target), target.nativeBaseline);
  await target.command(['up', '--installation', target.project]); const request = await httpsClient(target);
  await waitFor('retirement admin', async () => (await request('/v1/admin')).status === 200);
  evidence.pending = {}; evidence.acknowledged = {}; evidence.pendingRoutes = {};
  for (const [name, active] of Object.entries(approvals)) {
    const surface = surfaces[name], pending = await target.json(['admin', surface, name, 'status']);
    assertPendingRecovery(pending, active); evidence.pending[name] = pending;
    const path = backgroundRoute(surface);
    evidence.pendingRoutes[name] = (await request(path, { app: name })).status; assert.equal(evidence.pendingRoutes[name], 503);
    await expectRefusal(target, ['admin', surface, name, 'resume', active.id, active.digest], /Resume requires a completed activation/);
    evidence.acknowledged[name] = await acknowledgeApp(target, name, surface, active);
    assert.equal((await request(path, { app: name })).status, 200);
  }
  const state = await controllerState(target); assertRetirements(state);
  for (const [name, active] of Object.entries(approvals)) {
    const restored = state.deployments[state.apps[name].active]; assert.equal(restored.id, active.id); assert.equal(restored.digest, active.digest); assert.equal(restored.secretRevision, active.secretRevision);
    assert.equal(state.apps[name].slot, active.slot);
    assert.equal(state.apps[name][surfaces[name] === 'dispatch' ? 'cronRecovery' : 'queueRecovery'].status, 'acknowledged');
  }
  evidence.warmStart = await vmTime(target);
  evidence.warmAfter = await heldDataInterval(target, { approvals, before, until: evidence.warmStart + 62000, verify: async observed => {
    verifyHeld(observed);
    for (const [name, surface] of Object.entries(surfaces)) {
      const control = await target.json(['admin', surface, name, 'status']); assert.equal(control.desired, 'paused'); assert.equal(control.observed, 'paused');
    }
  } });
  evidence.warmEnd = await vmTime(target); assert.deepEqual(await nativeProcesses(target), target.nativeBaseline);
  evidence.warmIdentities = [];
  for (const fleet of target.policy.fleets) evidence.warmIdentities.push(await fleetIdentity(fleet));
  evidence.warmKeys = Object.fromEntries(evidence.warmIdentities.map(observed => [observed.slot, verifiedObservationKeys(target.policy, observed.slot, observed)]));
  assert.deepEqual(evidence.warmKeys, evidence.coldKeys);
  evidence.retainedAfter = await retained(true); assert.deepEqual(evidence.retainedAfter, evidence.retainedBefore);
  evidence.unassignedAfter = await prefixFingerprints(target.compose, freshFleet.prefix, true); assertUnassignedNamespace(evidence.unassignedAfter, freshFleet);
  evidence.privateFilesAfter = await controllerFiles(privateReader); assert.deepEqual(evidence.privateFilesAfter, evidence.privateFilesBefore);
  return { request, evidence };

  async function retained(running) {
    const values = {};
    for (const [name, app] of Object.entries(restoredState.apps)) if (app.retirement) {
      const prefix = app.retirement.previous.prefix, objects = await prefixFingerprints(target.compose, prefix, running);
      assert.ok(objects.length > 0); values[name] = { prefix, objects };
    }
    return values;
  }

  async function fleetIdentity(fleet) {
    const observed = await waitFor('retirement fleet identity', () => nativeObservation(target, fleet.id, undefined, { captureProofs: true }));
    if (fleet.id === target.retirement.previous.slot) { assert.equal(observed.count, 0); assert.equal(observed.truncated, false); assert.deepEqual(observed.keys, []); }
    return observed;
  }

  function assertRetirements(state) {
    assert.ok(point.retiredHistory && typeof point.retiredHistory === 'object');
    assert.deepEqual(Object.keys(state.apps).filter(name => state.apps[name].retirement).sort(), [...Object.keys(point.retiredHistory), target.retiredApp].sort());
    for (const [name, original] of Object.entries(point.retiredHistory)) {
      assert.deepEqual(state.apps[name].retirement, original); assert.equal(state.apps[name].slot, null); assert.equal(state.apps[name].route, 'retired'); assert.equal(state.apps[name].active, original.deployment);
    }
    const app = state.apps[target.retiredApp], active = point.approvals[target.retiredApp];
    assert.equal(app.slot, null); assert.equal(app.route, 'retired'); assert.equal(app.active, active.id); assert.equal(app.retirement.deployment, active.id);
    for (const [key, value] of Object.entries(target.retirement)) assert.deepEqual(app.retirement[key], value);
    const kind = point.manifest.cronRecovery?.apps[target.retiredApp] ? 'cron' : 'queue';
    assert.deepEqual(app.retirement[kind].prepared, point.manifest[kind === 'cron' ? 'cronRecovery' : 'queueRecovery'].apps[target.retiredApp]);
    assert.equal(Object.hasOwn(app.retirement, kind === 'cron' ? 'queue' : 'cron'), false);
  }

  function verifyHeld(observed) {
    assertBackgroundHeld(observed, point, surfaces);
  }
}
