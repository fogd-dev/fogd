import { assertPausedRoute } from './oracles.mjs';
import assert from 'node:assert/strict';
import { data, native, operation } from './data.mjs';
import { expect } from '../../guestbook-browser.mjs';
import { requireDaemonStopped, waitForController, rootState } from './client.mjs';
import { vmNow, vmWaitUntil } from '../vm-time.mjs';
import { cronRecords } from '../records.mjs';

const replicas = ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'];
export async function coldRestore(probe, expected, prepared, approvals) {
  probe.approvals = approvals;
  assert.ok(Number.isSafeInteger(prepared.beforePause.nextAlarm), 'Source snapshot must have observed an armed timer or retry');
  await requireDaemonStopped(probe);
  await probe.compose(['up', '-d', '--no-build', '--pull', 'never', 'minio', 'bucket-init', ...replicas]);
  await expect.poll(async () => Promise.all(replicas.map(async node => {
    try {
      const output = await probe.compose(['exec', '-T', node, 'node', '--input-type=module', '-e', "const r=await fetch('http://127.0.0.1:8080/.well-known/celld/health',{signal:AbortSignal.timeout(3000)});console.log(r.status);"]);
      return { node, status: Number(output.trim()) };
    } catch { return { node, status: 0 }; }
  })), { timeout: 120000 }).toEqual(replicas.map(node => ({ node, status: 200 })));
  const startedAt = await vmNow(probe), before = await data(probe);
  assert.deepEqual(before, expected, 'Fresh storage must contain exactly the stopped application state before controller startup');
  const recordsBefore = await cronRecords(probe, 'refresh');
  assert.ok(!recordsBefore.wakes.length, 'Held source must not restore an armed cron wake');
  const endedAt = await vmWaitUntil(probe, Math.max(startedAt + 62000, prepared.beforePause.nextAlarm + 2000));
  const after = await data(probe);
  assert.deepEqual(after, expected, 'Native replicas must not dispatch while the recovery controller is still stopped');
  await requireDaemonStopped(probe);
  const control = await native(probe);
  assert.equal(control.paused, true); assert.equal(control.nextAlarm, null);
  assert.equal(control.revision, prepared.observation.revision);
  return { startedAt, endedAt, durationMs: endedAt - startedAt, before, after, recordsBefore, control, controllerAndGatewayStopped: true };
}
export async function startRecovery(probe, point) {
  const before = await rootState(probe);
  await probe.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'controller', 'workerd']);
  await waitForController(probe);
  const states = {};
  for (const app of ['refresh', 'imports']) {
    const surface = app === 'refresh' ? 'dispatch' : 'delivery';
    const state = await probe.api(`/v1/apps/${app}/${surface}`); states[app] = state;
    assert.equal(state.recovery.status, 'pending'); assert.equal(state.recovery.checkError, null);
    assert.equal(state.resumeAllowed, false); assert.equal(state.observed, 'paused');
    const active = probe.approvals[app];
    assert.deepEqual(state.active, { deployment: active.deployment, digest: active.digest });
    await expect.poll(async () => {
      const response = await probe.appRequest(app, app === 'refresh' ? '/api/refresh' : '/api/imports');
      return { status: response.status, body: await response.text() };
    }, { timeout: 30000 }).toEqual({ status: 503, body: 'App activation paused' });
    const paused = await probe.appRequest(app, app === 'refresh' ? '/api/refresh' : '/api/imports'); assertPausedRoute(paused.status, await paused.text());
    const { csrf } = await probe.api('/v1/admin');
    await assert.rejects(probe.api(`/v1/apps/${app}/${surface}/resume`, { method: 'POST', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ deployment: active.deployment, digest: active.digest }) }), /Resume requires a completed activation/);
    await assert.rejects(operation(probe, app, 'resume'));
    assert.equal(state.recovery.id, before.apps[app][surface === 'dispatch' ? 'cronRecovery' : 'queueRecovery'].id);
  }
  await verifyHeld(probe, point);
  const initialized = await rootState(probe);
  for (const app of ['refresh', 'imports']) assert.equal(initialized.deployments[initialized.apps[app].active].secretRevision, probe.approvals[app].secretRevision);
  await privacy(probe, states);
  return states;
}
async function privacy(probe, states) {
  const root = await rootState(probe), active = root.deployments[root.apps.refresh.active];
  const page = await fetch(probe.env.FOGD_SERVER, { headers: { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` } });
  assert.equal(page.status, 200);
  const visible = JSON.stringify({ states, admin: await probe.api('/v1/admin'), page: await page.text() });
  assert.ok(!visible.includes(active.version), 'Private materialized version leaked in native recovery surfaces');
  const safe = await probe.compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', `import{Secrets}from'./packages/platform/src/secrets.mjs';import{readFile}from'node:fs/promises';const s=JSON.parse(await readFile('/var/lib/fogd/state.json','utf8'));const secrets=new Secrets('/var/lib/fogd');const selected=await secrets.select(s.deployments[s.apps.refresh.active],${JSON.stringify(active.secretRevision)});console.log(JSON.stringify(!Object.values(selected.values).some(value=>${JSON.stringify(visible)}.includes(value))));`]);
  assert.equal(JSON.parse(safe), true, 'Private secret leaked in native recovery surfaces');
}
export async function acknowledge(probe, states, point) {
  const receipts = {};
  for (const app of ['refresh', 'imports']) {
    const active = probe.approvals[app], recovery = states[app].recovery;
    const args = app === 'refresh' ? ['admin', 'dispatch', app, 'recover'] : ['admin', 'recover', app];
    receipts[app] = JSON.parse(await probe.command([...args, active.deployment, active.digest, recovery.id, recovery.review, '--accept-possible-loss']));
    assert.equal(receipts[app].recovery.status, 'acknowledged'); assert.equal(receipts[app].desired, 'paused');
  }
  await verifyHeld(probe, point);
  assert.equal((await probe.appRequest('refresh', '/api/refresh')).status, 200);
  assert.equal((await probe.appRequest('imports', '/api/imports')).status, 200);
  const startedAt = await vmNow(probe);
  const endedAt = await vmWaitUntil(probe, startedAt + 62000);
  const held = await verifyHeld(probe, point);
  return { receipts, runningHold: { startedAt, endedAt, durationMs: endedAt - startedAt, control: held } };
}
async function verifyHeld(probe, point) {
  assert.deepEqual(await data(probe), point.before, 'Controller startup or acknowledgment dispatched work before separate resume');
  const control = await native(probe);
  assert.equal(control.paused, true); assert.equal(control.nextAlarm, null);
  assert.equal(control.revision, point.prepared.observation.revision);
  assert.deepEqual((await cronRecords(probe, 'refresh')).wakes, []);
  return control;
}

