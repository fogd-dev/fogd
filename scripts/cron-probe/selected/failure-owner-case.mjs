import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { beginFailurePhase } from './failure-phases.mjs';
import { assertPreparedRuntime } from './failure-runtime-state.mjs';
import { selectedOwnerRetry, assertStoppedLease, assertRecoveredOwner } from './failure-owner.mjs';
import { selectedFailureNodes, cutFailureNode, stoppedFailureNode, restartFailureNode } from './failure-containers.mjs';
import { ownerRecoveryWindow, ownerRoleTrail } from '../faults/recovery-window.mjs';
import { nativeObservation, controllerState } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { waitFor } from './https.mjs';
import { commandRefusal } from './evidence.mjs';

export async function selectedOwnerLoss({ host, active, clock, native, storage, defaults, evidence }) {
  const nodes = await selectedFailureNodes(host, active.slot);
  // Arm early in a minute; there is one scenario, with no hidden retry on a miss.
  while ((await clock()) % 60000 > 20000) await delay(1000);
  if (host.ownerPreparation) {
    evidence.preparedBeforeResume = await native.observe('prepared-state', { keys: host.ownerPreparation.keys });
    assertPreparedRuntime(evidence.preparedBeforeResume, host.ownerPreparation.owner, host.ownerPreparation.epoch, active.version);
  }
  const selected = await beginFailurePhase(host, active, 'owner-loss', clock); evidence.phase = selected;
  const verified = await native.observe('verify-both'); evidence.initial = verified;
  const time = verified.info.nextAlarm; assert.ok(time > await clock() && time % 60000 === 0);
  const context = { time, keys: verified.keys }, snapshots = []; evidence.preCut = snapshots;
  const { snapshot, retry } = await findCut(native, context, active, clock, snapshots, host.ownerPreparation?.owner ?? null);
  if (host.ownerPreparation) assert.equal(snapshot.bucket.owner.epoch, host.ownerPreparation.epoch, 'Prepared cron epoch changed before cut');
  const owner = snapshot.bucket.owner.node, survivor = nodes.find(node => node.node !== owner)?.node, target = nodes.find(node => node.node === owner); assert.ok(target && survivor);
  const killed = await cutFailureNode(host, target), killedAt = await clock();
  evidence.cut = { time, owner, survivor, target, killed, killedAt, retry };
  assert.ok(killed.finishedAt >= snapshot.completedAt && killed.finishedAt <= killedAt && killedAt < retry.due_ms);
  const postCut = await storage.observe('post-cut', { ...context, absentId: owner }); evidence.postCut = postCut;
  assert.ok(postCut.bucket.wakes.some(row => row.key === retry.key && row.due_ms === retry.due_ms));
  const window = ownerRecoveryWindow({ bucket: postCut.bucket, owner, survivor, killedAt, retryDue: retry.due_ms, defaults });
  assert.equal(window.roleHeldByKilledNode, true); evidence.window = window;
  const leaseExpires = postCut.bucket.leases.find(row => row.node === owner).expires_ms;
  evidence.survivor = await native.observe('verify-survivor', { ...context, absentId: owner });
  assertStoppedLease(evidence.survivor.after, owner, leaseExpires);
  evidence.fullGuardRefusal = await native.observe('guard-refusal', { ...context, absentId: owner });
  evidence.unavailableGuard = await refusedObserve(host);
  const untouched = host.policy.fleets.find(fleet => fleet.id !== active.slot);
  evidence.untouched = await nativeObservation(host, untouched.id, undefined, { captureProofs: true });
  const observations = [postCut]; evidence.recovery = observations;
  const recovered = await recover({ host, target, native, context, owner, survivor, leaseExpires, window, clock, observations, before: snapshot });
  const transfer = ownerRoleTrail(window, observations, owner, survivor); evidence.roleTransfer = transfer;
  evidence.fresh = assertRecoveredOwner(recovered, snapshot, survivor, time, retry.due_ms, window, transfer);
  await rejoinOwner({ host, native, active, nodes, target, owner, verified, evidence });
  return evidence;
}
async function findCut(native, context, active, clock, snapshots, expectedWaker) {
  const deadline = context.time + 16000;
  while (await clock() < context.time) await delay(250);
  while (await clock() < deadline) {
    const snapshot = await native.observe('pre-cut', context); snapshots.push(snapshot);
    const retry = selectedOwnerRetry(snapshot, context.time, active.version, expectedWaker); if (retry) return { snapshot, retry };
    await delay(100);
  }
  throw new Error('No eligible owner/waker cut before the original retry deadline');
}
async function refusedObserve(host) {
  const refusal = await commandRefusal(host.command(['admin', 'dispatch', 'refresh', 'observe']), /Scheduled operation could not be confirmed; inspect recorded dispatch and refresh status before retrying/);
  const state = await controllerState(host), app = state.apps.refresh;
  assert.equal(app.dispatch.observed, 'unknown'); assert.equal(app.dispatch.observedAt, null); assert.equal(app.uncertain, null);
  assert.equal(app.dispatch.desired, 'running'); assert.equal(app.dispatch.hold, null); assert.equal(app.dispatch.operation, null);
  return { scope: 'Ordinary observe unconfirmed while selected member is Docker-confirmed stopped', refusal, dispatch: app.dispatch, uncertain: app.uncertain };
}

async function recover({ host, target, native, context, owner, survivor, leaseExpires, window, clock, observations, before }) {
  const ids = new Set(before.rows.map(row => row.id));
  while (await clock() <= window.ceiling) {
    const stopped = await stoppedFailureNode(host, target);
    const sample = await native.observe('recovery', { ...context, absentId: owner }); sample.stopped = stopped; observations.push(sample);
    assertStoppedLease(sample.bucket, owner, leaseExpires);
    const fresh = sample.rows?.filter(row => !ids.has(row.id));
    if (sample.bucket.owner.node === survivor && sample.bucket.waker?.node === survivor && ['inventory', 'advisory'].every(job => fresh?.some(row => row.job === job && row.scheduled_time === context.time && row.outcome === 'success'))) return sample;
    await delay(500);
  }
  throw new Error('Owner recovery exceeded the fixed native-election ceiling');
}

async function rejoinOwner({ host, native, active, nodes, target, owner, verified, evidence }) {
  evidence.restart = await restartFailureNode(host, target);
  evidence.rejoined = await waitFor('fresh complete membership after owner restart', () => native.observe('verify-both'), 90000);
  for (const node of nodes) {
    if (node.node === owner) assert.notEqual(evidence.rejoined.keys[node.node], verified.keys[node.node]);
    else assert.equal(evidence.rejoined.keys[node.node], verified.keys[node.node]);
  }
  evidence.observedAgain = await host.json(['admin', 'dispatch', 'refresh', 'observe']); assert.equal(evidence.observedAgain.observed, 'running');
  const processes = await nativeProcesses(host);
  for (const prior of host.nativeBaseline) {
    const current = processes.find(row => row.host === prior.host); assert.ok(current); assert.equal(current.container, prior.container);
    if (prior.host === target.host) assert.ok(current.pid !== prior.pid || current.start !== prior.start);
    else assert.deepEqual(current, prior);
  }
  host.nativeBaseline = processes;
}
