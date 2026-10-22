import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { selectedTrial } from './selected-trial.mjs';
import { retireOriginalQueue } from './retirement-start.mjs';
import { secondCron } from './retirement-second-cron.mjs';
import { prefixFingerprints } from '../../queue-probe/prefix-fingerprints.mjs';
import { assertUnassignedNamespace } from './retirement-policy.mjs';
import { rows } from './recovery-ledger.mjs';
import { retiredAuthorityRefusals } from './retirement-authority.mjs';
import { setFaultPolicy, nativeObservation, vmTime } from './observations.mjs';
import { fleetProofs, retainedHistory, preserveSnapshots } from './retirement-steps.mjs';
import { backgroundSnapshot } from './recovery-snapshot.mjs';
import { resumeCron, futurePhase } from './recovery-work.mjs';
import { retirementTarget } from './retirement-target.mjs';
import { heldRetirement } from './retirement-holds.mjs';
import { noReplay } from './recovery-ledger.mjs';
import { auditSnapshot } from './retirement-audit.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { waitFor } from './https.mjs';
import { expectRefusal } from './evidence.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/retirement-dual.mjs NEW_PRIVATE_OUTPUT');
await selectedTrial(process.argv[2], 'Selected retirement beside another live cron with retained queue history and held source restoration. Complete M11c acceptance and public admission remain open.', async context => {
  const { source, installations, evidence } = context;
  const first = await retireOriginalQueue(context), { fixture } = first, host = first.target;
  const firstResumeAt = evidence.survivorResume.requestedAt, original = fixture.approvals.refresh;
  context.phase = 'second-cron-approval'; const survivor = await secondCron(host, fixture, first.held, evidence);
  evidence.dualSourceProofs = await fleetProofs(host); evidence.resumedBoth = {}; evidence.futureBoth = {};
  context.phase = 'both-source-schedules';
  for (const active of [original, survivor]) {
    await host.command(['admin', 'dispatch', active.app, 'pause']);
    await setFaultPolicy(host, active.slot, active.id, 'healthy', active.app === 'refresh' ? 'snapshot-a' : 'older-a', active.app);
    evidence.resumedBoth[active.app] = await resumeCron(host, active);
  }
  for (const active of [original, survivor]) evidence.futureBoth[active.app] = await futurePhase(host, active, active.app === 'refresh' ? 'snapshot-a' : 'older-a', evidence.resumedBoth[active.app].requestedAt);
  evidence.retainedBeforeDual = await retainedHistory(host, evidence.held.retainedAfter, evidence.held.privateFilesAfter);
  evidence.sharedAlarm = await armedTogether(host, [original, survivor]); context.phase = 'shared-deadline-snapshot';
  const alarms = [original, survivor].map(active => ({ app: active.app, due: evidence.sharedAlarm.due }));
  const point = await backgroundSnapshot(host, { refresh: original, 'scheduled-next': survivor }, join(source.output, 'shared-snapshot'), alarms, installations); evidence.dualSnapshot = point;
  noReplay(first.point.sourceObservation.refresh, point.sourceObservation.refresh, firstResumeAt - 1);
  const target = await retirementTarget(host, point, original, 'dispatch', join(source.output, 'dual-retired'), installations); installations.push(target);
  evidence.dualTarget = { project: target.project, policy: target.policy, plan: target.retirement, refusals: target.refusals, initialServices: target.initialServices };
  context.phase = 'held-second-cron'; const held = await heldRetirement(target, point, installations); evidence.dualHeld = held.evidence;
  assert.deepEqual(evidence.dualHeld.retainedBefore.imports, evidence.held.retainedAfter.imports);
  assert.deepEqual(Object.keys(evidence.dualHeld.approvals), [survivor.app]); assert.ok(evidence.dualHeld.coldEnd >= evidence.sharedAlarm.due + 2000);
  evidence.retiredCronAuthority = await retiredAuthorityRefusals(target, held.request, original, fixture.tokens.refresh, survivor);
  evidence.retiredCronResume = await expectRefusal(target, ['admin', 'dispatch', original.app, 'resume', original.id, original.digest], /App has no scheduled dispatch journal/);
  await setFaultPolicy(target, survivor.slot, survivor.id, 'healthy', 'after-b', survivor.app);
  evidence.dualResume = await resumeCron(target, survivor); context.phase = 'survivor-future-and-quiet';
  evidence.dualFuture = await futurePhase(target, survivor, 'after-b', evidence.dualResume.requestedAt);
  evidence.quietStartedAt = await vmTime(target);
  while (await vmTime(target) < evidence.quietStartedAt + 125000) {
    const observed = await nativeObservation(target, survivor.slot, survivor.id, { persistedRecords: true });
    noReplay(point.sourceObservation[survivor.app], observed, evidence.dualResume.requestedAt - 1);
    assert.ok(observed.cronRecords.wakes.every(wake => wake.due_ms > evidence.dualResume.requestedAt)); await delay(10000);
  }
  evidence.dualAfterQuiet = await nativeObservation(target, survivor.slot, survivor.id, { persistedRecords: true });
  noReplay(point.sourceObservation[survivor.app], evidence.dualAfterQuiet, evidence.dualResume.requestedAt - 1);
  assert.ok(evidence.dualAfterQuiet.cronRecords.wakes.every(wake => wake.due_ms > evidence.dualResume.requestedAt)); evidence.quietEndedAt = await vmTime(target);
  const attempts = rows(evidence.dualAfterQuiet, 'cron_fault_attempts');
  for (const job of ['inventory', 'advisory']) assert.ok(new Set(attempts.filter(row => row.job === job && row.phase === 'after-b' && row.outcome === 'success' && row.scheduled_time > evidence.dualResume.requestedAt).map(row => row.scheduled_time)).size >= 2);
  const freedFleet = target.policy.fleets.find(fleet => fleet.id === target.retirement.previous.slot);
  evidence.unassignedAfterResume = await prefixFingerprints(target.compose, freedFleet.prefix, true); assertUnassignedNamespace(evidence.unassignedAfterResume, freedFleet);
  evidence.retainedAfterResume = await retainedHistory(target, evidence.dualHeld.retainedAfter, evidence.dualHeld.privateFilesAfter);
  evidence.privacy = [];
  for (const active of [original, survivor, fixture.approvals.imports]) evidence.privacy.push(await scanPublicSurfaces(target, held.request, [active], fixture.tokens[active.app], [fixture.secret, ...fixture.secrets], evidence));
  evidence.targetShutdown = await stopSelectedHost(target); target.closed = true;
  evidence.dualAudit = await auditSnapshot(context, host, point, 'dual-source-audit', evidence.held.retainedAfter);
  evidence.originalAudit = await auditSnapshot(context, source, first.point, 'original-source-audit');
  evidence.snapshotsPreserved = await preserveSnapshots([{ host: source, point: first.point }, { host, point }]);
  evidence.shutdowns = installations.map(host => ({ project: host.project, closed: host.closed })); assert.ok(evidence.shutdowns.every(host => host.closed));
  return fixture;
});

async function armedTogether(host, approvals) {
  return waitFor('two current minute alarms with one shared backup margin', async () => {
    const observed = {};
    for (const active of approvals) observed[active.app] = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const selectedAt = await vmTime(host), values = Object.values(observed).map(value => value.status), due = values[0].nextAlarm;
    return Object.values(observed).every(value => rows(value, 'cron_fault_attempts').every(row => row.outcome !== 'pending')) && values.every(value => value.paused === false && value.nextAlarm === due && due - selectedAt > 30000 && due - selectedAt <= 60000) && due % 60000 === 0 && { observed, selectedAt, due };
  }, 150000);
}
