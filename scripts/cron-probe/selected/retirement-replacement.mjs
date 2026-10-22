import assert from 'node:assert/strict';
import { approveImports } from './background-fixtures.mjs';
import { controllerState, nativeObservation } from './observations.mjs';
import { scopedClient } from './https.mjs';
import { rows } from './recovery-ledger.mjs';
import { expectRefusal } from './evidence.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { nativeProcesses } from './recovery-fence.mjs';

export async function retiredQueueReplacement(target, fixture, request, retiredArtifact, expectedKeys) {
  assert.equal(target.retiredApp, 'imports');
  const token = (await target.json(['admin', 'issue-token', 'replacement-builder', 'replacement'])).token;
  fixture.tokens.replacement = token;
  const active = await approveImports(target, token, 'replacement');
  assert.equal(active.slot, target.retirement.previous.slot);
  assert.equal(target.policy.fleets.find(fleet => fleet.id === active.slot).prefix, target.retirement.replacement.prefix);
  const paused = await target.json(['admin', 'delivery', 'replacement', 'pause']); assert.equal(paused.observed, 'paused');
  const fresh = await nativeObservation(target, active.slot, active.id, { captureProofs: true, persistedRecords: true });
  const keys = verifiedObservationKeys(target.policy, active.slot, fresh); assert.deepEqual(keys, expectedKeys);
  assert.deepEqual(await nativeProcesses(target), target.nativeBaseline);
  assert.deepEqual(rows(fresh, 'import_jobs'), []); assert.deepEqual(rows(fresh, 'import_results'), []);
  assert.equal(fresh.status.paused, true); assert.equal(fresh.status.backlogCount, 0); assert.deepEqual(fresh.queuePeek.messages, []);
  const body = await request(`/v1/deployments/${active.id}/artifact`); assert.equal(body.status, 200);
  const scoped = await scopedClient(target, fixture.tokens.imports), before = await controllerState(target);
  const outside = await scoped('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body.text });
  assert.equal(outside.status, 400); assert.match(outside.json().error, /outside its app scope/);
  const retired = await scoped('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(retiredArtifact) });
  assert.equal(retired.status, 400); assert.match(retired.json().error, /permanently retired/);
  const retiredCredential = await expectRefusal(target, ['admin', 'issue-token', 'retired-name-refusal', 'imports'], /permanently retired/);
  const retiredApproval = await expectRefusal(target, ['admin', 'approve', fixture.approvals.imports.id, fixture.approvals.imports.digest], /permanently retired/);
  const after = await controllerState(target); assert.deepEqual(after, before);
  return { active, fresh, keys, oldScope: outside.json(), retiredName: retired.json(), retiredCredential, retiredApproval };
}
