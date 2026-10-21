import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect } from '../../guestbook-browser.mjs';
import { rootState } from '../recovery/client.mjs';
import { vmNow, vmWaitUntil } from '../vm-time.mjs';
import { selectApps, query, operate, control, replicaStates } from './applications.mjs';
import { buildArtifact, stackRoot } from '../../../packages/cli/src/local.mjs';
import { manifest } from '../../../packages/runtime/src/manifest.mjs';

async function refusedOldScope(probe, release, credential) {
  const body = await probe.api(`/v1/deployments/${release.id}/artifact`), before = Object.keys((await probe.api('/v1/admin')).deployments).sort();
  await assert.rejects(probe.api('/v1/deployments', { method: 'POST', headers: { Authorization: `Bearer ${credential.token}` }, body: JSON.stringify(body) }), /outside its app scope/);
  const originalName = credential.apps[0], canonical = await buildArtifact(join(stackRoot, 'examples/imports'), originalName);
  const retiredBody = await manifest(canonical.outputDir, canonical);
  await assert.rejects(probe.api('/v1/deployments', { method: 'POST', headers: { Authorization: `Bearer ${credential.token}` }, body: JSON.stringify(retiredBody) }), /permanently retired/);
  assert.deepEqual(Object.keys((await probe.api('/v1/admin')).deployments).sort(), before);
}
export async function queuedReplacement(probe, credential, plan) {
  const release = await probe.submit(join(process.cwd(), 'examples/imports'), 'replacement');
  await refusedOldScope(probe, release, credential);
  assert.equal((await probe.decide(release)).status, 'active');
  await selectApps(probe); await operate(probe, 'replacement', 'pause');
  assert.equal(probe.approvals.replacement.slot, plan.previous.slot);
  assert.equal(probe.slots.find(slot => slot.id === plan.previous.slot).prefix, plan.replacement.prefix);
  assert.deepEqual(await query(probe, 'replacement', 'SELECT * FROM import_jobs;'), []);
  assert.deepEqual(await query(probe, 'replacement', 'SELECT * FROM import_results;'), []);
  const view = await probe.api('/v1/apps/replacement/delivery'), slot = probe.slots.find(value => value.id === probe.approvals.replacement.slot);
  const queue = JSON.parse(await probe.cli(['queue', 'info', view.queue, '--json'], slot));
  assert.equal(queue.backlogCount, 0); assert.equal(queue.paused, true);
  return { release, queue, reusedSlot: plan.previous.slot, oldScopedUploadRefused: true, retiredNameUploadRefused: true, emptyApplicationRows: true };
}
export async function scheduledReplacement(probe, credential, plan, defaults) {
  const command = { id: randomUUID(), operation: 'stage', app: 'scheduled-next' };
  await probe.compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', `import{saveJson}from'./packages/platform/src/store.mjs';await saveJson('/var/lib/fogd/qualification/command.json',${JSON.stringify(command)});`]);
  let staged;
  await expect.poll(async () => { staged = JSON.parse(await probe.compose(['exec', '-T', 'controller', 'cat', '/var/lib/fogd/qualification/result.json'])); return staged.id; }, { timeout: 180000 }).toBe(command.id);
  assert.equal(staged.missingSecretRefused, true); assert.equal(staged.slot, null);
  const pending = await rootState(probe); assert.equal(pending.apps['scheduled-next'], undefined);
  const release = pending.deployments[staged.deployment];
  await refusedOldScope(probe, release, credential);
  const { csrf } = await probe.api('/v1/admin');
  const secret = await probe.api('/v1/apps/scheduled-next/secrets', { method: 'PUT', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ REFRESH_TOKEN: randomBytes(32).toString('hex') }) });
  const oldRevision = pending.deployments[pending.apps.refresh.active].secretRevision;
  await assert.rejects(probe.api(`/v1/deployments/${release.id}/approve`, { method: 'POST', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ digest: release.digest, secretRevision: oldRevision }) }), /Select the current secret revision/);
  const stillPending = await rootState(probe); assert.equal(stillPending.deployments[release.id].status, 'pending'); assert.equal(stillPending.apps['scheduled-next'], undefined);
  const now = await vmNow(probe), minute = Math.floor(now / 60000) * 60000;
  if (now - minute > 15000) await vmWaitUntil(probe, minute + 64000);
  else if (now - minute < 3000) await vmWaitUntil(probe, minute + 3000);
  const requestedAt = await vmNow(probe);
  const approved = JSON.parse(await probe.command(['admin', 'approve', release.id, release.digest, secret.revision]));
  assert.equal(approved.status, 'active'); await selectApps(probe); await operate(probe, 'scheduled-next', 'pause');
  assert.equal(probe.approvals['scheduled-next'].secretRevision, secret.revision);
  assert.equal(probe.approvals['scheduled-next'].slot, plan.previous.slot);
  assert.equal(probe.slots.find(slot => slot.id === plan.previous.slot).prefix, plan.replacement.prefix);
  const confirmedAt = await vmNow(probe), approvalDurationMs = confirmedAt - requestedAt;
  assert.equal(Math.floor(requestedAt / 60000), Math.floor(confirmedAt / 60000), `Approval and confirmed pause took ${approvalDurationMs}ms`);
  for (const table of ['cron_fault_attempts', 'refresh_results', 'refresh_occurrences']) assert.deepEqual(await query(probe, 'scheduled-next', `SELECT * FROM ${table};`), []);
  for (const [table, expected] of Object.entries(defaults)) assert.deepEqual(await query(probe, 'scheduled-next', `SELECT * FROM ${table} ORDER BY id;`), expected, 'The new application inherited old seeded configuration');
  const bootstrap = JSON.parse(await probe.compose(['exec', '-T', 'controller', 'cat', '/var/lib/fogd/qualification/scheduled-next-bootstrap.json']));
  assert.deepEqual(bootstrap.control, { paused: true, revision: 0, nextAlarm: null, crons: [] });
  assert.equal(bootstrap.slot, probe.approvals['scheduled-next'].slot);
  const replicas = await replicaStates(probe, probe.slots.find(slot => slot.id === bootstrap.slot));
  assert.deepEqual(replicas.flatMap(value => Object.keys(value.deployment?.cells || {}).filter(cell => cell.startsWith('.cron:'))), ['.cron:scheduled-next']);
  await assertPrivateIsolation(probe);
  return { release: { id: release.id, digest: release.digest }, bootstrap, replicas, requestedAt, confirmedAt, approvalDurationMs, reusedSlot: plan.previous.slot, paused: await control(probe, 'scheduled-next'), missingSecretRefused: true, oldSecretRevisionRefused: true, distinctSecretValuesAndRevisions: true, emptyApplicationRows: true, freshSeededConfiguration: defaults, oldScopedUploadRefused: true, retiredNameUploadRefused: true };
}
async function assertPrivateIsolation(probe) {
  const state = await rootState(probe), visible = JSON.stringify(await probe.api('/v1/admin'));
  for (const name of ['refresh', 'scheduled-next']) {
    const version = state.deployments[state.apps[name].active].version;
    assert.equal(typeof version, 'string'); assert.ok(version.length > 0); assert.ok(!visible.includes(version));
  }
  const code = `import{Secrets}from'./packages/platform/src/secrets.mjs';import{readFile}from'node:fs/promises';const state=JSON.parse(await readFile('/var/lib/fogd/state.json','utf8')),s=new Secrets('/var/lib/fogd');const a=state.deployments[state.apps.refresh.active],b=state.deployments[state.apps['scheduled-next'].active];const old=await s.select(a,a.secretRevision),next=await s.select(b,b.secretRevision);console.log(JSON.stringify(old.revision!==next.revision&&old.values.REFRESH_TOKEN!==next.values.REFRESH_TOKEN&&![old.values.REFRESH_TOKEN,next.values.REFRESH_TOKEN].some(v=>${JSON.stringify(visible)}.includes(v))));`;
  assert.equal(JSON.parse(await probe.compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', code])), true);
}
