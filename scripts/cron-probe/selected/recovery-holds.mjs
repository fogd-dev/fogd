import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { controllerState, approvedArtifacts, vmTime } from './observations.mjs';
import { recoveredData, applicationData } from './recovery-fixtures.mjs';
import { recoveryFence, neverStartedIngress, nativeProcesses } from './recovery-fence.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { expectRefusal } from './evidence.mjs';
import { heldDataInterval } from './recovery-interval.mjs';
import { backgroundSurfaces, assertBackgroundHeld, backgroundRoute } from './recovery-held-state.mjs';

export async function coldRecovery(target, point, installations) {
  const fence = await recoveryFence(target, installations);
  await stopped(target.project, Object.values(target.config.volumes).map(volume => volume.name));
  const beforeIngress = await neverStartedIngress(target);
  const artifacts = await approvedArtifacts(target, point.approvals);
  const nodes = target.policy.fleets.flatMap(fleet => fleet.nodes.map(node => node.host));
  await target.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'minio', 'bucket-init', ...nodes]);
  const before = await waitFor('cold native state matches the stopped snapshot', async () => recoveredData(target, point.approvals));
  assert.deepEqual(applicationData(before), point.before); assertHeld(before, point);
  const processes = await waitFor('restored native processes', () => nativeProcesses(target)), startedAt = await vmTime(target);
  target.nativeBaseline = processes;
  await heldUntil(target, point, Math.max(startedAt + 62000, ...Object.values(point.manifest.cronRecovery?.apps || {}).map(value => (value.beforePause.nextAlarm || 0) + 2000)), true);
  const after = await recoveredData(target, point.approvals); assert.deepEqual(applicationData(after), point.before); assertHeld(after, point);
  assert.deepEqual(await nativeProcesses(target), processes);
  return { fence, artifacts, beforeIngress, afterIngress: await neverStartedIngress(target), before, after, processes, startedAt, endedAt: await vmTime(target) };
}

export async function acknowledgeRecovery(target, point, installations, request) {
  const fence = await recoveryFence(target, installations);
  await neverStartedIngress(target);
  const startup = await startRecovered(target, point);
  request ||= await httpsClient(target);
  await waitFor('restored admin', async () => (await request('/v1/admin')).status === 200);
  const recorded = {}, pending = {}, acknowledged = {}, attempts = {};
  for (const [app, surface] of Object.entries(backgroundSurfaces(point))) {
    const active = point.approvals[app];
    recorded[app] = await target.json(['admin', surface, app, 'status']);
    assertRecoveryHeld(recorded[app], active);
    pending[app] = await target.json(['admin', surface, app, 'observe']);
    assertPendingRecovery(pending[app], active);
    const route = await request(backgroundRoute(surface), { app }); assert.equal(route.status, 503);
    await expectRefusal(target, ['admin', surface, app, 'resume', active.id, active.digest], /Resume requires a completed activation/);
    const result = await acknowledgeApp(target, app, surface, active); acknowledged[app] = result.acknowledged; attempts[app] = result.attempts;
    assert.equal(acknowledged[app].desired, 'paused'); assert.equal(acknowledged[app].observed, 'paused'); assert.equal(acknowledged[app].recovery.status, 'acknowledged');
  }
  const state = await controllerState(target);
  for (const [name, active] of Object.entries(point.approvals)) {
    const recovered = state.deployments[state.apps[name].active];
    assert.equal(recovered.id, active.id); assert.equal(recovered.digest, active.digest); assert.equal(recovered.secretRevision, active.secretRevision);
  }
  const before = await recoveredData(target, point.approvals); assert.deepEqual(applicationData(before), point.before); assertHeld(before, point);
  for (const [app, surface] of Object.entries(backgroundSurfaces(point))) assert.equal((await request(backgroundRoute(surface), { app })).status, 200);
  const startedAt = await vmTime(target); await heldUntil(target, point, startedAt + 62000, false);
  const after = await recoveredData(target, point.approvals); assert.deepEqual(applicationData(after), point.before); assertHeld(after, point);
  for (const app of Object.keys(point.approvals)) assert.deepEqual(acknowledged[app].recovery.observation, after[app].status);
  assert.deepEqual(await nativeProcesses(target), target.nativeBaseline);
  return { fence, startup, recorded, pending, acknowledged, attempts, before, after, startedAt, endedAt: await vmTime(target) };
}

async function startRecovered(target, point) {
  const cold = await nativeProcesses(target);
  assert.deepEqual(cold, target.nativeBaseline);
  const restarted = target.entry.routing === 'durable';
  if (restarted) {
    await target.compose(['stop', ...target.policy.fleets.flatMap(fleet => fleet.nodes.map(node => node.host))]);
    await target.compose(['stop', 'minio', 'bucket-init']);
    await stopped(target.project, Object.values(target.config.volumes).map(volume => volume.name));
  }
  await target.command(['up', '--installation', target.project]);
  const normal = await waitFor('restored native processes after normal startup', () => nativeProcesses(target), 30000);
  if (!restarted) assert.deepEqual(normal, cold);
  target.nativeBaseline = normal;
  const ready = await waitFor('approved native data after normal startup', async () => {
    const observed = await recoveredData(target, point.approvals);
    assert.deepEqual(applicationData(observed), point.before); assertHeld(observed, point);
    return observed;
  }, 60000);
  return { restarted, cold, normal, ready };
}

async function heldUntil(target, point, until, cold) {
  return heldDataInterval(target, { approvals: point.approvals, before: point.before, until,
    beforeRead: cold ? () => neverStartedIngress(target) : undefined,
    verify: async observed => { assertHeld(observed, point); if (!cold) await guardedHeld(target, observed, point); },
  });
}
function assertHeld(observed, point) {
  assertBackgroundHeld(observed, point, backgroundSurfaces(point));
}
export function assertPendingRecovery(status, active) {
  assertRecoveryHeld(status, active); assert.equal(status.observed, 'paused');
}
function assertRecoveryHeld(status, active) {
  assert.equal(status.recovery.status, 'pending'); assert.equal(status.resumeAllowed, false);
  assert.deepEqual(status.active, { deployment: active.id, digest: active.digest });
}
export async function acknowledgeApp(target, app, surface, active) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await target.json(['admin', surface, app, 'status']); assertPendingRecovery(status, active);
    const args = surface === 'dispatch' ? ['admin', 'dispatch', app, 'recover'] : ['admin', 'recover', app];
    try {
      const acknowledged = await target.json([...args, active.id, active.digest, status.recovery.id, status.recovery.review, '--accept-possible-loss']);
      attempts.push({ review: status.recovery.review, result: 'acknowledged' }); return { acknowledged, attempts };
    } catch (error) {
      if (!error.diagnosticFile) throw error;
      const diagnostic = JSON.parse(await readFile(error.diagnosticFile, 'utf8'));
      assert.equal(diagnostic.code, 1); assert.equal(diagnostic.signal, null);
      assert.match(diagnostic.stderr, /Recovery findings changed; inspect status and acknowledge again/);
      attempts.push({ review: status.recovery.review, result: 'findings-changed' });
      if (attempt === 1) throw new Error('Recovery findings changed twice; stop and inspect the retained target');
    }
  }
}

async function guardedHeld(target, observed, point) {
  for (const [app, surface] of Object.entries(backgroundSurfaces(point))) {
    const guarded = await target.json(['admin', surface, app, 'status']);
    assert.equal(guarded.desired, 'paused'); assert.equal(guarded.observed, 'paused');
    assert.deepEqual(guarded.recovery.observation, observed[app].status);
  }
}
