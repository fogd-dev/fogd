import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { d1Fixture } from '../../test-d1.mjs';
import { beginScheduledRefresh } from '../../../examples/refresh/lib/refresh.mjs';
import { replacementJob } from './job.mjs';
const event = { cron: '* * * * *', scheduledTime: 60000 };
function fixture(t) {
  const f = d1Fixture(new URL('../../../examples/refresh/db/migrations/0001_refresh.sql', import.meta.url));
  f.sql.exec(readFileSync(new URL('./0002_replacement.sql', import.meta.url), 'utf8'));
  f.sql.exec("UPDATE refresh_settings SET mode = 'healthy'"); t.after(f.close);
  return { ...f, run: (release, job, selected = event) => replacementJob(release, job, selected, { DB: f.db, REFRESH_TOKEN: 'test-token' }, beginScheduledRefresh),
    attempts: () => f.sql.prepare('SELECT * FROM cron_replacement_attempts ORDER BY rowid').all() };
}

test('old advisory remains held without a business result, then finishes after explicit release', async t => {
  const f = fixture(t); f.sql.exec('UPDATE cron_replacement_control SET armed_after = 0');
  const running = f.run('old', 'advisory');
  try {
    const until = Date.now() + 3000;
    while (!f.attempts()[0]?.held_at && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const held = f.attempts()[0]; assert.ok(held.held_at); assert.equal(held.outcome, 'pending');
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 0);
  } finally { f.sql.exec('UPDATE cron_replacement_control SET released = 1'); await running; }
  const done = f.attempts()[0]; assert.equal(done.outcome, 'success');
  assert.ok(done.unblocked_at >= done.held_at && done.finished_at >= done.unblocked_at);
  assert.ok(done.result_saved_at >= done.unblocked_at);
});

test('new release does not inherit the old callback hold', async t => {
  const f = fixture(t); await f.run('new', 'advisory');
  const row = f.attempts()[0]; assert.equal(row.release, 'new'); assert.equal(row.held_at, null); assert.equal(row.outcome, 'success');
  assert.equal(f.sql.prepare('SELECT held_time FROM cron_replacement_control').get().held_time, null);
});

test('a lost reply records a saved result and the retry preserves one business row', async t => {
  const f = fixture(t); f.sql.exec("UPDATE refresh_settings SET mode = 'lost-ack-once'");
  await assert.rejects(f.run('new', 'advisory'), /reply was lost/); await f.run('new', 'advisory');
  const rows = f.attempts(); assert.deepEqual(rows.map(r => r.outcome), ['thrown', 'success']);
  assert.ok(rows.every(r => r.scheduled_time === event.scheduledTime && r.result_saved_at !== null));
  assert.equal(rows[0].result_saved_at, rows[1].result_saved_at); assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 1);
  assert.equal(f.sql.prepare('SELECT duplicates FROM refresh_occurrences').get().duplicates, 1);
});

test('invalid metadata remains visible without executing application work', async t => {
  const f = fixture(t); await assert.rejects(f.run('new', 'inventory', {}), /Invalid configured native occurrence/);
  assert.deepEqual(f.attempts().map(r => [r.outcome,r.scheduled_time]), [['rejected', null]]);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 0);
});

test('unarmed, already-started and later old occurrences do not acquire the selected hold', async t => {
  const f = fixture(t); await f.run('old', 'advisory');
  f.sql.exec('UPDATE cron_replacement_control SET armed_after = 60000');
  await f.run('old', 'inventory'); await f.run('old', 'advisory');
  f.sql.exec('UPDATE cron_replacement_control SET armed_after = 0, held_time = 60000');
  await f.run('old', 'advisory', { ...event, scheduledTime: 120000 });
  assert.ok(f.attempts().every(row => row.held_at === null && row.outcome === 'success'));
});

test('an after-commit hold retains a business result before returning', async t => {
  const f = fixture(t); f.sql.exec("UPDATE cron_replacement_control SET armed_after = 0, position = 'after'");
  const running = f.run('old', 'advisory');
  try {
    const until = Date.now() + 3000;
    while (!f.attempts()[0]?.held_at && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const row = f.attempts()[0]; assert.ok(row.held_at); assert.equal(row.outcome, 'pending');
    assert.ok(Number.isSafeInteger(row.result_saved_at)); assert.ok(row.result_saved_at <= row.held_at); assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 1);
  } finally { f.sql.exec('UPDATE cron_replacement_control SET released = 1'); await running; }
  assert.equal(f.attempts()[0].outcome, 'success');
});

test('one occurrence can hold advisory before commit and inventory after commit', async t => {
  const f = fixture(t); f.sql.exec("UPDATE cron_replacement_control SET armed_after = 0, inventory_position = 'after'");
  const running = Promise.all(['advisory','inventory'].map(job => f.run('old', job)));
  try {
    const until = Date.now() + 3000;
    while (f.attempts().filter(row => row.last_poll_at !== null).length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.attempts().every(row => row.held_at && row.last_poll_at));
    assert.deepEqual(f.sql.prepare('SELECT job,status FROM refresh_occurrences ORDER BY job').all().map(row => [row.job,row.status]), [['advisory','pending'],['inventory','complete']]);
    assert.deepEqual(f.sql.prepare('SELECT job FROM refresh_results').all().map(row => row.job), ['inventory']);
  } finally { f.sql.exec('UPDATE cron_replacement_control SET released = 1'); await running; }
});

test('a hold deadline leaves a recorded thrown attempt and no business commit', async t => {
  const f = fixture(t); let now = 61000;
  t.mock.method(Date, 'now', () => now); f.sql.exec('UPDATE cron_replacement_control SET armed_after = 0');
  const running = f.run('old', 'advisory'), failed = assert.rejects(running, /qualification deadline/);
  try {
    const until = performance.now() + 3000;
    while (!f.attempts()[0]?.last_poll_at && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.attempts()[0].last_poll_at); now += 20001; await failed;
  } finally {
    f.sql.exec('UPDATE cron_replacement_control SET released = 1');
    await running.catch(() => {});
  }
  assert.equal(f.attempts()[0].outcome, 'thrown');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 0);
});
