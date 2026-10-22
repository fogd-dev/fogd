import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { controllerState } from './observations.mjs';
import { submitOffline, recordOfflineApproval } from './offline-fixtures.mjs';
import { assertMigrationOverlap } from './replacement-outcomes.mjs';
import { setRefreshSource } from './refresh-client.mjs';

export async function migrationOverlap({ host, fixture, active, reader, debuggerSession, checkpoint, evidence }) {
  const submitted = await submitOffline(host, fixture, 'new'); evidence.submitted = submitted;
  evidence.source = await setRefreshSource(host, fixture, 'healthy');
  evidence.armed = await reader.observe('arm-old');
  const armedAfter = evidence.armed.mutation[0].armed_after;
  evidence.resumed = await host.json(['admin', 'dispatch', 'refresh', 'resume', active.id, active.digest]);
  assert.equal(evidence.resumed.observed, 'running');
  evidence.held = await pollReplacement('old advisory hold', reader, observed => observed.attempts.some(row => row.release === 'old' && row.job === 'advisory' && row.scheduled_time > armedAfter && row.outcome === 'pending' && row.held_at && row.last_poll_at), 90000);
  const held = evidence.held.attempts.filter(row => row.release === 'old' && row.job === 'advisory' && row.scheduled_time > armedAfter && row.outcome === 'pending');
  assert.equal(held.length, 1); evidence.oldHeld = held[0];
  // Settle either CLI outcome immediately while the debugger holds the controller.
  let settled = false;
  const approving = host.command(['admin', 'approve', submitted.id, submitted.digest, active.secretRevision]).then(
    () => { settled = true; return { ok: true }; },
    error => { settled = true; return { ok: false, diagnosticFile: error.diagnosticFile }; },
  );
  evidence.checkpoint = await debuggerSession.paused(checkpoint, 15000);
  evidence.afterMigration = await reader.observe(); debuggerSession.assertPaused(evidence.checkpoint.pauseSequence);
  assert.equal(settled, false);
  assert.ok(evidence.afterMigration.migrations.some(row => row.name === '0003_compatible.sql'));
  const stillHeld = evidence.afterMigration.attempts.find(row => row.id === evidence.oldHeld.id);
  assert.ok(stillHeld && stillHeld.outcome === 'pending' && stillHeld.last_poll_at > evidence.oldHeld.last_poll_at);
  assert.ok(!evidence.afterMigration.results.some(row => row.job === 'advisory' && row.scheduled_time === evidence.oldHeld.scheduled_time));
  evidence.released = await reader.observe('release-old', { ...submitted, time: evidence.oldHeld.scheduled_time, attempt: evidence.oldHeld.id });
  evidence.completed = await pollReplacement('old callback commit under compatible schema', reader, observed =>
    observed.attempts.some(row => row.id === evidence.oldHeld.id && row.outcome === 'success') && ['advisory', 'inventory'].every(job =>
      observed.results.some(row => row.job === job && row.scheduled_time === evidence.oldHeld.scheduled_time) &&
      observed.occurrences.some(row => row.job === job && row.scheduled_time === evidence.oldHeld.scheduled_time && row.status === 'complete')), 5000);
  evidence.validation = assertMigrationOverlap(evidence);
  debuggerSession.assertPaused(evidence.checkpoint.pauseSequence);
  evidence.readyToPublishAt = evidence.completed.completedAt;
  await debuggerSession.remove(checkpoint); await debuggerSession.resume();
  evidence.controllerResumeReturnedAtHostMs = Date.now();
  evidence.approval = await approving; assert.equal(evidence.approval.ok, true);
  const paused = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(paused.observed, 'paused');
  const state = await controllerState(host), app = state.apps.refresh, request = state.deployments[submitted.id];
  assert.equal(app.active, submitted.id); assert.equal(request.status, 'active'); assert.equal(request.digest, submitted.digest);
  assert.equal(request.secretRevision, active.secretRevision); assert.equal(app.dispatch.hold, null); assert.equal(app.dispatch.operation, null);
  const updated = { ...submitted, slot: app.slot, version: request.version, secretRevision: request.secretRevision, initialPauseAt: Date.parse(paused.observedAt) };
  assert.ok(Number.isSafeInteger(updated.initialPauseAt));
  evidence.updated = await recordOfflineApproval(host, fixture, 'new', updated);
  return evidence.updated;
}

export async function pollReplacement(label, reader, accept, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const observed = await reader.observe();
    if (accept(observed)) return observed;
    await delay(100);
  }
  throw new Error(`Replacement observation did not complete: ${label}`);
}
