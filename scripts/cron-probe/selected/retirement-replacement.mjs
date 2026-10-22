import assert from 'node:assert/strict';
import { retiredAuthorityRefusals } from './retirement-authority.mjs';
import { approveImports } from './background-fixtures.mjs';
import { nativeObservation } from './observations.mjs';
import { rows } from './recovery-ledger.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { nativeProcesses } from './recovery-fence.mjs';

export async function retiredQueueReplacement(target, fixture, request, expectedKeys) {
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
  const authority = await retiredAuthorityRefusals(target, request, fixture.approvals.imports, fixture.tokens.imports, active);
  return { active, fresh, keys, ...authority };
}
