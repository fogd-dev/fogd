import assert from 'node:assert/strict';
import { selectedTrial } from './selected-trial.mjs';
import { backgroundFixtures } from './background-fixtures.mjs';
import { nativeObservation, setFaultPolicy, controllerState, vmTime } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { resumeCron, futurePhase } from './recovery-work.mjs';
import { selectedFailureNodes, gracefullyStopFailureNode, stoppedFailureNode, restartFailureNode } from './failure-containers.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { pauseObserver } from './pause-observer.mjs';
import { assertPauseUnconfirmed } from './pause-state.mjs';
import { continuedWork, heldPause } from './pause-work.mjs';
import { restartUnconfirmedController, recordedRoute } from './pause-controller.mjs';
import { waitFor } from './https.mjs';
import { commandRefusal } from './evidence.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/pause-unreachable.mjs NEW_PRIVATE_OUTPUT');
await selectedTrial(process.argv[2], 'Selected frozen-image operator pause with an unreachable member: intent remains unconfirmed, native work continues across controller restart, explicit retry confirms pause after rejoin. Full M11c acceptance and public admission remain open.', async context => {
  const { source: host, evidence } = context, fixture = await backgroundFixtures(host), active = fixture.approvals.refresh;
  host.nativeBaseline = await nativeProcesses(host); evidence.nativeBefore = host.nativeBaseline; evidence.active = active;
  const control = host.policy.fleets.find(fleet => fleet.id !== active.slot), clock = () => vmTime(host, control.nodes[0].host);
  evidence.untouchedBefore = await nativeObservation(host, control.id, fixture.approvals.imports.id, { captureProofs: true, persistedRecords: true });
  context.phase = 'source-policy'; await setFaultPolicy(host, active.slot, active.id, 'healthy', 'after-a');
  evidence.initialResume = await resumeCron(host, active); context.phase = 'healthy-source';
  evidence.initialFuture = await futurePhase(host, active, 'after-a', evidence.initialResume.requestedAt);
  const reader = await pauseObserver(host, active); evidence.observer = reader.inspect; let failure;
  try {
    evidence.beforeCut = await waitFor('stable healthy cron ownership and live advisory waker', async () => {
      const observed = await reader.read();
      return observed.info.paused === false && observed.before.waker && observed.before.waker.expires_ms > await clock() && observed.after.owner.node === observed.before.owner.node && observed.after.owner.epoch === observed.before.owner.epoch && observed.after.waker?.node === observed.before.waker.node && observed;
    });
    const nodes = await selectedFailureNodes(host, active.slot), target = nodes.find(node => node.node !== evidence.beforeCut.before.owner.node); assert.ok(target);
    evidence.target = target; context.phase = 'member-unreachable'; evidence.memberStop = await gracefullyStopFailureNode(host, target);
    const pauseRequestedAt = await clock();
    evidence.pauseRefusal = await commandRefusal(host.command(['admin', 'dispatch', active.app, 'pause']), /Scheduled operation could not be confirmed; inspect recorded dispatch and refresh status before retrying/);
    evidence.pauseRequestedAt = pauseRequestedAt; evidence.pauseRefusedAt = await clock();
    evidence.stateAfterRefusal = await controllerState(host); assertPauseUnconfirmed(evidence.stateAfterRefusal.apps.refresh, active);
    const options = { absentId: target.node, keys: evidence.beforeCut.keys, pending: true }, stopped = () => stoppedFailureNode(host, target, { exit: 0 });
    evidence.afterRefusal = await reader.read(options); assert.equal(evidence.afterRefusal.info.paused, false);
    for (const records of [evidence.afterRefusal.before, evidence.afterRefusal.after]) {
      assert.equal(records.owner.node, evidence.beforeCut.before.owner.node); assert.notEqual(records.owner.node, target.node); assert.equal(records.owner.epoch, evidence.beforeCut.before.owner.epoch);
    }
    assert.equal(evidence.afterRefusal.info.revision, evidence.beforeCut.info.revision);
    evidence.routeAfterRefusal = await recordedRoute(host); assert.deepEqual(evidence.routeAfterRefusal, { state: 'active', slot: active.slot });
    context.phase = 'controller-restart-with-member-stopped';
    evidence.controllerRestart = await restartUnconfirmedController(host, fixture.request); await stopped();
    evidence.stateAfterRestart = await controllerState(host); assertPauseUnconfirmed(evidence.stateAfterRestart.apps.refresh, active);
    assert.deepEqual(evidence.stateAfterRestart.apps.refresh.dispatch, evidence.stateAfterRefusal.apps.refresh.dispatch);
    evidence.restartObservedAt = await clock(); evidence.afterRestart = await reader.read(options); assert.equal(evidence.afterRestart.info.paused, false); assert.equal(evidence.afterRestart.info.revision, evidence.beforeCut.info.revision);
    evidence.routeAfterRestart = await recordedRoute(host); assert.deepEqual(evidence.routeAfterRestart, evidence.routeAfterRefusal);
    context.phase = 'future-work-with-unconfirmed-pause';
    const waker = evidence.beforeCut.after.waker, now = await clock();
    evidence.roleWindow = { stoppedMemberWasWaker: waker.node === target.node, recordedWakerExpiresMs: waker.expires_ms,
      continuationDeadline: Math.max(now + 180000, waker.node === target.node ? waker.expires_ms + 2 * evidence.defaults.wakerTickMs + evidence.defaults.nodeLeaseTtlMs + evidence.defaults.operationDeadlineMs + 30000 : 0) };
    evidence.survivorFuture = await continuedWork(reader, options, evidence.restartObservedAt, stopped, evidence.roleWindow.continuationDeadline); evidence.memberStillStopped = await stopped();
    context.phase = 'member-rejoin-and-explicit-pause'; evidence.memberRestart = await restartFailureNode(host, target, { exit: 0 });
    evidence.rejoined = await waitFor('complete fresh membership with pause still unconfirmed', () => reader.read({ pending: true }));
    for (const node of nodes) {
      if (node.node === target.node) assert.notEqual(evidence.rejoined.keys[node.node], evidence.beforeCut.keys[node.node]);
      else assert.equal(evidence.rejoined.keys[node.node], evidence.beforeCut.keys[node.node]);
    }
    assert.equal(evidence.rejoined.info.paused, false); evidence.explicitRetryAt = await clock();
    evidence.confirmed = await host.json(['admin', 'dispatch', active.app, 'pause']); assert.equal(evidence.confirmed.desired, 'paused'); assert.equal(evidence.confirmed.observed, 'paused'); assert.equal(evidence.confirmed.operation, null);
    const current = await nativeProcesses(host);
    for (const prior of host.nativeBaseline) {
      const now = current.find(value => value.host === prior.host); assert.equal(now.container, prior.container);
      if (prior.host === target.host) assert.ok(now.pid !== prior.pid || now.start !== prior.start); else assert.deepEqual(now, prior);
    }
    evidence.nativeAfter = current; host.nativeBaseline = current; context.phase = 'confirmed-held-minute'; evidence.held = await heldPause(reader, clock);
    assert.deepEqual(evidence.held.before.keys, evidence.rejoined.keys); assert.deepEqual(evidence.held.after.keys, evidence.rejoined.keys);
  } catch (error) { failure = error; throw error; }
  finally {
    try { await reader.close(); }
    catch (cleanup) { if (failure) throw new AggregateError([failure, cleanup], 'Pause qualification and observer cleanup failed'); throw cleanup; }
  }
  evidence.untouchedAfter = await nativeObservation(host, control.id, fixture.approvals.imports.id, { captureProofs: true, persistedRecords: true });
  assert.deepEqual(evidence.untouchedAfter.databases, evidence.untouchedBefore.databases);
  assert.deepEqual(verifiedObservationKeys(host.policy, control.id, evidence.untouchedAfter), verifiedObservationKeys(host.policy, control.id, evidence.untouchedBefore));
  for (const active of Object.values(fixture.approvals)) await scanPublicSurfaces(host, fixture.request, [active], fixture.tokens[active.app], [fixture.secret], evidence);
  evidence.shutdown = await stopSelectedHost(host); host.closed = true; return fixture;
});
