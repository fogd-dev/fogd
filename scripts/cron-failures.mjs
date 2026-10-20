import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, upload } from './queue-probe/context.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { stageFaultRefresh } from './cron-probe/faults/build.mjs';
import { startVoidSession } from './cron-probe/void-driver-session.mjs';
import { cronSQL } from './cron-probe/sql.mjs';
import { cronRecords } from './cron-probe/records.mjs';
import { refreshGateway } from './cron-probe/gateway.mjs';
import { vmNow, vmWaitUntil, vmMinuteBoundary } from './cron-probe/vm-time.mjs';
import { cleanupCronProbe } from './cron-probe-cleanup.mjs';
import { chromium, expect } from './guestbook-browser.mjs';

const probe = await context(process.argv[2], process.argv[3]); await requireEmptyFleet(probe);
assert.equal(probe.slot.nodes.length, 2);
await cp(new URL(import.meta.url), join(probe.output, 'driver.mjs'));
const fast = await stageFaultRefresh(join(probe.output, 'fast'));
const sparse = await stageFaultRefresh(join(probe.output, 'sparse'), '*/3 * * * *');
assert.deepEqual(fast.config.d1_databases, sparse.config.d1_databases);
const fastSource = await upload(probe, fast.output, 'fault-fast'), sparseSource = await upload(probe, sparse.output, 'fault-sparse');
const session = await startVoidSession(probe, fastSource, 35);
let artifact, failure, browser;
const evidence = {}, stoppedNodes = new Set(), heldIntervals = [], unavailableReads = [];
const native = async () => JSON.parse(await probe.cli(['cron', 'info', 'refresh', '--json']));
const sql = text => cronSQL(probe, artifact, text);
const attempts = () => sql('SELECT * FROM cron_fault_attempts ORDER BY entered_at,id;');
const byPhase = async phase => (await attempts()).filter(row => row.phase === phase);
const jobs = ['advisory', 'inventory'];
const complete = rows => jobs.every(job => rows.some(row => row.job === job && row.outcome === 'success'));
const literal = value => { assert.match(value, /^[a-z0-9-]+$/); return `'${value}'`; };

async function control(policy, phase) {
  assert.ok(['healthy', 'no-retry', 'owner-loss', 'terminal'].includes(policy));
  const rows = await sql(`UPDATE cron_fault_control SET policy = ${literal(policy)}, phase = ${literal(phase)} WHERE id = 1 RETURNING *;`);
  assert.equal(rows.length, 1); assert.equal(rows[0].phase, phase); assert.equal(rows[0].policy, policy);
  return vmNow(probe);
}
async function phase(policy, name, source) {
  await session.command('pause');
  const info = await native(); assert.equal(info.paused, true); assert.equal(info.nextAlarm, null);
  await expect.poll(async () => (await attempts()).some(row => row.outcome === 'pending'), { timeout: 30000 }).toBe(false);
  if (source) artifact = (await session.command('update', { source })).artifact;
  const startedAt = await control(policy, name);
  await session.command('resume');
  return { name, policy, startedAt, artifact };
}
async function firstOccurrence(selected, timeout = 150000) {
  let rows, time;
  await expect.poll(async () => {
    rows = await byPhase(selected.name); time = rows.length ? Math.min(...rows.map(row => row.scheduled_time)) : null;
    return jobs.every(job => rows.some(row => row.job === job && row.scheduled_time === time && row.outcome !== 'pending'));
  }, { timeout, intervals: [100, 250, 500] }).toBe(true);
  assert.ok(time > selected.startedAt); assert.equal(time % 60000, 0);
  return { time, rows: rows.filter(row => row.scheduled_time === time) };
}
async function wakeFor(time, period) {
  let bucket, info;
  await expect.poll(async () => {
    bucket = await cronRecords(probe, 'refresh');
    if (!bucket.wakes.some(row => row.due_ms === time + period)) return false;
    info = await native(); return !info.paused && info.nextAlarm === time + period;
  }, { timeout: 200000, intervals: [200, 500] }).toBe(true);
  assert.ok(info.nextAlarm > await vmNow(probe)); return { bucket, info };
}
async function futureSuccess(name, time, recovering = false) {
  let rows;
  await expect.poll(async () => {
    try { rows = (await byPhase(name)).filter(row => row.scheduled_time === time); return complete(rows); }
    catch (error) { if (!recovering) throw error; unavailableReads.push({ phase: name, at: await vmNow(probe) }); return false; }
  }, { timeout: 210000, intervals: [200, 500] }).toBe(true);
  return rows;
}
async function inspectContainers(nodes) {
  const ids = (await probe.compose(['ps', '-a', '-q', ...nodes])).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, nodes.length);
  return JSON.parse(await execute('docker', ['inspect', ...ids])).map(value => ({ service: value.Config.Labels['com.docker.compose.service'], running: value.State.Running, exit: value.State.ExitCode, finishedAt: value.State.FinishedAt }));
}
async function killNodes(nodes) {
  for (const node of nodes) stoppedNodes.add(node);
  await probe.compose(['kill', '--signal', 'SIGKILL', ...nodes]);
  const state = await inspectContainers(nodes); assert.ok(state.every(row => !row.running && row.exit === 137)); return state;
}
async function restoreNodes(nodes) {
  await probe.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...nodes]);
  await expect.poll(async () => { try { const version = (await session.receipt()).dispatch.version; return (await probe.state()).every(row => row.deployment.version === version); } catch { return false; } }, { timeout: 90000 }).toBe(true);
  for (const node of nodes) stoppedNodes.delete(node);
}
async function baseline() {
  const origin = `http://refresh.localhost:${probe.env.FOGD_HTTP_PORT}`;
  const response = await refreshGateway(probe.env.FOGD_HTTP_PORT, '/api/refresh', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'healthy' }) }); assert.equal(response.status, 200);
  const selected = await phase('healthy', 'baseline'), first = await firstOccurrence(selected);
  await expect.poll(async () => complete((await byPhase('baseline')).filter(row => row.scheduled_time === first.time)), { timeout: 30000 }).toBe(true);
  browser = await chromium.launch(); const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Saved refreshes', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'inventory', exact: true })).toContainText('Saved');
  await page.screenshot({ path: join(probe.output, 'baseline.png'), fullPage: true }); assert.deepEqual(errors, []);
  await browser.close(); browser = null;
  return { ...selected, first: await byPhase('baseline'), browserErrors: errors };
}
async function noRetry() {
  const selected = await phase('no-retry', 'no-retry'), first = await firstOccurrence(selected);
  const advanced = await wakeFor(first.time, 60000);
  await control('healthy', 'no-retry-future'); const future = await futureSuccess('no-retry-future', advanced.info.nextAlarm);
  const rows = (await byPhase('no-retry')).filter(row => row.scheduled_time === first.time);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.job, row.outcome, row.no_retry_called]).sort(), [['advisory', 'thrown', 1], ['inventory', 'success', 0]]);
  return { ...selected, scheduledTime: first.time, advanced, rows, future };
}
async function ownerLoss() {
  const selected = await phase('owner-loss', 'owner-loss'), first = await firstOccurrence(selected);
  let before, info, rows, retry;
  await expect.poll(async () => {
    rows = (await byPhase('owner-loss')).filter(row => row.scheduled_time === first.time);
    if (rows.filter(row => row.job === 'advisory' && row.outcome === 'thrown').length !== 2 || rows.filter(row => row.job === 'inventory' && row.outcome === 'success').length < 2 || rows.some(row => row.outcome === 'pending')) return false;
    before = await cronRecords(probe, 'refresh'); info = await native();
    retry = before.wakes.find(row => row.due_ms === info.nextAlarm && row.due_ms < first.time + 60000 && row.due_ms > before.at + 1000);
    return Boolean(retry);
  }, { timeout: 15000, intervals: [50, 100] }).toBe(true);
  const owner = before.owner.node; assert.ok(probe.slot.nodes.includes(owner));
  const survivor = probe.slot.nodes.find(node => node !== owner), deployment = await probe.deployment(owner);
  assert.equal(deployment.cells['.cron:refresh'], deployment.generation);
  const preKillIds = new Set(rows.map(row => row.id));
  const killed = await killNodes([owner]), killedAt = await vmNow(probe); assert.ok(killedAt < retry.due_ms);
  let fresh, phaseAfter, bucket;
  await expect.poll(async () => {
    try {
      phaseAfter = await byPhase('owner-loss');
      fresh = phaseAfter.filter(row => !preKillIds.has(row.id));
      bucket = await cronRecords(probe, 'refresh');
      return jobs.every(job => fresh.some(row => row.job === job && row.scheduled_time === first.time && row.outcome === 'success')) && bucket.owner.node === survivor;
    } catch { unavailableReads.push({ phase: 'owner-loss', at: await vmNow(probe) }); return false; }
  }, { timeout: 150000, intervals: [200, 500] }).toBe(true);
  assert.ok(bucket.owner.epoch > before.owner.epoch);
  const advisory = fresh.filter(row => row.job === 'advisory');
  assert.ok(advisory.every(row => row.scheduled_time === first.time && row.cron === '* * * * *' && row.entered_at >= retry.due_ms));
  assert.ok(fresh.every(row => row.scheduled_time === first.time && row.cron === '* * * * *' && row.entered_at >= retry.due_ms));
  const recovered = advisory.find(row => row.outcome === 'success'); assert.ok(recovered);
  assert.ok(!rows.some(row => row.instance === recovered.instance));
  assert.ok(!phaseAfter.some(row => row.job === 'advisory' && row.outcome === 'success' && rows.some(old => old.instance === row.instance)));
  const observedAfterAt = await vmNow(probe);
  await restoreNodes([owner]);
  const paused = await session.command('pause'), heldAt = Date.parse(paused.dispatch.observedAt);
  await vmMinuteBoundary(probe); const end = await vmNow(probe); heldIntervals.push({ start: heldAt, end });
  return { ...selected, scheduledTime: first.time, before, retry, killed, killedAt, owner, survivor, rowsBefore: rows, after: phaseAfter, observedAfterAt, bucket, retryDelayAfterDueMs: recovered.entered_at - retry.due_ms, crossedNextMinute: recovered.entered_at >= first.time + 60000, held: { start: heldAt, end } };
}
async function terminal() {
  const selected = await phase('terminal', 'terminal', sparseSource), first = await firstOccurrence(selected, 210000);
  assert.equal(first.time % 180000, 0);
  const advanced = await wakeFor(first.time, 180000);
  await control('healthy', 'terminal-future'); const future = await futureSuccess('terminal-future', advanced.info.nextAlarm);
  const rows = (await byPhase('terminal')).filter(row => row.scheduled_time === first.time);
  for (const job of jobs) assert.equal(rows.filter(row => row.job === job).length, 6, 'Counted failures in this sparse schedule must reach the measured retry ceiling');
  assert.ok(rows.every(row => row.cron === '*/3 * * * *' && row.no_retry_called === 0 && row.outcome === (row.job === 'advisory' ? 'thrown' : 'success')));
  return { ...selected, scheduledTime: first.time, advanced, rows, future };
}
async function downtime() {
  const selected = await phase('healthy', 'downtime', fastSource), first = await firstOccurrence(selected);
  await futureSuccess('downtime', first.time); const armed = await wakeFor(first.time, 60000);
  assert.ok(armed.info.nextAlarm - await vmNow(probe) > 15000);
  const killed = await killNodes(probe.slot.nodes), downAt = Math.max(...killed.map(row => Date.parse(row.finishedAt)));
  const due = armed.info.nextAlarm; assert.ok(downAt < due);
  await vmWaitUntil(probe, due + 120000 + 2000);
  const stillStopped = await inspectContainers(probe.slot.nodes); assert.ok(stillStopped.every(row => !row.running));
  const restartRequestedAt = await vmNow(probe);
  await probe.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...probe.slot.nodes]);
  // Do not send any request to either replica during this observation window.
  // Both entry and finish must precede the first subsequent ledger request.
  const replicasStartedAt = await vmNow(probe);
  const quietUntil = await vmWaitUntil(probe, replicasStartedAt + 45000), firstReadAt = await vmNow(probe);
  const overdue = await futureSuccess('downtime', due, true);
  assert.ok(overdue.every(row => row.entered_at >= restartRequestedAt && row.entered_at < firstReadAt && row.finished_at <= firstReadAt));
  const bucket = await cronRecords(probe, 'refresh'), info = await native();
  assert.ok(!info.paused && info.nextAlarm > await vmNow(probe)); assert.ok(bucket.wakes.some(row => row.due_ms === info.nextAlarm));
  const future = await futureSuccess('downtime', info.nextAlarm), rows = await byPhase('downtime');
  const skipped = []; for (let at = due + 60000; at < restartRequestedAt; at += 60000) skipped.push(at);
  assert.ok(skipped.length >= 2); assert.ok(!rows.some(row => skipped.includes(row.scheduled_time)));
  assert.ok(!rows.some(row => row.entered_at >= downAt && row.entered_at < restartRequestedAt));
  for (const node of probe.slot.nodes) stoppedNodes.delete(node);
  return { ...selected, scheduledTime: first.time, armed, killed, downAt, due, stillStopped, restartRequestedAt, replicasStartedAt, quietUntil, firstReadAt, overdue, bucket, info, future, skipped, rows };
}
try {
  await expect.poll(async () => (await session.receipt())?.step, { timeout: 180000 }).toBe('active'); artifact = (await session.receipt()).artifact;
  for (const [name, run] of [['baseline', baseline], ['noRetry', noRetry], ['ownerLoss', ownerLoss], ['terminal', terminal], ['downtime', downtime]]) {
    evidence[name] = await run(); await probe.save(name, evidence[name]);
  }
  await session.command('pause'); const rows = await attempts();
  assert.ok(!rows.some(row => ['rejected', 'pending'].includes(row.outcome)), 'Every recorded native entry must have a known, valid outcome');
  assert.ok(rows.every(row => Number.isSafeInteger(row.scheduled_time) && row.scheduled_time % 60000 === 0 && row.entered_at >= row.scheduled_time));
  const previousIds = new Set(evidence.ownerLoss.rowsBefore.map(row => row.id));
  const lateOwnerRows = rows.filter(row => row.entered_at >= evidence.ownerLoss.startedAt && row.entered_at <= evidence.ownerLoss.observedAfterAt && !previousIds.has(row.id));
  assert.ok(lateOwnerRows.every(row => row.cron === '* * * * *' && row.scheduled_time === evidence.ownerLoss.scheduledTime && row.entered_at >= evidence.ownerLoss.retry.due_ms), 'Late ledger writes must preserve owner-loss identity and retry timing');
  for (const interval of heldIntervals) assert.ok(!rows.some(row => row.entered_at >= interval.start && row.entered_at < interval.end), 'A delayed ledger write must not hide a recorded job entry during confirmed pause');
  const results = await sql('SELECT job,cron,scheduled_time,value,saved_at FROM refresh_results ORDER BY scheduled_time,job;');
  for (const [cron, time, expected] of [['* * * * *', evidence.ownerLoss.scheduledTime, jobs], ['* * * * *', evidence.noRetry.scheduledTime, ['inventory']], ['*/3 * * * *', evidence.terminal.scheduledTime, ['inventory']], ['* * * * *', evidence.downtime.due, jobs]]) {
    assert.deepEqual(results.filter(row => row.cron === cron && row.scheduled_time === time).map(row => row.job).sort(), expected);
  }
  const result = await session.finish();
  await probe.save('failures', { ...evidence, finalRows: rows, results, heldIntervals, unavailableReads, controller: result,
    scope: 'Private ordinary Void job overlays, actual native alarms, counted failures, noRetry, owner SIGKILL and three due minutes of full fleet downtime. All ordering uses the VM clock. Autonomous dispatch requires completed overdue entries before the first request after a 45-second quiet window. The ledger excludes invocations that fail before their first durable write, including process loss or unavailable storage. No cron admission, historical snapshot recovery, general callback drain or exactly-once external effects.' });
  console.log('PASS: ordinary Void native noRetry, owner-loss retry identity, sparse terminal failure and overdue dispatch after downtime');
} catch (error) { failure = error; await probe.save('failure', { message: error.message, evidence }); throw error; }
finally {
  await browser?.close();
  if (stoppedNodes.size) { try { await restoreNodes([...stoppedNodes]); } catch { console.error('Replica restoration failed; stop the disposable installation'); } }
  if (!session.terminal) { try { await session.finish(); } catch { /* Independent native pause follows. */ } }
  try { await cleanupCronProbe(probe, () => probe.cli(['cron', 'pause', 'refresh', '--json'])); }
  catch (error) { if (!failure) throw error; console.error('Cleanup failed; stop the disposable fleet and retain private evidence'); }
}
