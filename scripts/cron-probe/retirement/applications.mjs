import assert from 'node:assert/strict';
import { expect } from '../../guestbook-browser.mjs';
import { vmNow, vmWaitUntil } from '../vm-time.mjs';
import { rootState } from '../recovery/client.mjs';

export async function selectApps(probe) {
  const state = await rootState(probe);
  probe.backgroundApps = {}; probe.approvals = {}; probe.databases = {};
  for (const [name, app] of Object.entries(state.apps)) {
    if (app.retirement) continue;
    const active = state.deployments[app.active];
    assert.equal(active.resources.d1.length, 1, 'The native fixture requires one declared D1 database per live app');
    probe.databases[name] = active.resources.d1[0].database_name;
    probe.backgroundApps[name] = app.resources.crons ? 'dispatch' : 'delivery';
    probe.approvals[name] = { slot: app.slot, deployment: active.id, digest: active.digest, secretRevision: active.secretRevision ?? null, version: active.version };
  }
  return state;
}
export async function query(probe, name, statement) {
  const active = probe.approvals[name], slot = probe.slots.find(value => value.id === active.slot);
  const database = probe.databases[name]; assert.equal(typeof database, 'string'); assert.ok(database.length > 0);
  const text = await probe.cli(['d1', 'execute', database, '--command', statement, `/var/lib/fogd/artifacts/${active.deployment}`, '--json'], slot);
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function appData(probe) {
  const rows = {};
  for (const [name, family] of Object.entries(probe.backgroundApps)) {
    const tables = family === 'dispatch' ? ['refresh_settings', 'cron_fault_control', 'cron_fault_attempts', 'refresh_results', 'refresh_occurrences'] : ['import_jobs', 'import_results'];
    rows[name] = {};
    for (const table of tables) rows[name][table] = await query(probe, name, `SELECT * FROM ${table} ORDER BY rowid;`);
  }
  return rows;
}
export async function operate(probe, name, action) {
  const args = ['admin', probe.backgroundApps[name], name, action];
  if (action === 'resume') { const active = probe.approvals[name]; args.push(active.deployment, active.digest); }
  return JSON.parse(await probe.command(args));
}
export async function control(probe, name) {
  const slot = probe.slots.find(value => value.id === probe.approvals[name].slot);
  return JSON.parse(await probe.cli(['cron', 'info', name, '--json'], slot));
}
export async function replicaStates(probe, slot) {
  return Promise.all(slot.nodes.map(async node => {
    const output = await probe.compose(['exec', '-T', node, 'node', '--input-type=module', '-e', "const response=await fetch('http://127.0.0.1:8081/state',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Replica metadata unavailable');console.log(JSON.stringify((await response.json()).deployment??null));"]);
    return { node, deployment: JSON.parse(output) };
  }));
}
export async function healthy(probe, name, phase) {
  assert.match(phase, /^[a-z0-9-]+$/);
  await query(probe, name, `UPDATE refresh_settings SET mode='healthy'; UPDATE cron_fault_control SET policy='healthy',phase='${phase}' WHERE id=1;`);
}
export async function resumeCron(probe, name) {
  const now = await vmNow(probe), minute = Math.floor(now / 60000) * 60000;
  if (now - minute > 40000) await vmWaitUntil(probe, minute + 65000);
  else if (now - minute < 3000) await vmWaitUntil(probe, minute + 3000);
  const requestedAt = await vmNow(probe);
  await operate(probe, name, 'resume');
  const confirmedAt = await vmNow(probe), observed = await control(probe, name);
  assert.equal(Math.floor(confirmedAt / 60000), Math.floor(requestedAt / 60000));
  assert.equal(observed.paused, false); assert.ok(observed.nextAlarm > confirmedAt);
  return { requestedAt, confirmedAt, control: observed };
}
export async function futureCron(probe, name, phase, resume) {
  let rows;
  await expect.poll(async () => {
    rows = await query(probe, name, `SELECT * FROM cron_fault_attempts WHERE phase='${phase}' ORDER BY entered_at,id;`);
    return ['inventory', 'advisory'].every(job => rows.some(row => row.job === job && row.outcome === 'success'));
  }, { timeout: 150000, intervals: [250, 500] }).toBe(true);
  assert.ok(rows.every(row => row.scheduled_time >= resume.requestedAt && row.scheduled_time % 60000 === 0 && row.entered_at >= row.scheduled_time));
  return rows;
}
export async function submitImport(probe, name, id, text) {
  const response = await probe.appRequest(name, '/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) });
  assert.equal(response.status, 202);
  return response.json();
}
export async function completedImport(probe, name, id, expectedLabels) {
  let value;
  await expect.poll(async () => { const result = await probe.appRequest(name, `/api/imports?id=${id}`); assert.equal(result.status, 200); value = await result.json(); return value.status; }, { timeout: 90000 }).toBe('complete');
  assert.deepEqual(value.results.map(row => row.label), expectedLabels);
  return value;
}
