import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, upload } from './queue-probe/context.mjs';
import { stageReplacementRefresh } from './cron-probe/replacement/build.mjs';
import { startVoidSession } from './cron-probe/void-driver-session.mjs';
import { cronSQL } from './cron-probe/sql.mjs';
import { cronRecords } from './cron-probe/records.mjs';
import { vmNow, vmMinuteBoundary } from './cron-probe/vm-time.mjs';
import { refreshGateway } from './cron-probe/gateway.mjs';
import { cleanupCronProbe } from './cron-probe-cleanup.mjs';
import { chromium, expect } from './guestbook-browser.mjs';

const probe = await context(process.argv[2], process.argv[3]); await requireEmptyFleet(probe);
assert.equal(probe.slot.nodes.length, 2); assert.equal(probe.budget, 30);
for (const node of probe.slot.nodes) assert.equal(Number(probe.config.services[node].environment.CELLD_OPERATION_DEADLINE_MS), 60000);
await cp(new URL(import.meta.url), join(probe.output, 'driver.mjs'));
await cp(new URL('./cron-probe/refresh-project.mjs', import.meta.url), join(probe.output, 'refresh-project.mjs'));
await cp(new URL('./cron-probe/replacement/build.mjs', import.meta.url), join(probe.output, 'build.mjs'));
const releases = {}, sources = {};
for (const release of ['old', 'new', 'final']) {
  releases[release] = await stageReplacementRefresh(join(probe.output, release), release);
  sources[release] = await upload(probe, releases[release].output, `replacement-${release}`);
  assert.deepEqual(releases.old.config.d1_databases, releases[release].config.d1_databases);
}
const session = await startVoidSession(probe, sources.old, 15);
let artifact, failure, browser, pendingGate;
const sql = text => cronSQL(probe, artifact, text);
const attempts = () => sql('SELECT * FROM cron_replacement_attempts ORDER BY entered_at,id;');
const results = () => sql('SELECT * FROM refresh_results ORDER BY scheduled_time,job;');
const native = async () => JSON.parse(await probe.cli(['cron', 'info', 'refresh', '--json']));
const jobs = ['advisory', 'inventory'];
const origin = `http://refresh.localhost:${probe.env.FOGD_HTTP_PORT}`, evidence = {};
async function api(mode) {
  const options = mode ? { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) } : {};
  const response = await refreshGateway(probe.env.FOGD_HTTP_PORT, '/api/refresh', options);
  assert.equal(response.status, 200); return response.json();
}
async function arm(release, inventory = 'none') {
  assert.ok(['old','new'].includes(release)); assert.ok(['none','after'].includes(inventory));
  const at = await vmNow(probe);
  const rows = await sql(`UPDATE cron_replacement_control SET armed_after = ${at}, held_time = NULL, released = 0, hold_release = '${release}', position = 'before', inventory_position = '${inventory}' WHERE id = 1 RETURNING *;`);
  assert.equal(rows.length, 1); assert.equal(rows[0].armed_after, at); return at;
}
async function held(release, armedAfter, both = false) {
  let rows;
  await expect.poll(async () => {
    rows = (await attempts()).filter(row => row.release === release && row.scheduled_time > armedAfter && row.held_at && Number.isSafeInteger(row.last_poll_at) && row.outcome === 'pending');
    return (both ? jobs : ['advisory']).every(job => rows.some(row => row.job === job));
  }, { timeout: 90000, intervals: [50, 100] }).toBe(true);
  assert.equal(new Set(rows.map(row => row.scheduled_time)).size, 1); return rows;
}
async function completed(time, count = 1) {
  let rows;
  await expect.poll(async () => { rows = (await attempts()).filter(row => row.scheduled_time === time); return !rows.some(row => row.outcome === 'pending') && jobs.every(job => rows.filter(row => row.job === job).length >= count && rows.some(row => row.job === job && row.outcome === 'success')); }, { timeout: 90000, intervals: [100, 250] }).toBe(true);
  return rows;
}
async function migratedOld(initial) {
  const armedAfter = await arm('old'), oldHeld = (await held('old', armedAfter))[0];
  const updating = session.command('update', { source: sources.new, updateGate: 'after-migration' });
  updating.catch(() => {}); // The original promise is awaited after the gate opens.
  await expect.poll(async () => (await session.receipt())?.step, { timeout: 15000, intervals: [50,100] }).toBe('update-held');
  const checkpoint = await session.receipt(); pendingGate = checkpoint.updateGate.id;
  assert.equal(checkpoint.updateGate.native.paused, true); assert.equal(checkpoint.updateGate.native.nextAlarm, null);
  assert.ok(checkpoint.updateGate.at >= oldHeld.held_at);
  const applied = await sql("SELECT name FROM d1_migrations WHERE name = '0003_compatible.sql';"); assert.equal(applied.length, 1);
  assert.ok(!(await results()).some(row => row.job === 'advisory' && row.scheduled_time === oldHeld.scheduled_time));
  const releasedAt = await vmNow(probe); await sql('UPDATE cron_replacement_control SET released = 1 WHERE id = 1;');
  const oldRows = await completed(oldHeld.scheduled_time), oldDone = oldRows.find(row => row.id === oldHeld.id);
  assert.equal(oldDone.outcome, 'success'); assert.ok(oldDone.unblocked_at >= releasedAt && oldDone.unblocked_at < oldHeld.held_at + 20000 && oldDone.result_saved_at >= oldDone.unblocked_at);
  const retained = (await results()).find(row => row.job === 'advisory' && row.scheduled_time === oldHeld.scheduled_time);
  assert.equal(retained.compatibility_marker, 'compatible');
  const gateReleasedAt = await vmNow(probe); assert.ok(oldDone.finished_at <= gateReleasedAt);
  await session.releaseUpdate(pendingGate); pendingGate = null;
  const updated = await updating; artifact = updated.artifact;
  const approvedAt = await vmNow(probe); assert.notEqual(initial.digest, updated.digest);
  return { armedAfter, oldHeld, checkpoint, applied, releasedAt, oldRows, retained, gateReleasedAt, updated, approvedAt };
}
async function freedGenerations(before, since) {
  let observations;
  await expect.poll(async () => {
    observations = await Promise.all(before.map(async row => {
      const logs = await probe.compose(['logs','--no-color','--no-log-prefix','--since',new Date(since).toISOString(),row.host]);
      const match = logs.split('\n').find(line => line.includes('event="deployment_generation_freed"') && line.includes(`generation=${row.deployment.generation} `) && line.includes(`version=${row.deployment.version}`));
      if (!match) return null;
      const cronOwner = row.deployment.cells['.cron:refresh'] === row.deployment.generation;
      const swap = logs.split('\n').find(line => line.includes('event="generation_swap_out"') && line.includes('scope=.cron:refresh ') && line.includes(`generation=${row.deployment.generation}`));
      if (cronOwner && !swap) return null;
      return { node: row.host, generation: row.deployment.generation, freedAt: Date.parse(match.split(' ')[0]), line: match, cronOwner, swapAt: swap ? Date.parse(swap.split(' ')[0]) : null, swapLine: swap || null };
    })); return observations.every(Boolean);
  }, { timeout: 15000, intervals: [100,250] }).toBe(true);
  assert.ok(observations.every(row => Number.isFinite(row.freedAt) && row.freedAt >= since)); return observations;
}
async function interruptedNew(updated) {
  const armedAfter = await arm('new', 'after'), heldRows = await held('new', armedAfter, true);
  const time = heldRows[0].scheduled_time; assert.equal(time % 60000, 0);
  const base = await sql(`SELECT * FROM refresh_occurrences WHERE scheduled_time = ${time} ORDER BY job;`);
  assert.deepEqual(base.map(row => [row.job,row.status]), [['advisory','pending'],['inventory','complete']]);
  const saved = (await results()).filter(row => row.scheduled_time === time); assert.deepEqual(saved.map(row => row.job), ['inventory']);
  const before = await probe.state(), bucket = await cronRecords(probe, 'refresh');
  assert.ok(before.every(row => row.deployment.version === updated.dispatch.version));
  assert.equal(before.filter(row => row.deployment.cells['.cron:refresh'] === row.deployment.generation).length, 1);
  assert.equal(before.find(row => row.deployment.cells['.cron:refresh'] === row.deployment.generation).host, bucket.owner.node);
  const updating = session.command('update', { source: sources.final, updateGate: 'before-publication' }); updating.catch(() => {});
  await expect.poll(async () => (await session.receipt())?.step, { timeout: 15000, intervals: [50,100] }).toBe('update-held');
  const checkpoint = await session.receipt(); pendingGate = checkpoint.updateGate.id;
  assert.equal(checkpoint.updateGate.native.paused, true); assert.equal(checkpoint.updateGate.native.nextAlarm, null);
  assert.ok(checkpoint.updateLifecycle.pauseConfirmedAt <= checkpoint.updateLifecycle.migrationCompletedAt);
  let liveAfterPause;
  await expect.poll(async () => { liveAfterPause = (await attempts()).filter(row => heldRows.some(old => old.id === row.id)); return liveAfterPause.length === 2 && liveAfterPause.every(row => row.last_poll_at > checkpoint.updateGate.at && row.outcome === 'pending'); }, { timeout: 5000, intervals: [50,100] }).toBe(true);
  const releasedAt = await vmNow(probe); await session.releaseUpdate(pendingGate); pendingGate = null;
  const final = await updating; artifact = final.artifact;
  const approvedAt = await vmNow(probe), after = await probe.state(); assert.ok(after.every(row => row.deployment.version === final.dispatch.version));
  const freed = await freedGenerations(before, Math.min(...heldRows.map(row => row.entered_at)));
  assert.ok(freed.every(row => row.freedAt < Math.min(...heldRows.map(row => row.held_at)) + 20000));
  const owner = freed.find(row => row.cronOwner); assert.ok(owner && Number.isFinite(owner.swapAt) && owner.swapAt <= owner.freedAt);
  const snapshot = (await attempts()).filter(row => heldRows.some(old => old.id === row.id));
  assert.equal(snapshot.length, 2);
  assert.ok(snapshot.every(row => row.outcome === 'pending' && row.finished_at === null && row.unblocked_at === null && row.last_poll_at <= owner.freedAt && row.last_poll_at >= checkpoint.updateGate.at && Math.abs(row.last_poll_at - owner.swapAt) <= 300));
  const heartbeatAfterSwapMs = snapshot.map(row => ({ job: row.job, ms: row.last_poll_at - owner.swapAt }));
  const wake = await cronRecords(probe, 'refresh'), info = await native();
  assert.deepEqual(wake.owner, bucket.owner);
  assert.equal(info.nextAlarm, time + 60000); assert.ok(wake.wakes.some(row => row.due_ms === info.nextAlarm));
  return { armedAfter, time, heldRows, base, saved, before, bucket, checkpoint, liveAfterPause, releasedAt, final, approvedAt, after, freed, owner, snapshot, heartbeatAfterSwapMs, wake, info };
}
async function lostReply(time) {
  await api('lost-ack-once'); const before = await cronRecords(probe, 'refresh');
  assert.ok(time - await vmNow(probe) > 5000); let bucket, retry, alarm;
  await expect.poll(async () => {
    const first = (await attempts()).filter(row => row.scheduled_time === time);
    if (!first.some(row => row.job === 'advisory' && row.outcome === 'thrown')) return false;
    bucket = await cronRecords(probe, 'refresh'); alarm = await native();
    retry = bucket.wakes.find(row => row.due_ms === alarm.nextAlarm && row.due_ms > time && row.due_ms < time + 60000 && row.due_ms > bucket.at + 500);
    return Boolean(retry);
  }, { timeout: 90000, intervals: [50,100] }).toBe(true);
  const rows = await completed(time, 2), after = await cronRecords(probe, 'refresh');
  assert.deepEqual(bucket.owner, before.owner); assert.deepEqual(after.owner, before.owner);
  for (const job of jobs) {
    const selected = rows.filter(row => row.job === job).sort((a,b) => a.entered_at-b.entered_at);
    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(row => row.outcome), job === 'advisory' ? ['thrown','success'] : ['success','success']);
    assert.ok(selected[1].entered_at >= retry.due_ms && selected[1].entered_at >= selected[0].finished_at && selected[1].entered_at < time + 60000);
    assert.ok(selected.every(row => row.release === 'final' && row.cron === '* * * * *' && row.result_saved_at !== null));
    assert.equal(selected[0].result_saved_at, selected[1].result_saved_at);
  }
  const occurrences = await sql(`SELECT * FROM refresh_occurrences WHERE scheduled_time = ${time} ORDER BY job;`);
  assert.equal(occurrences.length,2); assert.ok(occurrences.every(row => row.status === 'complete' && row.attempts === 2 && row.duplicates === 1));
  await api('healthy'); const future = await completed(time + 60000);
  assert.ok(future.every(row => row.release === 'final'));
  return { time, before, bucket, retry, alarm, after, rows, occurrences, future };
}
try {
  await expect.poll(async () => (await session.receipt())?.step, { timeout: 180000 }).toBe('active');
  const initial = await session.receipt(); artifact = initial.artifact; await api('healthy'); evidence.initial = initial;
  evidence.migration = await migratedOld(initial);
  evidence.interruption = await interruptedNew(evidence.migration.updated);
  evidence.retry = await lostReply(evidence.interruption.info.nextAlarm);
  const state = await api(); assert.deepEqual(state.unfinished.map(row => [row.job,row.scheduled_time]), [['advisory',evidence.interruption.time]]);
  browser = await chromium.launch(); const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await expect(page.getByRole('region', { name: 'Unfinished refreshes', exact: true })).toContainText('advisory');
  await expect(page.getByRole('region', { name: 'Unfinished refreshes', exact: true })).toContainText('No completion recorded');
  for (const job of jobs) await expect(page.getByRole('region', { name: job, exact: true })).toContainText('Saved');
  await page.screenshot({ path: join(probe.output, 'replacement.png'), fullPage: true }); assert.deepEqual(errors, []);
  await browser.close(); browser = null;
  const paused = await session.command('pause'), pausedAt = Date.parse(paused.dispatch.observedAt);
  assert.equal(paused.dispatch.observed, 'paused'); assert.ok(Number.isFinite(pausedAt));
  const boundary = await vmMinuteBoundary(probe), controller = await session.finish();
  const finalRows = await attempts(), finalResults = await results(), observedAt = await vmNow(probe);
  assert.ok(finalRows.every(row => Number.isSafeInteger(row.scheduled_time) && row.scheduled_time % 60000 === 0 && row.cron === '* * * * *' && row.entered_at >= row.scheduled_time));
  const abandonedIds = new Set(evidence.interruption.snapshot.map(row => row.id));
  assert.ok(finalRows.every(row => abandonedIds.has(row.id) || ['success','thrown'].includes(row.outcome)));
  assert.ok(!finalRows.some(row => row.entered_at >= pausedAt));
  assert.ok(!finalRows.some(row => row.entered_at >= evidence.migration.approvedAt && row.release === 'old'));
  assert.ok(!finalRows.some(row => row.entered_at >= evidence.interruption.approvedAt && row.release !== 'final'));
  for (const row of evidence.interruption.snapshot) assert.deepEqual(finalRows.find(value => value.id === row.id), row);
  assert.ok(observedAt > Math.max(...evidence.interruption.freed.map(row => row.freedAt)) + 62000);
  for (const [time,attemptCount,resultJobs] of [[evidence.migration.oldHeld.scheduled_time,1,jobs],[evidence.interruption.time,1,['inventory']],[evidence.retry.time,2,jobs],[evidence.retry.time+60000,1,jobs]]) {
    for (const job of jobs) assert.equal(finalRows.filter(row => row.scheduled_time === time && row.job === job).length, attemptCount);
    assert.deepEqual(finalResults.filter(row => row.scheduled_time === time).map(row => row.job).sort(), resultJobs);
  }
  await probe.save('replacement', { ...evidence, finalRows, finalResults, unfinished: state.unfinished, heldInterval: { start: pausedAt,boundary,end: observedAt }, browserErrors: errors, controller,
    scope: 'Private ordinary Void releases. Old work commits under a compatible migration before publication. Held pre/post-commit callbacks continue recording heartbeats after pause and migration, then stop recording near publication swap; no later D1 progress is observed after the old generation is freed. Unfinished application work and later new-code occurrences are observed. A separate lost reply retries the original occurrence and increments duplicate counters without another business row. No drain, external-effect termination, automatic replay guarantee, arbitrary external-effect exactly once, scoped cron admission, stopped snapshot recovery or retirement.' });
  console.log('PASS: compatible migration overlap, publication with lost completion and visible unfinished work, and native lost-reply retry identity');
} catch (error) { failure = error; await probe.save('failure', { message: error.message,evidence }); throw error; }
finally {
  await browser?.close();
  if (pendingGate) { try { await session.releaseUpdate(pendingGate); } catch { /* Gate has its own deadline. */ } }
  if (!session.terminal) { try { await session.finish(); } catch { /* Independent pause follows. */ } }
  try { await cleanupCronProbe(probe, () => probe.cli(['cron','pause','refresh','--json'])); }
  catch (error) { if (!failure) throw error; console.error('Cleanup failed; stop the disposable fleet and retain private evidence'); }
}
