import assert from 'node:assert/strict';
import { join } from 'node:path';
import { recoveryFixtures, importJob } from './recovery-fixtures.mjs';
import { nativeObservation, setFaultPolicy } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { normalSnapshot } from './recovery-snapshot.mjs';
import { armedTimer, resumeCron, futurePhase } from './recovery-work.mjs';
import { retirementTarget } from './retirement-target.mjs';
import { heldRetirement } from './retirement-holds.mjs';
import { retiredQueueReplacement } from './retirement-replacement.mjs';
import { rows, noReplay } from './recovery-ledger.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { prefixFingerprints } from '../../queue-probe/prefix-fingerprints.mjs';
import { assertControllerFiles } from '../retirement/preservation.mjs';
import { waitFor } from './https.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';

export async function firstRetirement(context) {
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
  const originalArtifact = await fixture.request(`/v1/deployments/${fixture.approvals.imports.id}/artifact`); assert.equal(originalArtifact.status, 200);
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
  context.phase = 'fresh-queue-capacity';
  evidence.replacement = await retiredQueueReplacement(target, fixture, held.request, originalArtifact.json(), evidence.held.warmKeys[target.retirement.previous.slot]);
  const replacement = evidence.replacement.active; await importJob(held.request, 'fresh-input', 'melon\nplum', 'replacement');
  await target.command(['admin', 'delivery', 'replacement', 'resume', replacement.id, replacement.digest]);
  evidence.freshImport = await waitFor('new namespace input completes', async () => {
    const observed = await nativeObservation(target, replacement.slot, replacement.id, { persistedRecords: true, captureProofs: true });
    return rows(observed, 'import_jobs').some(row => row.id === 'fresh-input' && row.status === 'complete') && rows(observed, 'import_results').filter(row => row.job_id === 'fresh-input').length === 2 && observed.queuePeek.messages.length === 0 && observed;
  });
  evidence.freshImportKeys = verifiedObservationKeys(target.policy, replacement.slot, evidence.freshImport);
  assert.deepEqual(evidence.freshImportKeys, evidence.held.warmKeys[replacement.slot]);
  assert.deepEqual(rows(evidence.freshImport, 'import_results').map(row => row.label), ['MELON', 'PLUM']);
  evidence.retainedAfterReuse = await prefixFingerprints(target.compose, target.retirement.previous.prefix, true);
  assert.deepEqual(evidence.retainedAfterReuse, evidence.held.retainedBefore.imports.objects);
  await assertControllerFiles({ identity: { image: target.entry.image }, config: target.config }, evidence.held.privateFilesBefore);
  evidence.privacy = [];
  for (const app of ['refresh', 'imports']) evidence.privacy.push(await scanPublicSurfaces(target, held.request, [fixture.approvals[app]], fixture.tokens[app], [fixture.secret], evidence));
  evidence.privacy.push(await scanPublicSurfaces(target, held.request, [replacement], fixture.tokens.replacement, [fixture.secret], evidence));
  return { fixture, point, target, held };
}
