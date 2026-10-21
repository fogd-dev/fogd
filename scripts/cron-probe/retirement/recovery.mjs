import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { expect } from '../../guestbook-browser.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { rootState, requireDaemonStopped, startReplicas, waitForController } from '../recovery/client.mjs';
import { assertPausedRoute } from '../recovery/oracles.mjs';
import { selectApps, appData, control, operate } from './applications.mjs';
import { vmNow, vmWaitUntil } from '../vm-time.mjs';
import { fingerprints, retiredPrefixes, assertRetained, controllerFiles, assertControllerFiles } from './preservation.mjs';
import { assertSurvivorApproval, assertUnpublishedNamespace } from './oracles.mjs';

export async function recover(probe, point, plan = null, ordinary = false) {
  const state = await selectApps(probe);
  assertApprovals(probe, state, point.approvals);
  if (plan) {
    const app = state.apps[plan.app], cron = Boolean(app.resources.crons), audit = app.retirement[cron ? 'cron' : 'queue'];
    assert.equal(audit[cron ? 'stopScheduledWork' : 'stopQueuedWork'], true);
    assert.deepEqual(audit.prepared, point.manifest[cron ? 'cronRecovery' : 'queueRecovery'].apps[plan.app]);
    assert.equal(state.deployments[app.active].status, 'retired');
  }
  const ordinaryCommand = ['node', 'packages/platform/src/main.mjs'];
  const operatorChangedControllerCommand = ordinary && !isDeepStrictEqual(probe.config.services.controller.command, ordinaryCommand);
  if (ordinary) {
    probe.config.services.controller.command = ['node', 'packages/platform/src/main.mjs'];
    await writeFile(probe.file, JSON.stringify(probe.config, null, 2) + '\n', { mode: 0o600 });
  }
  await requireDaemonStopped(probe);
  await probe.compose(['up', '-d', '--no-deps', '--pull', 'never', 'minio']);
  const retained = await retiredPrefixes(probe, state), privateFiles = await controllerFiles(probe);
  if (plan) assert.deepEqual(await fingerprints(probe, plan.replacement.prefix), [], 'The replacement bucket namespace must be empty before any native replica starts');
  const unpublishedSlots = probe.slots.filter(slot => !Object.values(probe.approvals).some(active => active.slot === slot.id));
  const readiness = await startReplicas(probe, unpublishedSlots.flatMap(slot => slot.nodes));
  if (plan) await assertFreshReplicaIdentities(probe, plan);
  const freshReplicas = readiness.filter(value => unpublishedSlots.some(slot => slot.nodes.includes(value.node)));
  const expected = Object.fromEntries(Object.keys(probe.backgroundApps).map(name => [name, point.before[name]]));
  const cold = await quietInterval(probe, expected, point.manifest, retained, point.alarm?.due);
  await requireDaemonStopped(probe);
  const unpublished = {};
  for (const slot of unpublishedSlots) {
    const objects = await fingerprints(probe, slot.prefix);
    assertUnpublishedNamespace(slot.prefix, objects);
    unpublished[slot.id] = objects;
  }
  await probe.compose(['up', '-d', '--no-deps', '--pull', 'never', 'controller', 'workerd']);
  await waitForController(probe);
  const controller = (await projectContainers(probe.project)).find(value => value.Config.Labels['com.docker.compose.service'] === 'controller');
  assert.deepEqual(controller.Config.Cmd, probe.config.services.controller.command);
  if (ordinary) assert.deepEqual(controller.Config.Cmd, ordinaryCommand);
  await tombstones(probe, state);
  const pending = await pendingRecovery(probe, state, point.approvals);
  await assertHeld(probe, expected, point.manifest, retained);
  const acknowledged = {};
  for (const [name, value] of Object.entries(pending)) {
    const active = probe.approvals[name], args = probe.backgroundApps[name] === 'dispatch' ? ['admin', 'dispatch', name, 'recover'] : ['admin', 'recover', name];
    const receipt = value.recovery;
    acknowledged[name] = JSON.parse(await probe.command([...args, active.deployment, active.digest, receipt.id, receipt.review, '--accept-possible-loss']));
    assert.equal(acknowledged[name].recovery.status, 'acknowledged'); assert.equal(acknowledged[name].desired, 'paused');
  }
  const runningHold = await quietInterval(probe, expected, point.manifest, retained);
  assertApprovals(probe, await rootState(probe), point.approvals);
  await assertControllerFiles(probe, privateFiles);
  return { cold, freshReplicas, unpublished, pending, acknowledged, runningHold, retained, privateFiles, survivorApprovals: structuredClone(probe.approvals), defaultController: ordinary, operatorChangedControllerCommand, controllerCommand: controller.Config.Cmd };
}
function assertApprovals(probe, state, expected) {
  for (const name of Object.keys(probe.backgroundApps)) {
    assertSurvivorApproval(state, name, expected[name]);
  }
}
async function assertFreshReplicaIdentities(probe, plan) {
  const containers = await projectContainers(probe.project), slot = probe.slots.find(value => value.id === plan.previous.slot);
  for (const [index, name] of slot.nodes.entries()) {
    const container = containers.find(value => value.Config.Labels['com.docker.compose.service'] === name);
    assert.ok(container.State.Running);
    assert.ok(container.Config.Env.includes(`CELLD_NODE=${plan.replacement.nodes[index]}`));
    assert.ok(container.Config.Env.includes(`CELLD_BUCKET=s3://${probe.config.services.controller.environment.FOGD_BUCKET}/${plan.replacement.prefix}`));
  }
}
async function assertHeld(probe, expected, manifest, retained) {
  const data = await appData(probe), controls = {}, unpublished = {};
  assert.deepEqual(data, expected, 'Application rows changed before separate resume');
  for (const [name, family] of Object.entries(probe.backgroundApps)) {
    if (family !== 'dispatch') continue;
    const observed = await control(probe, name), prepared = manifest.cronRecovery.apps[name];
    controls[name] = observed;
    assert.equal(observed.paused, true); assert.equal(observed.nextAlarm, null); assert.equal(observed.revision, prepared.observation.revision);
  }
  for (const slot of probe.slots.filter(slot => !Object.values(probe.approvals).some(active => active.slot === slot.id))) {
    unpublished[slot.id] = await fingerprints(probe, slot.prefix);
    assertUnpublishedNamespace(slot.prefix, unpublished[slot.id]);
  }
  return { data, controls, unpublished, retained: await assertRetained(probe, retained) };
}
async function quietInterval(probe, expected, manifest, retained, due = 0) {
  const startedAt = await vmNow(probe);
  const before = await assertHeld(probe, expected, manifest, retained);
  const endedAt = await vmWaitUntil(probe, Math.max(startedAt + 62000, due + 2000));
  const after = await assertHeld(probe, expected, manifest, retained);
  return { startedAt, endedAt, durationMs: endedAt - startedAt, before, after };
}
async function pendingRecovery(probe, state, approvals) {
  const pending = {};
  for (const [name, family] of Object.entries(probe.backgroundApps)) {
    const value = await probe.api(`/v1/apps/${name}/${family}`); pending[name] = value;
    assert.equal(value.recovery.status, 'pending'); assert.equal(value.recovery.checkError, null); assert.equal(value.desired, 'paused');
    assert.equal(value.observed, 'paused');
    const active = approvals[name]; assert.deepEqual(value.active, { deployment: active.deployment, digest: active.digest });
    assert.equal(value.recovery.id, state.apps[name][family === 'dispatch' ? 'cronRecovery' : 'queueRecovery'].id);
    assert.equal(value.resumeAllowed, false);
    const path = family === 'dispatch' ? '/api/refresh' : '/api/imports';
    await expect.poll(async () => { try { const response = await probe.appRequest(name, path); return { status: response.status, body: await response.text() }; } catch { return null; } }, { timeout: 30000 }).toEqual({ status: 503, body: 'App activation paused' });
    const response = await probe.appRequest(name, path); assertPausedRoute(response.status, await response.text());
    await assert.rejects(mutate(probe, `/v1/apps/${name}/${family}/resume`, { deployment: active.deployment, digest: active.digest }), /Resume requires a completed activation/);
    await assert.rejects(operate(probe, name, 'resume'), error => error.exitCode === 1);
  }
  return pending;
}
async function tombstones(probe, state) {
  for (const [name, old] of Object.entries(state.apps)) {
    if (!old.retirement) continue;
    const current = (await probe.api('/v1/admin')).apps[name];
    assert.equal(current.route, 'retired'); assert.equal(current.slot, null);
    for (const field of ['dispatch', 'cronBootstrap', 'cronSnapshot', 'cronRecovery', 'delivery', 'queueRecovery']) assert.equal(current[field], undefined);
    await expect.poll(async () => { try { return (await probe.appRequest(name, '/')).status; } catch { return 0; } }, { timeout: 30000 }).toBe(404);
    const before = await probe.api('/v1/admin');
    await assert.rejects(mutate(probe, '/v1/credentials', { name: 'retired-name', apps: [name] }), /permanently retired/);
    await assert.rejects(probe.command(['admin', 'issue-token', 'retired-name', name]), error => error.exitCode === 1);
    const active = state.deployments[old.active];
    await assert.rejects(mutate(probe, `/v1/deployments/${active.id}/approve`, { digest: active.digest, secretRevision: active.secretRevision }), /permanently retired/);
    await assert.rejects(probe.command(['admin', 'approve', active.id, active.digest, ...(active.secretRevision ? [active.secretRevision] : [])]), error => error.exitCode === 1);
    await assert.rejects(mutate(probe, `/v1/apps/${name}/secrets`, { REFRESH_TOKEN: 'must-not-be-written' }, 'PUT'), /permanently retired/);
    const after = await probe.api('/v1/admin');
    assert.deepEqual(after.deployments, before.deployments); assert.deepEqual(after.credentials, before.credentials); assert.deepEqual(after.secrets, before.secrets);
  }
}
async function mutate(probe, path, body, method = 'POST') {
  const { csrf } = await probe.api('/v1/admin');
  return probe.api(path, { method, headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify(body) });
}
