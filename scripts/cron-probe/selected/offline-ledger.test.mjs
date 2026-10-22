import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOfflineLedger } from './offline-ledger.mjs';

const selected = { phase: 'offline-sparse', resume: { requestedAt: 120000 } };
function observation(cron, time, phase) {
  const jobs = ['advisory', 'inventory'], data = {};
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) data[table] = jobs.map(job => ({ job, cron, scheduled_time: time,
    ...(table === 'cron_fault_attempts' ? { phase, outcome: 'success' } : {}) }));
  return { databases: [{ data }] };
}
function fixture() {
  const before = observation('* * * * *', 60000, 'offline-minute'), after = observation('*/3 * * * *', 180000, 'offline-sparse');
  for (const table of Object.keys(before.databases[0].data)) after.databases[0].data[table].unshift(...structuredClone(before.databases[0].data[table]));
  return { before, after };
}
test('offline schedule update accepts complete new-grid pairs while retaining old data', () => {
  const { before, after } = fixture(); assert.doesNotThrow(() => assertOfflineLedger(after, selected, '*/3 * * * *', before));
});
for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) {
  for (const time of [null, '180000']) test(`offline evidence refuses noninteger scheduled time ${JSON.stringify(time)} in ${table}`, () => {
    const { before, after } = fixture(); after.databases[0].data[table][2].scheduled_time = time; after.databases[0].data[table][3].scheduled_time = time;
    assert.throws(() => assertOfflineLedger(after, selected, '*/3 * * * *', before));
  });
  test(`offline evidence refuses a duplicate job identity in ${table}`, () => {
    const { before, after } = fixture(); after.databases[0].data[table][2].job = 'inventory';
    assert.throws(() => assertOfflineLedger(after, selected, '*/3 * * * *', before));
  });
  test(`offline evidence refuses additional superseded-release work in ${table}`, () => {
    const { before, after } = fixture(); after.databases[0].data[table].push({ ...before.databases[0].data[table][0], scheduled_time: 240000 });
    assert.throws(() => assertOfflineLedger(after, selected, '*/3 * * * *', before));
  });
}
test('offline evidence refuses a new scheduled attempt tagged with the superseded phase', () => {
  const { before, after } = fixture(); after.databases[0].data.cron_fault_attempts[2].phase = 'offline-minute';
  assert.throws(() => assertOfflineLedger(after, selected, '*/3 * * * *', before));
});
for (const table of ['refresh_occurrences', 'refresh_results']) {
  test(`offline evidence refuses new business rows on the wrong grid in ${table}`, () => {
    const { before, after } = fixture(); after.databases[0].data[table][2].scheduled_time = 240000;
    assert.throws(() => assertOfflineLedger(after, selected, '*/3 * * * *', before));
  });
  test(`offline evidence refuses an incomplete job pair in ${table}`, () => {
    const { before, after } = fixture(); after.databases[0].data[table].pop();
    assert.throws(() => assertOfflineLedger(after, selected, '*/3 * * * *', before));
  });
}
