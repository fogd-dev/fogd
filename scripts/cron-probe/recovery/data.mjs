import assert from 'node:assert/strict';
import { expect } from '../../guestbook-browser.mjs';
import { vmNow, vmWaitUntil } from '../vm-time.mjs';
import { cronRecords } from '../records.mjs';

export async function sql(probe, app, statement) {
  const selected = probe.approvals[app], slot = probe.slots.find(value => value.id === selected.slot);
  const text = await probe.cli(['d1', 'execute', app === 'refresh' ? 'refresh-db' : 'imports-db', '--command', statement, `/var/lib/fogd/artifacts/${selected.deployment}`, '--json'], slot);
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function data(probe) {
  return {
    settings: await sql(probe, 'refresh', 'SELECT * FROM refresh_settings ORDER BY id;'),
    faultControl: await sql(probe, 'refresh', 'SELECT * FROM cron_fault_control ORDER BY id;'),
    attempts: await sql(probe, 'refresh', 'SELECT * FROM cron_fault_attempts ORDER BY entered_at,id;'),
    results: await sql(probe, 'refresh', 'SELECT * FROM refresh_results ORDER BY job,cron,scheduled_time;'),
    occurrences: await sql(probe, 'refresh', 'SELECT * FROM refresh_occurrences ORDER BY job,cron,scheduled_time;'),
    imports: await sql(probe, 'imports', 'SELECT * FROM import_jobs ORDER BY id;'),
    imported: await sql(probe, 'imports', 'SELECT * FROM import_results ORDER BY job_id,position;'),
  };
}
export async function policy(probe, selected, phase) {
  assert.ok(['healthy', 'terminal'].includes(selected)); assert.match(phase, /^[a-z0-9-]+$/);
  await sql(probe, 'refresh', `UPDATE refresh_settings SET mode = 'healthy'; UPDATE cron_fault_control SET policy = '${selected}', phase = '${phase}' WHERE id = 1;`);
  return vmNow(probe);
}
export async function operation(probe, app, action) {
  const surface = app === 'refresh' ? 'dispatch' : 'delivery';
  const args = ['admin', surface, app, action];
  if (action === 'resume') { const active = probe.approvals[app]; args.push(active.deployment, active.digest); }
  return JSON.parse(await probe.command(args));
}
export async function resumeScheduled(probe) {
  const now = await vmNow(probe), minute = Math.floor(now / 60000) * 60000;
  // Keep the command away from a minute boundary so an intervening missed
  // tick cannot be mistaken for work scheduled after the actual release.
  if (now - minute > 40000) await vmWaitUntil(probe, minute + 65000);
  else if (now - minute < 3000) await vmWaitUntil(probe, minute + 3000);
  const requestedAt = await vmNow(probe);
  await operation(probe, 'refresh', 'resume');
  const confirmedAt = await vmNow(probe), control = await native(probe);
  assert.equal(Math.floor(confirmedAt / 60000), Math.floor(requestedAt / 60000), 'Resume must complete within the selected minute');
  assert.equal(control.paused, false); assert.ok(control.nextAlarm > confirmedAt);
  return { requestedAt, confirmedAt, control };
}
export async function native(probe) { return JSON.parse(await probe.cli(['cron', 'info', 'refresh', '--json'])); }
export async function importJob(probe, id, text) {
  const response = await probe.appRequest('imports', '/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) });
  assert.equal(response.status, 202);
  return response.json();
}
export async function completedImport(probe, id) {
  let value;
  await expect.poll(async () => { const response = await probe.appRequest('imports', `/api/imports?id=${id}`); assert.equal(response.status, 200); value = await response.json(); return value.status; }, { timeout: 90000 }).toBe('complete');
  return value;
}
export async function freshResult(probe, phase) {
  assert.match(phase, /^[a-z0-9-]+$/);
  let rows;
  await expect.poll(async () => {
    rows = await sql(probe, 'refresh', `SELECT * FROM cron_fault_attempts WHERE phase = '${phase}' ORDER BY entered_at,id;`);
    return ['inventory', 'advisory'].every(job => rows.some(row => row.job === job && row.outcome === 'success'));
  }, { timeout: 150000, intervals: [250, 500] }).toBe(true);
  assert.ok(rows.every(row => row.cron === '* * * * *' && Number.isSafeInteger(row.scheduled_time) && row.scheduled_time % 60000 === 0 && row.entered_at >= row.scheduled_time));
  return rows;
}
export async function pendingRetry(probe) {
  let rows, allRows, control, records, retry;
  await expect.poll(async () => {
    rows = await sql(probe, 'refresh', "SELECT * FROM cron_fault_attempts WHERE phase = 'retry-b' ORDER BY entered_at,id;");
    allRows = rows;
    if (!rows.length) return false;
    const time = Math.max(...rows.map(row => row.scheduled_time));
    rows = rows.filter(row => row.scheduled_time === time);
    if (rows.some(row => row.outcome === 'pending') || rows.filter(row => row.job === 'advisory' && row.outcome === 'thrown').length < 3) return false;
    records = await cronRecords(probe, 'refresh'); control = await native(probe);
    retry = records.wakes.find(row => row.due_ms === control.nextAlarm && row.due_ms < time + 60000 && row.due_ms > records.at + 10000);
    return Boolean(retry);
  }, { timeout: 150000, intervals: [200, 500] }).toBe(true);
  return { rows, allRows, control, records, retry, observedAt: await vmNow(probe) };
}
