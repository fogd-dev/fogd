import assert from 'node:assert/strict';

const identity = ['id', 'release', 'job', 'cron', 'scheduled_time', 'entered_at', 'instance', 'held_at'];
const timestamp = value => assert.ok(Number.isSafeInteger(value) && value > 0, 'Missing replacement timestamp');

export function assertMigrationOverlap({ oldHeld, afterMigration, released, completed }) {
  // These processes share the selected Docker host clock. The driver checks its
  // native 15-second default; the result's default column alone proves no ordering.
  for (const value of [oldHeld.scheduled_time, oldHeld.entered_at, oldHeld.held_at, oldHeld.last_poll_at,
    afterMigration.startedAt, afterMigration.completedAt, released.startedAt, released.completedAt, completed.startedAt, completed.completedAt]) timestamp(value);
  assert.equal(oldHeld.release, 'old'); assert.equal(oldHeld.job, 'advisory'); assert.equal(oldHeld.cron, '* * * * *');
  assert.equal(oldHeld.scheduled_time % 60000, 0); assert.equal(oldHeld.outcome, 'pending');
  assert.equal(oldHeld.finished_at, null); assert.equal(oldHeld.result_saved_at, null); assert.equal(oldHeld.unblocked_at, null);
  assert.ok(oldHeld.entered_at >= oldHeld.scheduled_time && oldHeld.held_at >= oldHeld.entered_at && oldHeld.last_poll_at >= oldHeld.held_at);
  assert.ok(afterMigration.startedAt >= oldHeld.last_poll_at && afterMigration.completedAt >= afterMigration.startedAt);
  assert.ok(released.startedAt >= afterMigration.completedAt && released.completedAt >= released.startedAt);
  assert.ok(completed.startedAt >= released.completedAt && completed.completedAt >= completed.startedAt);
  assert.equal(afterMigration.info.paused, true); assert.equal(afterMigration.info.nextAlarm, null);
  assert.ok(afterMigration.migrations.some(row => row.name === '0003_compatible.sql'));
  const held = afterMigration.attempts.filter(row => row.id === oldHeld.id), done = completed.attempts.filter(row => row.id === oldHeld.id);
  assert.equal(held.length, 1); assert.equal(done.length, 1);
  for (const key of identity) { assert.equal(held[0][key], oldHeld[key]); assert.equal(done[0][key], oldHeld[key]); }
  assert.equal(held[0].outcome, 'pending'); assert.equal(held[0].finished_at, null); assert.equal(held[0].unblocked_at, null); assert.equal(held[0].result_saved_at, null);
  timestamp(held[0].last_poll_at); assert.ok(held[0].last_poll_at > oldHeld.last_poll_at && held[0].last_poll_at <= afterMigration.completedAt);
  const selected = rows => rows.filter(row => row.job === oldHeld.job && row.scheduled_time === oldHeld.scheduled_time);
  assert.deepEqual(selected(afterMigration.attempts), held); assert.deepEqual(selected(completed.attempts), done);
  assert.deepEqual(selected(afterMigration.results), []);
  for (const key of ['unblocked_at', 'result_saved_at', 'finished_at', 'last_poll_at']) timestamp(done[0][key]);
  assert.equal(done[0].outcome, 'success');
  assert.ok(done[0].last_poll_at >= held[0].last_poll_at && done[0].last_poll_at <= done[0].unblocked_at);
  assert.ok(done[0].unblocked_at >= released.startedAt && done[0].result_saved_at >= done[0].unblocked_at);
  assert.ok(done[0].finished_at >= done[0].result_saved_at && done[0].finished_at <= completed.completedAt);
  assert.ok(done[0].finished_at - oldHeld.scheduled_time < 15000, 'Migration overlap exceeded the native operation deadline');
  const results = selected(completed.results); assert.equal(results.length, 1);
  assert.equal(results[0].compatibility_marker, 'compatible'); assert.equal(results[0].cron, oldHeld.cron); assert.equal(results[0].saved_at, done[0].result_saved_at);
  return { scheduledTime: oldHeld.scheduled_time, completionAfterScheduledMs: done[0].finished_at - oldHeld.scheduled_time, resultSavedAt: results[0].saved_at };
}
