import assert from 'node:assert/strict';
import { join } from 'node:path';
import { selectedTrial } from './selected-trial.mjs';
import { firstRetirement } from './retirement-first.mjs';
import { retireStep, queuedInput, completeQueuedInput, retainedHistory, fleetProofs, preserveSnapshots } from './retirement-steps.mjs';
import { scheduledReplacement, assertNewSchedule } from './retirement-scheduled.mjs';
import { setFaultPolicy } from './observations.mjs';
import { resumeCron, pendingRetry, futurePhase, armedTimer } from './recovery-work.mjs';
import { backgroundSnapshot } from './recovery-snapshot.mjs';
import { auditSnapshot } from './retirement-audit.mjs';
import { rows } from './recovery-ledger.mjs';
import { scanPublicSurfaces } from './privacy.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/retirement-chain.mjs NEW_PRIVATE_OUTPUT');
await selectedTrial(process.argv[2], 'Selected sequential retirement: active cron survivor, persisted cron retry, queued survivors, fresh scheduled capacity and zero-live recovery. Separate two-cron qualification and the full acceptance audit remain open; public admission stays closed.', async context => {
  const { source, installations, evidence } = context;
  const a = await firstRetirement(context), { fixture } = a;
  const snapshots = [{ host: source, point: a.point }], refresh = fixture.approvals.refresh, replacement = evidence.replacement.active;
  context.phase = 'pending-retry-selection';
  evidence.pendingB = await queuedInput(a.target, a.held.request, replacement, 'pending-b', 'kiwi\nlime', ['KIWI', 'LIME']);
  evidence.retainedA = await retainedHistory(a.target, evidence.held.retainedAfter, evidence.held.privateFilesAfter);
  await a.target.command(['admin', 'dispatch', refresh.app, 'pause']);
  await setFaultPolicy(a.target, refresh.slot, refresh.id, 'terminal', 'retry-b');
  const proofs = await fleetProofs(a.target);
  evidence.retryResume = await resumeCron(a.target, refresh); evidence.pendingRetry = await pendingRetry(a.target, refresh, evidence.retryResume.requestedAt);
  const retryRows = rows(evidence.pendingRetry.observed, 'cron_fault_attempts').filter(row => row.phase === 'retry-b');
  assert.ok(retryRows.length > 0 && retryRows.every(row => row.scheduled_time >= evidence.retryResume.requestedAt));
  const b = await retireStep(context, a.target, { refresh, replacement }, 'refresh', 'dispatch', 'retry', [{ app: 'refresh', due: evidence.pendingRetry.wake.due_ms }], evidence.held, proofs);
  snapshots.push({ host: a.target, point: b.point });
  evidence.completedB = await completeQueuedInput(b.target, replacement, evidence.pendingB);
  context.phase = 'scheduled-replacement';
  evidence.scheduledReplacement = await scheduledReplacement(b.target, fixture, b.held.request, b.record.held.warmKeys);
  const scheduled = evidence.scheduledReplacement.active;
  evidence.retainedB = await retainedHistory(b.target, b.record.held.retainedAfter, b.record.held.privateFilesAfter);
  await setFaultPolicy(b.target, scheduled.slot, scheduled.id, 'healthy', 'after-b', scheduled.app);
  evidence.scheduledResume = await resumeCron(b.target, scheduled);
  evidence.scheduledFuture = await futurePhase(b.target, scheduled, 'after-b', evidence.scheduledResume.requestedAt, 240000);
  assertNewSchedule(evidence.scheduledFuture, evidence.scheduledResume.requestedAt);
  evidence.pendingC = await queuedInput(b.target, b.held.request, replacement, 'pending-c', 'melon\nplum', ['MELON', 'PLUM']);
  const cProofs = await fleetProofs(b.target), armed = await armedTimer(b.target, scheduled);
  assert.equal(armed.status.nextAlarm % 180000, 0);
  const c = await retireStep(context, b.target, { [scheduled.app]: scheduled, replacement }, scheduled.app, 'dispatch', 'scheduled', [{ app: scheduled.app, due: armed.status.nextAlarm }], b.record.held, cProofs);
  snapshots.push({ host: b.target, point: c.point });
  assertNewSchedule(c.point.sourceObservation[scheduled.app], evidence.scheduledResume.requestedAt);
  evidence.completedC = await completeQueuedInput(c.target, replacement, evidence.pendingC);
  evidence.pendingD = await queuedInput(c.target, c.held.request, replacement, 'pending-d', 'retained\nlast', ['RETAINED', 'LAST']);
  evidence.retainedC = await retainedHistory(c.target, c.record.held.retainedAfter, c.record.held.privateFilesAfter);
  const d = await retireStep(context, c.target, { replacement }, replacement.app, 'delivery', 'last-queue', [], c.record.held);
  snapshots.push({ host: c.target, point: d.point });
  assert.deepEqual(d.record.held.approvals, {}); assert.deepEqual(d.record.held.surfaces, {});
  evidence.zeroProofs = await fleetProofs(d.target, true);
  for (const [app, active] of Object.entries({ ...fixture.approvals, replacement, [scheduled.app]: scheduled })) {
    evidence.privacy.push(await scanPublicSurfaces(d.target, d.held.request, [active], fixture.tokens[app], [fixture.secret, ...fixture.secrets], evidence));
  }
  context.phase = 'zero-live-snapshot';
  const zeroPoint = await backgroundSnapshot(d.target, {}, join(source.output, 'zero-live-snapshot'), [], installations);
  snapshots.push({ host: d.target, point: zeroPoint }); evidence.zeroPoint = zeroPoint;
  assert.deepEqual(Object.keys(zeroPoint.retiredHistory).sort(), ['imports', 'refresh', 'replacement', 'scheduled-next']);
  for (const stage of [{ plan: evidence.target.plan }, ...evidence.chain]) {
    const retired = zeroPoint.retiredHistory[stage.plan.app];
    for (const [key, value] of Object.entries(stage.plan)) assert.deepEqual(retired[key], value);
  }
  assert.equal(zeroPoint.manifest.cronRecovery, undefined); assert.equal(zeroPoint.manifest.queueRecovery, undefined);
  evidence.zeroAudit = await auditSnapshot(context, d.target, zeroPoint, 'zero-live-audit', d.record.held.retainedAfter);
  evidence.retryAudit = await auditSnapshot(context, a.target, b.point, 'retry-source-audit', evidence.held.retainedAfter);
  evidence.originalAudit = await auditSnapshot(context, source, a.point, 'original-source-audit');
  // All earlier installations are stopped before any audit target starts.
  evidence.snapshotsPreserved = await preserveSnapshots(snapshots);
  evidence.shutdowns = installations.map(host => ({ project: host.project, closed: host.closed }));
  assert.ok(evidence.shutdowns.every(host => host.closed));
  return fixture;
});
