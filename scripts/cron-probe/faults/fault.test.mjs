import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { d1Fixture } from '../../test-d1.mjs';
import { scheduledRefresh } from '../../../examples/refresh/lib/refresh.mjs';
import { faultJob } from './fault.mjs';
const event = { cron: '* * * * *', scheduledTime: 60000 };
function fixture(t, policy) {
  const f = d1Fixture(new URL('../../../examples/refresh/db/migrations/0001_refresh.sql', import.meta.url));
  f.sql.exec(readFileSync(new URL('./0002_faults.sql', import.meta.url), 'utf8'));
  f.sql.exec("UPDATE refresh_settings SET mode = 'healthy'");
  f.sql.prepare('UPDATE cron_fault_control SET policy = ?').run(policy);
  t.after(f.close);
  const run = (job, selected = event) => faultJob(job, selected, { DB: f.db, REFRESH_TOKEN: 'test-token' }, scheduledRefresh);
  return { ...f, run, attempts: () => f.sql.prepare('SELECT * FROM cron_fault_attempts ORDER BY rowid').all() };
}

test('noRetry records the actual controller call and failure without a business result', async t => {
  const f = fixture(t, 'no-retry'); let calls = 0;
  await assert.rejects(f.run('advisory', { ...event, noRetry() { calls++; } }), /Intentional scheduled source failure/);
  await f.run('inventory');
  assert.equal(calls, 1); const rows = f.attempts();
  assert.deepEqual(rows.map(r => [r.job, r.outcome, r.no_retry_called]), [['advisory', 'thrown', 1], ['inventory', 'success', 0]]);
  assert.ok(rows.every(r => r.entered_at <= r.finished_at && r.scheduled_time === 60000));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 1);
});

test('owner-loss policy uses durable attempt history and the real refresh result is idempotent', async t => {
  const f = fixture(t, 'owner-loss');
  for (let i = 0; i < 2; i++) await assert.rejects(f.run('advisory'), /Intentional/);
  await f.run('advisory'); await f.run('advisory');
  assert.deepEqual(f.attempts().map(r => r.outcome), ['thrown', 'thrown', 'success', 'success']);
  assert.equal(new Set(f.attempts().map(r => r.id)).size, 4);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 1);
});

test('terminal policy never changes into success because its attempt count grows', async t => {
  const f = fixture(t, 'terminal');
  for (let i = 0; i < 8; i++) await assert.rejects(f.run('advisory'), /Intentional/);
  assert.equal(f.attempts().length, 8); assert.ok(f.attempts().every(r => r.outcome === 'thrown' && r.no_retry_called === 0));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM refresh_results').get().n, 0);
});

test('entry time is captured before the first asynchronous yield', async t => {
  const f = fixture(t, 'healthy'); let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const running = f.run('inventory'); now = 2000; await running;
  assert.equal(f.attempts()[0].entered_at, 1000); assert.equal(f.attempts()[0].finished_at, 2000);
});

test('invalid metadata and missing configuration remain visible as rejected entries', async t => {
  const f = fixture(t, 'healthy');
  await assert.rejects(faultJob('advisory', {}, { DB: f.db, REFRESH_TOKEN: 'test' }, scheduledRefresh), /Invalid native occurrence/);
  await assert.rejects(faultJob('inventory', event, { DB: f.db }, scheduledRefresh), /Missing refresh configuration/);
  assert.deepEqual(f.attempts().map(r => [r.outcome,r.scheduled_time]), [['rejected', null], ['rejected', 60000]]);
});

test('an unavailable outcome journal does not replace the original job failure', async t => {
  const f = fixture(t, 'terminal'), prepare = f.db.prepare.bind(f.db);
  f.db.prepare = text => {
    const statement = prepare(text);
    if (text.startsWith('UPDATE cron_fault_attempts')) statement.run = async () => { throw Error('Outcome journal unavailable'); };
    return statement;
  };
  await assert.rejects(f.run('advisory'), /Intentional scheduled source failure/);
  assert.equal(f.attempts()[0].outcome, 'pending');
});
