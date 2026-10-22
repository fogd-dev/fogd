import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRetainedInput, noReplay } from './recovery-ledger.mjs';

const observed = data => ({ databases: [{ database: 'db', data }] });
function queuedSnapshot() {
  const pending = { ...observed({ import_jobs: [{ id: 'pending-b', status: 'accepted', attempts: 0, input_hash: 'original', created_at: 10 }], import_results: [] }),
    queuePeek: { messages: [{ id: 'original-broker-id', bodyBase64: 'eyJpZCI6InBlbmRpbmctYiJ9', attempts: 0 }] } };
  const point = { sourceObservation: { imports: structuredClone(pending) }, queueMessages: structuredClone(pending.queuePeek.messages),
    manifest: { queueRecovery: { apps: { imports: { observation: { backlogCount: 1 } } } } } };
  return { pending, point };
}
test('recovery accepts the original unattempted pending input', () => {
  const { pending, point } = queuedSnapshot();
  assert.doesNotThrow(() => assertRetainedInput(point, pending));
});
for (const [scenario, mutate] of [
  ['consumed broker input', point => { point.queueMessages = []; }],
  ['resubmitted broker input', point => { point.queueMessages[0].id = 'resubmitted'; }],
  ['previously attempted input', point => { point.queueMessages[0].attempts = 1; }],
  ['already completed input', point => { point.sourceObservation.imports.databases[0].data.import_jobs[0].status = 'complete'; }],
  ['changed input hash', point => { point.sourceObservation.imports.databases[0].data.import_jobs[0].input_hash = 'changed'; }],
  ['empty native backlog', point => { point.manifest.queueRecovery.apps.imports.observation.backlogCount = 0; }],
  ['already committed result', point => { point.sourceObservation.imports.databases[0].data.import_results.push({ job_id: 'pending-b', position: 0, label: 'KIWI' }); }],
]) test(`recovery rejects ${scenario} in the selected snapshot`, () => {
  const { pending, point } = queuedSnapshot(); mutate(point);
  assert.throws(() => assertRetainedInput(point, pending), assert.AssertionError);
});
function priorCronWork() {
  return observed({ cron_fault_attempts: [{ job: 'advisory', scheduled_time: 100, outcome: 'thrown' }],
    refresh_occurrences: [{ job: 'inventory', scheduled_time: 100, attempts: 1 }], refresh_results: [] });
}
test('recovery accepts future business work without changing old occurrences', () => {
  const before = priorCronWork(), after = structuredClone(before);
  after.databases[0].data.refresh_results.push({ job: 'inventory', scheduled_time: 300, value: 'future' });
  assert.doesNotThrow(() => noReplay(before, after, 200));
});
for (const [scenario, mutate] of [
  ['another old callback', data => { data.cron_fault_attempts.push({ job: 'inventory', scheduled_time: 100, outcome: 'success' }); }],
  ['an old sibling occurrence', data => { data.refresh_occurrences.push({ job: 'advisory', scheduled_time: 100, attempts: 1 }); }],
  ['an old business result', data => { data.refresh_results.push({ job: 'advisory', scheduled_time: 100, value: 'replayed' }); }],
  ['a changed old attempt count', data => { data.refresh_occurrences[0].attempts++; }],
]) test(`recovery rejects ${scenario} after explicit resume`, () => {
  const before = priorCronWork(), after = structuredClone(before); mutate(after.databases[0].data);
  assert.throws(() => noReplay(before, after, 200), assert.AssertionError);
});
