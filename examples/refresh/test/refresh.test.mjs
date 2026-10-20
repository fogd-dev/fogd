import test from 'node:test';
import assert from 'node:assert/strict';
import { d1Fixture } from '../../../scripts/test-d1.mjs';
import { refreshJob, summary, changeMode, scheduledRefresh, beginScheduledRefresh } from '../lib/refresh.mjs';
const event = { cron: '* * * * *', scheduledTime: 60000 };
function fixture(t) {
  const f = d1Fixture(new URL('../db/migrations/0001_refresh.sql', import.meta.url));
  t.after(f.close); return f;
}
const run = (db, job, occurrence = event) => refreshJob(db, job, occurrence, () => occurrence.scheduledTime + 1000);

test('retry of a shared expression completes its failed job without duplicating its successful sibling', async t => {
  const { db, sql } = fixture(t);
  await run(db, 'inventory'); await assert.rejects(run(db, 'advisory'), /advisory source is unavailable/);
  const failed = await summary(db);
  assert.equal(failed.jobs.find(job => job.job === 'advisory').latest.status, 'failed');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 1);
  await Promise.all([run(db, 'inventory'), run(db, 'advisory')]);
  const state = await summary(db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 2);
  assert.deepEqual(state.jobs.map(job => [job.job, job.latest.status, job.latest.attempts, job.latest.duplicates]),
    [['inventory', 'complete', 2, 1], ['advisory', 'complete', 2, 0]]);
});

test('a simulated lost reply after save keeps completion and deduplicates both jobs on expression retry', async t => {
  const { db, sql } = fixture(t); await changeMode(db, 'lost-ack-once');
  await run(db, 'inventory'); await assert.rejects(run(db, 'advisory'), /reply was lost after saving/);
  assert.equal((await summary(db)).jobs.find(job => job.job === 'advisory').latest.status, 'complete');
  await Promise.all([run(db, 'inventory'), run(db, 'advisory')]);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 2);
  assert.deepEqual((await summary(db)).jobs.map(job => [job.latest.attempts, job.latest.duplicates, job.latest.error]), [[2, 1, null], [2, 1, null]]);
});

test('an ambiguously committed D1 batch never turns a saved result into failed work or writes it twice', async t => {
  const { db, sql } = fixture(t); await changeMode(db, 'healthy');
  const batch = db.batch.bind(db);
  db.batch = async statements => { await batch(statements); throw Error('private storage diagnostic'); };
  await assert.rejects(run(db, 'inventory'), /private storage diagnostic/);
  db.batch = batch;
  await run(db, 'inventory');
  const state = await summary(db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 1);
  assert.equal(state.jobs[0].latest.status, 'complete'); assert.equal(state.jobs[0].latest.duplicates, 1);
  assert.ok(!JSON.stringify(state).includes('private storage diagnostic'));
});

test('overlapping invocations share one durable business result per job and scheduled time', async t => {
  const { db, sql } = fixture(t); await changeMode(db, 'healthy');
  await Promise.all([run(db, 'inventory'), run(db, 'inventory')]);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 1);
  assert.equal((await summary(db)).jobs[0].latest.attempts, 2);
  assert.equal((await summary(db)).jobs[0].latest.status, 'complete');
});

test('a later failed occurrence retains its last successful value and a future occurrence can recover', async t => {
  const { db } = fixture(t); await changeMode(db, 'healthy'); await run(db, 'advisory');
  await changeMode(db, 'offline');
  await assert.rejects(run(db, 'advisory', { ...event, scheduledTime: 120000 }), /advisory source is unavailable/);
  const failed = (await summary(db)).jobs[1];
  assert.equal(failed.latest.status, 'failed'); assert.equal(failed.lastSuccess.scheduled_time, 60000);
  assert.match(failed.latest.error, /later attempt can recover/);
  await changeMode(db, 'healthy'); await run(db, 'advisory', { ...event, scheduledTime: 180000 });
  assert.equal((await summary(db)).jobs[1].lastSuccess.scheduled_time, 180000);
});

test('invalid identities, unsupported mode and missing private configuration cannot create a result', async t => {
  const { db, sql } = fixture(t);
  await assert.rejects(run(db, 'other'), /Invalid refresh occurrence/);
  await assert.rejects(run(db, 'inventory', { ...event, scheduledTime: -1 }), /Invalid refresh occurrence/);
  await assert.rejects(changeMode(db, 'other'), /Unknown source mode/);
  await assert.rejects(scheduledRefresh('inventory', event, { DB: db }), /configuration is missing/);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM refresh_occurrences').get().n, 0);
});

test('a long source outage cannot hide its last success behind another job’s recent results', async t => {
  const { db } = fixture(t); await changeMode(db, 'healthy'); await run(db, 'advisory');
  await changeMode(db, 'offline');
  for (let minute = 2; minute <= 24; minute++) {
    const occurrence = { ...event, scheduledTime: minute * 60000 };
    await run(db, 'inventory', occurrence);
    await assert.rejects(run(db, 'advisory', occurrence), /advisory source is unavailable/);
  }
  const advisory = (await summary(db)).jobs.find(job => job.job === 'advisory');
  assert.equal(advisory.lastSuccess.scheduled_time, 60000);
  assert.equal(advisory.latest.status, 'failed');
});

test('a prepared refresh is visible before its business commit and completion has its own time', async t => {
  const { db, sql } = fixture(t); await changeMode(db, 'healthy'); let now = 61000;
  t.mock.method(Date, 'now', () => now);
  const work = await beginScheduledRefresh('advisory', event, { DB: db, REFRESH_TOKEN: 'test' });
  assert.equal(sql.prepare('SELECT status FROM refresh_occurrences').get().status, 'pending');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 0);
  assert.deepEqual((await summary(db, () => 120999)).unfinished, []);
  assert.equal((await summary(db, () => 121000)).unfinished.length, 1);
  now = 125000; await work.complete();
  const row = sql.prepare('SELECT * FROM refresh_occurrences').get();
  assert.equal(row.last_attempt_at, 61000); assert.equal(row.completed_at, 125000);
  assert.equal(sql.prepare('SELECT saved_at FROM refresh_results').get().saved_at, 125000);
  assert.deepEqual((await summary(db)).unfinished, []);
});

test('a later saved occurrence exposes earlier unfinished work without changing its stored outcome', async t => {
  const { db, sql } = fixture(t); await changeMode(db, 'healthy');
  t.mock.method(Date, 'now', () => 119000);
  await beginScheduledRefresh('advisory', event, { DB: db, REFRESH_TOKEN: 'test' });
  await run(db, 'advisory', { ...event, scheduledTime: 120000 });
  const observed = await summary(db, () => 121000);
  assert.equal(observed.jobs[1].latest.status, 'complete'); assert.equal(observed.unfinished[0].scheduled_time, 60000);
  assert.equal(sql.prepare('SELECT status FROM refresh_occurrences WHERE scheduled_time = 60000').get().status, 'pending');
});

test('recently retried older rows cannot hide an unfinished occurrence beyond the display limit', async t => {
  const { db, sql } = fixture(t);
  const insert = sql.prepare("INSERT INTO refresh_occurrences (job,cron,scheduled_time,initial_mode,last_attempt_at) VALUES ('advisory','* * * * *',?,'healthy',?)");
  for (let n = 1; n <= 20; n++) insert.run(n * 60000, 10000000);
  insert.run(21 * 60000, 9000000);
  const state = await summary(db, () => 10000001);
  assert.deepEqual(state.unfinished.map(row => row.scheduled_time), [21 * 60000]);
  for (let n = 22; n <= 45; n++) insert.run(n * 60000, 9000000);
  const capped = await summary(db, () => 10000001);
  assert.equal(capped.unfinished.length, 20); assert.equal(capped.unfinishedCount, 25);
});
