import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedRetry } from './retry-selection.mjs';

const scheduled = 120000;
function observed() {
  return { databases: [{ data: { cron_fault_attempts: [0, 4000, 12000].map(offset => ({ phase: 'retry-b', job: 'advisory', outcome: 'thrown', scheduled_time: scheduled, entered_at: scheduled + offset })) } }],
    status: { nextAlarm: scheduled + 28000 }, cronRecords: { at: scheduled + 14000, wakes: [{ due_ms: scheduled + 28000, identity: 'original-retry' }] } };
}
test('retry selection pins the original occurrence and its persisted wake', () => {
  const value = observed(), selected = selectedRetry(value, scheduled);
  assert.equal(selected.scheduledTime, scheduled); assert.deepEqual(selected.wake, { due_ms: scheduled + 28000, identity: 'original-retry' });
});
test('retry selection waits for three settled failures of that occurrence', () => {
  const value = observed(); value.databases[0].data.cron_fault_attempts[2].outcome = 'pending';
  assert.equal(selectedRetry(value, scheduled), false);
});
test('retry selection does not combine attempts from different occurrences', () => {
  const value = observed(); value.databases[0].data.cron_fault_attempts[0].scheduled_time = scheduled - 60000;
  assert.equal(selectedRetry(value, scheduled), false);
});
test('retry selection waits for a persisted wake rather than trusting status alone', () => {
  const value = observed(); value.cronRecords.wakes = [];
  assert.equal(Boolean(selectedRetry(value, scheduled)), false);
});
for (const [name, alter] of [
  ['a later occurrence', value => { value.databases[0].data.cron_fault_attempts.push({ phase: 'retry-b', job: 'advisory', outcome: 'thrown', scheduled_time: scheduled + 60000 }); }],
  ['a missed minute', value => { value.cronRecords.at = scheduled + 60000; }],
  ['an expired snapshot margin', value => { value.cronRecords.at = scheduled + 18000; }],
]) test(`retry selection refuses ${name} without switching occurrences`, () => {
  const value = observed(); alter(value);
  assert.throws(() => selectedRetry(value, scheduled), { code: 'FOGD_SELECTION_EXPIRED' });
});

test('retry selection refuses a later retry in the same occurrence', () => {
  const value = observed(); value.databases[0].data.cron_fault_attempts.push({ phase: 'retry-b', job: 'advisory', outcome: 'thrown', scheduled_time: scheduled });
  value.status.nextAlarm = scheduled + 59000; value.cronRecords.wakes = [{ due_ms: scheduled + 59000 }];
  assert.throws(() => selectedRetry(value, scheduled), { code: 'FOGD_SELECTION_EXPIRED' });
});
test('retry margin uses the clock after the observation has completed', () => {
  const value = observed();
  assert.throws(() => selectedRetry(value, scheduled, scheduled + 18000), { code: 'FOGD_SELECTION_EXPIRED' });
});
