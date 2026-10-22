import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAutonomousDowntime } from './failure-downtime.mjs';

function evidence() {
  return { due: 180000, downAt: 170000, restartRequestedAt: 302000, replicasStartedAt: 304000, firstReadAt: 350000,
    autonomousWake: { authorityDeferred: true, startedAt: 340000, completedAt: 340500, bucket: { wakes: [{ due_ms: 360000, keyLastModifiedMs: 310000 }] } },
    firstRead: { authorityDeferred: true, ledger: 'available', startedAt: 350010, completedAt: 350100, rows: [
      { job: 'advisory', cron: '* * * * *', scheduled_time: 180000, entered_at: 320000, finished_at: 320010, outcome: 'success', no_retry_called: 0 },
      { job: 'inventory', cron: '* * * * *', scheduled_time: 180000, entered_at: 320020, finished_at: 320030, outcome: 'success', no_retry_called: 0 },
    ] } };
}
test('autonomous downtime evidence identifies completed overdue jobs and two skipped boundaries', () => {
  const result = assertAutonomousDowntime(evidence());
  assert.deepEqual(result.skipped, [240000, 300000]); assert.equal(result.futureDue, 360000);
  assert.deepEqual(result.overdue.map(row => [row.job, row.scheduled_time]), [['advisory', 180000], ['inventory', 180000]]);
});
for (const [name, alter] of [
  ['a quiet interval shorter than 45 seconds', value => { value.firstReadAt = 348999; }],
  ['work completed after the first native request', value => { value.firstRead.rows[0].finished_at = 350001; }],
  ['work entered before restart', value => { value.firstRead.rows[0].entered_at = 301999; }],
  ['a missing overdue job', value => { value.firstRead.rows.pop(); }],
  ['replayed intermediate ticks', value => { value.firstRead.rows.push({ ...value.firstRead.rows[0], scheduled_time: 240000 }); }],
  ['a wake too recent to precede the first request', value => { value.autonomousWake.bucket.wakes[0].keyLastModifiedMs = 349000; value.autonomousWake.startedAt = 349100; value.autonomousWake.completedAt = 349500; }],
  ['a wake persisted before restart', value => { value.autonomousWake.bucket.wakes[0].keyLastModifiedMs = 169000; }],
  ['an overdue wake instead of a future wake', value => { value.autonomousWake.bucket.wakes[0].due_ms = 180000; }],
  ['a string wake timestamp', value => { value.autonomousWake.bucket.wakes[0].keyLastModifiedMs = '310000'; }],
  ['an invocation recorded during downtime', value => { value.firstRead.rows.push({ ...value.firstRead.rows[0], scheduled_time: 120000, entered_at: 200000 }); }],
  ['noninteger VM timing', value => { value.firstReadAt = '350000'; }],
  ['an unavailable first ledger observation', value => { value.firstRead.ledger = 'unavailable'; value.firstRead.rows = null; }],
  ['a storage sample completed after the first request', value => { value.autonomousWake.completedAt = 350001; }],
]) test(`autonomous downtime evidence refuses ${name}`, () => {
  const value = evidence(); alter(value); assert.throws(() => assertAutonomousDowntime(value), { code: 'ERR_ASSERTION' });
});

test('autonomous downtime evidence records obsolete wake hints separately from fresh future work', () => {
  const value = evidence(); value.autonomousWake.bucket.wakes.push({ due_ms: 180000, keyLastModifiedMs: 169000 });
  const result = assertAutonomousDowntime(value); assert.equal(result.futureDue, 360000);
  assert.deepEqual(result.otherWakeHints, [{ due_ms: 180000, keyLastModifiedMs: 169000 }]);
});
test('autonomous downtime evidence refuses an off-grid retry deadline as the next natural occurrence', () => {
  const value = evidence(); value.autonomousWake.bucket.wakes[0].due_ms = 360001;
  assert.throws(() => assertAutonomousDowntime(value), { code: 'ERR_ASSERTION' });
});

test('autonomous downtime evidence refuses a future wake that skips the next natural minute', () => {
  const value = evidence(); value.autonomousWake.bucket.wakes[0].due_ms = 420000;
  assert.throws(() => assertAutonomousDowntime(value), { code: 'ERR_ASSERTION' });
});

test('autonomous downtime evidence selects the next minute even when a later hint is listed first', () => {
  const value = evidence(); value.autonomousWake.bucket.wakes.unshift({ due_ms: 420000, keyLastModifiedMs: 310000 });
  const result = assertAutonomousDowntime(value); assert.equal(result.futureDue, 360000);
  assert.deepEqual(result.otherWakeHints, [{ due_ms: 420000, keyLastModifiedMs: 310000 }]);
});
