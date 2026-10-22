import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshCron } from './retirement-cron-state.mjs';

function fresh() {
  return { status: { paused: true, nextAlarm: null }, cronRecords: { wakes: [] }, databases: [{ data: {
    cron_fault_attempts: [], refresh_occurrences: [], refresh_results: [],
    refresh_settings: [{ id: 1, mode: 'retry-once' }], cron_fault_control: [{ id: 1, policy: 'healthy', phase: 'startup' }],
  } }] };
}
test('fresh scheduled evidence is accepted without altering its retained observation', () => {
  const value = fresh(), before = structuredClone(value);
  assertFreshCron(value);
  assert.deepEqual(value, before);
});
for (const [name, change] of [
  ['running dispatch', value => { value.status.paused = false; }],
  ['an inherited alarm', value => { value.status.nextAlarm = 1000; }],
  ['an inherited wake', value => { value.cronRecords.wakes.push({ due_ms: 1000 }); }],
  ['a missing database', value => { value.databases = []; }],
  ['a second database', value => { value.databases.push(structuredClone(value.databases[0])); }],
  ['a missing ledger table', value => { delete value.databases[0].data.refresh_occurrences; }],
  ['a retained business result', value => { value.databases[0].data.refresh_results.push({ job: 'inventory', scheduled_time: 1000 }); }],
  ['an inherited source mode', value => { value.databases[0].data.refresh_settings[0].mode = 'healthy'; }],
  ['an inherited failure policy', value => { value.databases[0].data.cron_fault_control[0].policy = 'terminal'; }],
  ['an inherited phase', value => { value.databases[0].data.cron_fault_control[0].phase = 'retry-b'; }],
]) test(`fresh scheduled capacity refuses ${name}`, () => {
  const value = fresh(); change(value); assert.throws(() => assertFreshCron(value), { code: 'ERR_ASSERTION' });
});
