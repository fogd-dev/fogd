import assert from 'node:assert/strict';
import { join } from 'node:path';
import { recoveryFixtures, importJob } from './recovery-fixtures.mjs';
import { nativeObservation, setFaultPolicy } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { normalSnapshot } from './recovery-snapshot.mjs';
import { armedTimer, resumeCron, futurePhase } from './recovery-work.mjs';
import { retirementTarget } from './retirement-target.mjs';
import { heldRetirement } from './retirement-holds.mjs';
import { rows, noReplay } from './recovery-ledger.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';

export async function retireOriginalQueue(context) {
  const { source, installations, evidence } = context;
  const fixture = await recoveryFixtures(source); source.nativeBaseline = await nativeProcesses(source);
  evidence.sourceIdentities = []; evidence.sourceKeys = {};
  for (const fleet of source.policy.fleets) {
    const observed = await nativeObservation(source, fleet.id, undefined, { captureProofs: true });
    evidence.sourceIdentities.push(observed); evidence.sourceKeys[fleet.id] = verifiedObservationKeys(source.policy, fleet.id, observed);
  }
  await source.command(['admin', 'delivery', 'imports', 'pause']); await importJob(fixture.request, 'retired-input', 'retained\nqueue');
  evidence.pendingInput = await nativeObservation(source, fixture.approvals.imports.slot, fixture.approvals.imports.id, { persistedRecords: true });
  assert.equal(rows(evidence.pendingInput, 'import_jobs').find(row => row.id === 'retired-input').status, 'accepted');
  assert.equal(evidence.pendingInput.queuePeek.messages.length, 1); assert.equal(evidence.pendingInput.queuePeek.messages[0].attempts, 0);
  evidence.resumed = await resumeCron(source, fixture.approvals.refresh); context.phase = 'source-healthy';
  evidence.sourceHealthy = await futurePhase(source, fixture.approvals.refresh, 'snapshot-a', evidence.resumed.requestedAt);
  context.phase = 'source-snapshot'; const armed = await armedTimer(source, fixture.approvals.refresh);
  const point = await normalSnapshot(source, fixture, join(source.output, 'source-snapshot'), armed.status.nextAlarm, installations); evidence.snapshot = point;
  context.phase = 'retirement-create';
  const target = await retirementTarget(source, point, fixture.approvals.imports, 'delivery', join(source.output, 'retired'), installations); installations.push(target);
  evidence.target = { project: target.project, policy: target.policy, plan: target.retirement, refusals: target.refusals, initialServices: target.initialServices, networks: target.networks };
  context.phase = 'cold-and-acknowledged-hold'; const held = await heldRetirement(target, point, installations); evidence.held = held.evidence;
  await setFaultPolicy(target, fixture.approvals.refresh.slot, fixture.approvals.refresh.id, 'healthy', 'after-a');
  evidence.survivorResume = await resumeCron(target, fixture.approvals.refresh); context.phase = 'survivor-future';
  evidence.survivorFuture = await futurePhase(target, fixture.approvals.refresh, 'after-a', evidence.survivorResume.requestedAt);
  noReplay(point.sourceObservation.refresh, evidence.survivorFuture, evidence.survivorResume.requestedAt - 1);
  return { fixture, point, target, held };
}
