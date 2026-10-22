import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMigrationOverlap } from './replacement-outcomes.mjs';

function fixture() {
  const held = { id: 'old-advisory', release: 'old', job: 'advisory', cron: '* * * * *', scheduled_time: 60000, entered_at: 60010, instance: 'original', held_at: 60020,
    last_poll_at: 60030, outcome: 'pending', finished_at: null, result_saved_at: null, unblocked_at: null };
  return {
    oldHeld: held,
    afterMigration: { startedAt: 61000, completedAt: 61100, info: { paused: true, nextAlarm: null }, migrations: [{ name: '0003_compatible.sql' }], attempts: [{ ...held, last_poll_at: 61090 }], results: [] },
    released: { startedAt: 61200, completedAt: 61300 },
    completed: { startedAt: 61400, completedAt: 61500, attempts: [{ ...held, last_poll_at: 61210, unblocked_at: 61220, result_saved_at: 61230, finished_at: 61240, outcome: 'success' }],
      results: [{ job: 'advisory', cron: '* * * * *', scheduled_time: 60000, saved_at: 61230, compatibility_marker: 'compatible' }] },
  };
}
test('migration overlap accepts old work released after observed migration and committed before publication', () => {
  assert.deepEqual(assertMigrationOverlap(fixture()), { scheduledTime: 60000, completionAfterScheduledMs: 1240, resultSavedAt: 61230 });
});
for (const [name, alter] of [
  ['missing migration', value => { value.afterMigration.migrations = []; }],
  ['unconfirmed pause', value => { value.afterMigration.info.paused = false; }],
  ['an armed alarm', value => { value.afterMigration.info.nextAlarm = 120000; }],
  ['a callback already committed before migration', value => { value.afterMigration.results = value.completed.results; }],
  ['a completed callback at the held checkpoint', value => { value.afterMigration.attempts[0].outcome = 'success'; }],
  ['a different original occurrence', value => { value.completed.attempts[0].scheduled_time = 120000; }],
  ['a new-code callback replacing the old callback', value => { value.completed.attempts[0].release = 'new'; }],
  ['a different isolate', value => { value.completed.attempts[0].instance = 'replacement'; }],
  ['a second callback for the held occurrence', value => { value.completed.attempts.push({ ...value.completed.attempts[0], id: 'extra' }); }],
  ['a callback released before the operator action', value => { value.completed.attempts[0].unblocked_at = 61199; }],
  ['missing completion time', value => { value.completed.attempts[0].finished_at = null; }],
  ['a completion after the operation deadline', value => { value.completed.attempts[0].finished_at = 75000; value.completed.completedAt = 75001; }],
  ['a completion after publication can be released', value => { value.completed.attempts[0].finished_at = 61501; }],
  ['duplicate business results', value => { value.completed.results.push({ ...value.completed.results[0] }); }],
  ['a result missing the compatible column', value => { delete value.completed.results[0].compatibility_marker; }],
  ['a result timestamp differing from the attempt', value => { value.completed.results[0].saved_at++; }],
  ['a stale held heartbeat', value => { value.afterMigration.attempts[0].last_poll_at = 60029; }],
  ['an unchanged held heartbeat', value => { value.afterMigration.attempts[0].last_poll_at = 60030; }],
  ['a heartbeat after its observation', value => { value.afterMigration.attempts[0].last_poll_at = 61101; }],
  ['a throw after saving a result', value => { value.completed.attempts[0].outcome = 'thrown'; }],
  ['a result saved before release', value => { value.completed.attempts[0].result_saved_at = 61219; value.completed.results[0].saved_at = 61219; }],
  ['a completion before the result commit', value => { value.completed.attempts[0].finished_at = 61229; }],
  ['a heartbeat after unblocking', value => { value.completed.attempts[0].last_poll_at = 61221; }],
  ['a migration observation predating the held heartbeat', value => { value.afterMigration.startedAt = 60029; }],
  ['release starting before the migration observation finishes', value => { value.released.startedAt = 61099; }],
  ['completion observed before release observation finishes', value => { value.completed.startedAt = 61299; }],
  ['a non-minute occurrence', value => { value.oldHeld.scheduled_time = 60001; }],
  ['a different held release', value => { value.oldHeld.release = 'new'; }],
  ['a different held job', value => { value.oldHeld.job = 'inventory'; }],
  ['a different held expression', value => { value.oldHeld.cron = '*/3 * * * *'; }],
]) test(`migration overlap refuses ${name}`, () => {
  const value = fixture(); alter(value); assert.throws(() => assertMigrationOverlap(value), { code: 'ERR_ASSERTION' });
});
