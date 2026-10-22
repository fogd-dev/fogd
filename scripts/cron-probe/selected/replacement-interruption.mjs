import assert from 'node:assert/strict';
import { submitOffline, recordOfflineApproval } from './offline-fixtures.mjs';
import { controllerState, vmTime } from './observations.mjs';
import { pollReplacement } from './replacement-migration.mjs';
import { replacementObserver } from './replacement-observer.mjs';
import { generationLogReader, generationEvent } from './replacement-generations.mjs';
import { assertResidentCron } from './failure-runtime-state.mjs';
import { waitFailureTime } from './failure-phases.mjs';
import { lateReapPlan, reapTick } from '../replacement/reap-plan.mjs';
import { waitFor } from './https.mjs';

export async function interruptedReplacement({ host, fixture, active, reader, debuggerSession, checkpoint, defaults, evidence }) {
  const clock = () => vmTime(host, host.policy.fleets[1].nodes[0].host), logs = await generationLogReader(host, active.slot);
  evidence.submitted = await submitOffline(host, fixture, 'final');
  evidence.armed = await reader.observe('arm-new'); const armedAfter = evidence.armed.mutation[0].armed_after;
  evidence.resumed = await host.json(['admin', 'dispatch', 'refresh', 'resume', active.id, active.digest]); assert.equal(evidence.resumed.observed, 'running');
  evidence.held = await pollReplacement('new pre/post-commit holds', reader, observed => {
    const rows = observed.attempts.filter(row => row.release === 'new' && row.scheduled_time > armedAfter && row.outcome === 'pending' && row.held_at && row.last_poll_at);
    return ['advisory', 'inventory'].every(job => rows.some(row => row.job === job));
  }, 90000);
  evidence.heldRows = evidence.held.attempts.filter(row => row.release === 'new' && row.scheduled_time > armedAfter && row.outcome === 'pending');
  assert.equal(evidence.heldRows.length, 2); assert.equal(new Set(evidence.heldRows.map(row => row.scheduled_time)).size, 1);
  const time = evidence.heldRows[0].scheduled_time, owner = evidence.held.bucket.owner.node; evidence.time = time;
  assertResidentCron(evidence.held.replicas, owner, active.version);
  const owning = evidence.held.replicas.find(row => row.node === owner), generation = owning.state.deployment.generation;
  evidence.adoption = generationEvent(await logs(owner, active.initialPauseAt - 15000), 'deployment_generation_adopted', generation, active.version); assert.ok(evidence.adoption);
  evidence.maintenance = lateReapPlan({ adoptedAt: evidence.adoption.at, scheduledTime: time, heldRows: evidence.heldRows, intervalMs: defaults.generationReapIntervalMs });
  assert.ok(evidence.maintenance.quietUntil < time + 55000, 'No unconfounded future retry window remains');
  const approving = host.command(['admin', 'approve', evidence.submitted.id, evidence.submitted.digest, active.secretRevision]).then(() => ({ ok: true }), error => ({ ok: false, diagnosticFile: error.diagnosticFile }));
  evidence.checkpoint = await debuggerSession.paused(checkpoint, 15000);
  evidence.checkpointAt = await clock();
  evidence.afterMigration = await pollReplacement('heartbeats after held publication checkpoint', reader, observed => evidence.heldRows.every(held =>
    observed.attempts.some(row => row.id === held.id && row.outcome === 'pending' && row.last_poll_at > evidence.checkpointAt)), 3000);
  debuggerSession.assertPaused(evidence.checkpoint.pauseSequence);
  assert.equal(evidence.afterMigration.info.paused, true); assert.equal(evidence.afterMigration.info.nextAlarm, null);
  const selected = observed => observed.attempts.filter(row => row.scheduled_time === time);
  const live = selected(evidence.afterMigration);
  assert.equal(live.length, 2); assert.ok(live.every(row => row.outcome === 'pending' && row.last_poll_at > evidence.heldRows.find(old => old.id === row.id)?.last_poll_at));
  assert.deepEqual(evidence.afterMigration.results.filter(row => row.scheduled_time === time).map(row => row.job), ['inventory']);
  assert.deepEqual(evidence.afterMigration.occurrences.filter(row => row.scheduled_time === time).map(row => [row.job, row.status]), [['advisory', 'pending'], ['inventory', 'complete']]);
  await waitFailureTime(clock, evidence.maintenance.releaseAt);
  evidence.publishRequestedAt = await clock(); assert.ok(evidence.publishRequestedAt < time + 12000);
  debuggerSession.assertPaused(evidence.checkpoint.pauseSequence); await debuggerSession.remove(checkpoint); await debuggerSession.resume();
  evidence.approval = await approving; assert.equal(evidence.approval.ok, true); evidence.approvedAt = await clock();
  const state = await controllerState(host), app = state.apps.refresh, request = state.deployments[evidence.submitted.id];
  assert.equal(app.active, request.id); assert.equal(request.status, 'active'); assert.equal(request.digest, evidence.submitted.digest); assert.equal(request.secretRevision, active.secretRevision);
  evidence.final = await recordOfflineApproval(host, fixture, 'final', { ...evidence.submitted, slot: app.slot, version: request.version, secretRevision: request.secretRevision });
  const finalReader = await replacementObserver(host, evidence.final);
  try {
    evidence.afterPublication = await finalReader.observe(); evidence.snapshot = selected(evidence.afterPublication);
    assert.equal(evidence.snapshot.length, 2); assert.ok(evidence.snapshot.every(row => row.outcome === 'pending' && row.finished_at === null && row.unblocked_at === null));
    assert.deepEqual(evidence.snapshot.map(row => row.id).sort(), evidence.heldRows.map(row => row.id).sort());
    evidence.swap = generationEvent(await logs(owner, time), 'generation_swap_out', generation, active.version); assert.ok(evidence.swap);
    assert.ok(evidence.swap.at >= evidence.publishRequestedAt && evidence.swap.at <= evidence.approvedAt && evidence.swap.at < time + 15000);
    assert.ok(evidence.snapshot.every(row => Math.abs(row.last_poll_at - evidence.swap.at) <= 300));
    await waitFailureTime(clock, evidence.maintenance.quietUntil);
    evidence.afterDeadline = await finalReader.observe(); assert.deepEqual(selected(evidence.afterDeadline), evidence.snapshot); evidence.quietObservedAt = await clock();
    evidence.freed = await waitFor('actual old generation release', async () => {
      const events = await Promise.all(evidence.held.replicas.map(async replica => {
        const event = generationEvent(await logs(replica.node, time), 'deployment_generation_freed', replica.state.deployment.generation, active.version);
        return event && { ...event, node: replica.node };
      })); return events.every(Boolean) && events;
    }, 35000);
    const freedOwner = evidence.freed.find(row => row.node === owner), maintenance = evidence.maintenance;
    assert.ok(evidence.freed.every(row => row.at >= evidence.swap.at && row.at <= evidence.approvedAt + maintenance.intervalMs + 2000));
    assert.equal(reapTick(maintenance.adoptedAt, evidence.swap.at, maintenance.intervalMs), maintenance.predictedTickAt);
    assert.ok(maintenance.predictedTickAt > evidence.quietObservedAt && freedOwner.at > evidence.quietObservedAt);
    assert.ok(freedOwner.at >= maintenance.predictedTickAt - 250 && freedOwner.at <= maintenance.predictedTickAt + 1500);
    evidence.afterFree = await finalReader.observe(); assert.deepEqual(selected(evidence.afterFree), evidence.snapshot);
    for (const observed of [evidence.afterPublication, evidence.afterDeadline, evidence.afterFree]) {
      for (const table of ['results', 'occurrences']) assert.deepEqual(observed[table].filter(row => row.scheduled_time === time), evidence.afterMigration[table].filter(row => row.scheduled_time === time));
    }
    assert.deepEqual(evidence.afterFree.bucket.owner, evidence.held.bucket.owner);
    assert.equal(evidence.afterFree.info.nextAlarm, time + 60000);
    assert.ok(evidence.afterFree.bucket.wakes.some(row => row.due_ms === time + 60000));
    return evidence.final;
  } finally { await finalReader.close(); }
}
