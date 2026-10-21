import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cronSQL } from '../sql.mjs';
import { cronRecords } from '../records.mjs';
import { vmNow, vmWaitUntil, vmMinuteBoundary } from '../vm-time.mjs';
import { refreshGateway } from '../gateway.mjs';
import { lateReapPlan, reapTick } from './reap-plan.mjs';
import { cleanupReplacement } from './cleanup.mjs';
import { chromium, expect } from '../../guestbook-browser.mjs';

export async function replacementScenarios({ probe, session, defaults, progress = async () => {} }) {
  let artifact, failure, browser, pendingGate, result;
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
    await progress('holding old work across compatible migration');
    const armedAfter = await arm('old'), oldHeld = (await held('old', armedAfter))[0];
    const updating = session.command('update', { release: 'new' });
    updating.catch(() => {}); // The original promise is awaited after the gate opens.
    await expect.poll(async () => (await session.receipt())?.step, { timeout: 15000, intervals: [50,100] }).toBe('update-held');
    const checkpoint = await session.receipt(); pendingGate = checkpoint.updateGate.id;
    assert.equal(checkpoint.updateGate.native.paused, true); assert.equal(checkpoint.updateGate.native.nextAlarm, null);
    assert.ok(checkpoint.updateGate.at >= oldHeld.held_at);
    const applied = await sql("SELECT name FROM d1_migrations WHERE name = '0003_compatible.sql';"); assert.equal(applied.length, 1);
    assert.ok(!(await results()).some(row => row.job === 'advisory' && row.scheduled_time === oldHeld.scheduled_time));
    const releasedAt = await vmNow(probe); await sql('UPDATE cron_replacement_control SET released = 1 WHERE id = 1;');
    const oldRows = await completed(oldHeld.scheduled_time), oldDone = oldRows.find(row => row.id === oldHeld.id);
    assert.equal(oldDone.outcome, 'success');
    const completionAfterScheduledMs = oldDone.finished_at - oldDone.scheduled_time;
    assert.ok(completionAfterScheduledMs < 15000, 'Rejected: migration overlap exceeded the native operation deadline'); assert.ok(oldDone.unblocked_at >= releasedAt && oldDone.unblocked_at < oldHeld.held_at + 20000 && oldDone.result_saved_at >= oldDone.unblocked_at);
    const retained = (await results()).find(row => row.job === 'advisory' && row.scheduled_time === oldHeld.scheduled_time);
    assert.equal(retained.compatibility_marker, 'compatible');
    const gateReleasedAt = await vmNow(probe); assert.ok(oldDone.finished_at <= gateReleasedAt);
    await session.releaseUpdate(pendingGate); pendingGate = null;
    const updated = await updating; artifact = updated.artifact;
    const approvedAt = await vmNow(probe); assert.notEqual(initial.digest, updated.digest);
    return { armedAfter, oldHeld, checkpoint, applied, releasedAt, oldRows, retained, gateReleasedAt, updated, approvedAt, completionAfterScheduledMs };
  }
  function swapLine(logs, generation) {
    return logs.split('\n').find(line => line.includes('event="generation_swap_out"') && line.includes('scope=.cron:refresh ') && new RegExp(`\\bgeneration=${generation}(?:\\s|$)`).test(line));
  }
  async function owningSwap(row, since) {
    let line;
    await expect.poll(async () => { line = swapLine(await probe.compose(['logs', '--no-color', '--no-log-prefix', '--since', new Date(since).toISOString(), row.host]), row.deployment.generation); return Boolean(line); }, { timeout: 15000, intervals: [100,250] }).toBe(true);
    return { at: Date.parse(line.split(' ')[0]), line };
  }
  async function adoption(row, since) {
    const logs = await probe.compose(['logs', '--no-color', '--no-log-prefix', '--since', new Date(since).toISOString(), row.host]);
    const line = logs.split('\n').find(line => line.includes('event="deployment_generation_adopted"') && new RegExp(`\\bgeneration=${row.deployment.generation}(?:\\s|$)`).test(line) && line.includes(`version=${row.deployment.version} `));
    assert.ok(line, 'Native generation adoption must be measured before publication');
    const at = Date.parse(line.split(' ')[0]); assert.ok(Number.isFinite(at)); return { at, line };
  }
  async function freedGenerations(before, since) {
    let observations;
    await expect.poll(async () => {
      observations = await Promise.all(before.map(async row => {
        const logs = await probe.compose(['logs','--no-color','--no-log-prefix','--since',new Date(since).toISOString(),row.host]);
        const match = logs.split('\n').find(line => line.includes('event="deployment_generation_freed"') && line.includes(`generation=${row.deployment.generation} `) && line.includes(`version=${row.deployment.version}`));
        if (!match) return null;
        const cronOwner = row.deployment.cells['.cron:refresh'] === row.deployment.generation;
        const swap = swapLine(logs, row.deployment.generation);
        if (cronOwner && !swap) return null;
        return { node: row.host, generation: row.deployment.generation, freedAt: Date.parse(match.split(' ')[0]), line: match, cronOwner, swapAt: swap ? Date.parse(swap.split(' ')[0]) : null, swapLine: swap || null };
      })); return observations.every(Boolean);
    }, { timeout: 35000, intervals: [100,250] }).toBe(true);
    assert.ok(observations.every(row => Number.isFinite(row.freedAt) && row.freedAt >= since)); return observations;
  }
  async function interruptedNew(updated) {
    await progress('observing pre/post-commit work through publication');
    const armedAfter = await arm('new', 'after'), heldRows = await held('new', armedAfter, true);
    const time = heldRows[0].scheduled_time; assert.equal(time % 60000, 0);
    const base = await sql(`SELECT * FROM refresh_occurrences WHERE scheduled_time = ${time} ORDER BY job;`);
    assert.deepEqual(base.map(row => [row.job,row.status]), [['advisory','pending'],['inventory','complete']]);
    const saved = (await results()).filter(row => row.scheduled_time === time); assert.deepEqual(saved.map(row => row.job), ['inventory']);
    const before = await probe.state(), bucket = await cronRecords(probe, 'refresh');
    assert.ok(before.every(row => row.deployment.version === updated.dispatch.version));
    assert.equal(before.filter(row => row.deployment.cells['.cron:refresh'] === row.deployment.generation).length, 1);
    assert.equal(before.find(row => row.deployment.cells['.cron:refresh'] === row.deployment.generation).host, bucket.owner.node);
    const cronBefore = before.find(row => row.deployment.cells['.cron:refresh'] === row.deployment.generation);
    const adopted = await adoption(cronBefore, updated.updateLifecycle.publishRequestedAt - 1000);
    const maintenance = { ...lateReapPlan({ adoptedAt: adopted.at, scheduledTime: time, heldRows, intervalMs: defaults.generationReapIntervalMs }), adoptionLine: adopted.line };
    const updating = session.command('update', { release: 'final' }); updating.catch(() => {});
    await expect.poll(async () => (await session.receipt())?.step, { timeout: 15000, intervals: [50,100] }).toBe('update-held');
    const checkpoint = await session.receipt(); pendingGate = checkpoint.updateGate.id;
    assert.equal(checkpoint.updateGate.native.paused, true); assert.equal(checkpoint.updateGate.native.nextAlarm, null);
    assert.ok(checkpoint.updateLifecycle.pauseConfirmedAt <= checkpoint.updateLifecycle.migrationCompletedAt);
    let liveAfterPause;
    await expect.poll(async () => { liveAfterPause = (await attempts()).filter(row => heldRows.some(old => old.id === row.id)); return liveAfterPause.length === 2 && liveAfterPause.every(row => row.last_poll_at > checkpoint.updateGate.at && row.outcome === 'pending'); }, { timeout: 5000, intervals: [50,100] }).toBe(true);
    // Release after the measured old tick; the next tick must follow the quiet check.
    await vmWaitUntil(probe, maintenance.releaseAt);
    const releasedAt = await vmNow(probe); assert.ok(releasedAt < time + 12000);
    await session.releaseUpdate(pendingGate); pendingGate = null;
    const final = await updating; artifact = final.artifact;
    const approvedAt = await vmNow(probe), after = await probe.state(); assert.ok(after.every(row => row.deployment.version === final.dispatch.version));
    const swap = await owningSwap(cronBefore, time); assert.ok(Number.isFinite(swap.at));
    const snapshot = (await attempts()).filter(row => heldRows.some(old => old.id === row.id));
    assert.equal(snapshot.length, 2);
    assert.ok(snapshot.every(row => row.outcome === 'pending' && row.finished_at === null && row.unblocked_at === null && row.last_poll_at <= approvedAt && row.last_poll_at >= checkpoint.updateGate.at && Math.abs(row.last_poll_at - swap.at) <= 300));
    const heartbeatAfterSwapMs = snapshot.map(row => ({ job: row.job, ms: row.last_poll_at - swap.at }));
    const swapAfterScheduledMs = swap.at - time;
    // deploy's reply precedes replica adoption; approvedAt follows readiness.
    const publishReplyToSwapMs = swap.at - final.updateLifecycle.publishCompletedAt;
    assert.ok(swapAfterScheduledMs < 15000, 'Rejected: publication swap exceeded the native operation deadline');
    assert.ok(swap.at >= final.updateLifecycle.publishRequestedAt && swap.at <= approvedAt, 'Swap must follow publication request and precede activation confirmation');
    const deadlineQuietUntil = maintenance.quietUntil;
    assert.ok(deadlineQuietUntil < time + 60000 - 5000, 'Rejected: no unconfounded future retry window remains');
    await vmWaitUntil(probe, deadlineQuietUntil);
    const afterDeadline = (await attempts()).filter(row => row.scheduled_time === time);
    assert.deepEqual(afterDeadline, snapshot, 'Interrupted occurrence retried or progressed after the default deadline');
    const quietObservedAt = await vmNow(probe);
    const freed = await freedGenerations(before, time), owner = freed.find(row => row.cronOwner);
    assert.equal(owner.swapAt, swap.at); assert.ok(owner.swapAt <= owner.freedAt);
    assert.ok(freed.every(row => row.freedAt <= approvedAt + maintenance.intervalMs + 2000), 'Generation release exceeded a native maintenance interval');
    assert.equal(reapTick(maintenance.adoptedAt, swap.at, maintenance.intervalMs), maintenance.predictedTickAt);
    assert.ok(maintenance.predictedTickAt > quietObservedAt && owner.freedAt > quietObservedAt, 'The measured maintenance tick must follow the quiet check');
    assert.ok(owner.freedAt >= maintenance.predictedTickAt - 250 && owner.freedAt <= maintenance.predictedTickAt + 1500, 'Native generation free must match its measured maintenance phase');
    const afterFree = (await attempts()).filter(row => row.scheduled_time === time);
    assert.deepEqual(afterFree, snapshot, 'Interrupted occurrence progressed before or after actual generation release');
    const wake = await cronRecords(probe, 'refresh'), info = await native();
    assert.deepEqual(wake.owner, bucket.owner);
    assert.equal(info.nextAlarm, time + 60000); assert.deepEqual(wake.wakes.map(row => row.due_ms), [info.nextAlarm]);
    return { armedAfter, time, heldRows, base, saved, before, bucket, checkpoint, liveAfterPause, releasedAt, final, approvedAt, after, freed, owner, snapshot, heartbeatAfterSwapMs, wake, info, swapAfterScheduledMs, publishReplyToSwapMs, maintenance, deadlineQuietUntil, quietObservedAt, afterDeadline, afterFree };
  }
  async function lostReply(time) {
    await progress('checking persisted lost-ack retry and a later healthy tick');
    await api('lost-ack-once'); const before = await cronRecords(probe, 'refresh');
    assert.ok(time - await vmNow(probe) > 5000); let bucket, retry, alarm, missedDeadline = false;
    await expect.poll(async () => {
      const first = (await attempts()).filter(row => row.scheduled_time === time);
      if (!first.some(row => row.job === 'advisory' && row.outcome === 'thrown')) return false;
      bucket = await cronRecords(probe, 'refresh');
      retry = bucket.wakes.find(row => row.due_ms > time && row.due_ms < time + 60000 && row.due_ms > bucket.at + 500);
      if (!retry) return false;
      alarm = await native();
      if (retry.due_ms <= await vmNow(probe)) { missedDeadline = true; return true; }
      return retry.due_ms === alarm.nextAlarm;
    }, { timeout: 90000, intervals: [50,100] }).toBe(true);
    assert.equal(missedDeadline, false, 'Rejected: guarded observation missed the persisted retry deadline');
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
    result = { ...evidence, finalRows, finalResults, unfinished: state.unfinished, heldInterval: { start: pausedAt,boundary,end: observedAt }, browserErrors: errors, controller,
      scope: 'Private ordinary Void releases. Old work commits under a compatible migration before publication. Held pre/post-commit callbacks continue recording heartbeats after pause and migration, then stop recording near publication swap; no later D1 progress is observed after the old generation is freed. Unfinished application work and later new-code occurrences are observed. A separate lost reply retries the original occurrence and increments duplicate counters without another business row. No drain, external-effect termination, automatic replay guarantee, arbitrary external-effect exactly once, scoped cron admission, stopped snapshot recovery or retirement.' };
    await probe.save('replacement', result);
  } catch (error) { failure = error; await probe.save('replacement-failure', { message: error.message,evidence }); throw error; }
  finally { await cleanupReplacement({ probe, session, pendingGate, failure, browser }); }

  return result;
}
