import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { privateFaultProject } from './background-fixtures.mjs';
import { controllerState, nativeObservation, vmTime } from './observations.mjs';
import { rows } from './recovery-ledger.mjs';
import { expectRefusal } from './evidence.mjs';
import { scopedClient } from './https.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { nativeProcesses } from './recovery-fence.mjs';

export async function scheduledReplacement(host, fixture, request, warmKeys) {
  const app = 'scheduled-next', old = fixture.approvals.refresh;
  assert.equal(host.retiredApp, old.app);
  const token = (await host.json(['admin', 'issue-token', 'scheduled-replacement-builder', app])).token; fixture.tokens[app] = token;
  const project = await privateFaultProject(host, 'scheduled-next-source', '*/3 * * * *');
  const submitted = await host.json(['deploy', '--name', app], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project });
  assert.equal(submitted.status, 'pending');
  const missingSecret = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest], /Approval requires an explicit secret revision/);
  const missingConfiguration = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest, old.secretRevision], /Select the current secret revision/);
  const secret = randomBytes(32).toString('hex'); assert.notEqual(secret, fixture.secret); fixture.secrets ||= []; fixture.secrets.push(secret);
  const revision = (await host.json(['admin', 'secrets', app], { inputText: JSON.stringify({ REFRESH_TOKEN: secret }) })).revision;
  assert.notEqual(revision, old.secretRevision);
  const before = await controllerState(host); assert.equal(before.apps[app], undefined);
  const oldRevision = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest, old.secretRevision], /Select the current secret revision/);
  const retiredToken = await expectRefusal(host, ['admin', 'issue-token', 'retired-cron-refusal', old.app], /permanently retired/);
  const retiredApproval = await expectRefusal(host, ['admin', 'approve', old.id, old.digest, old.secretRevision], /permanently retired/);
  const oldClient = await scopedClient(host, fixture.tokens.refresh);
  const artifact = await request(`/v1/deployments/${submitted.id}/artifact`); assert.equal(artifact.status, 200);
  const scopeRefusal = await oldClient('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: artifact.text });
  assert.equal(scopeRefusal.status, 400); assert.match(scopeRefusal.json().error, /outside its app scope/);
  const retiredArtifact = await request(`/v1/deployments/${old.id}/artifact`); assert.equal(retiredArtifact.status, 200);
  const nameRefusal = await oldClient('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: retiredArtifact.text });
  assert.equal(nameRefusal.status, 400); assert.match(nameRefusal.json().error, /permanently retired/);
  assert.deepEqual(await controllerState(host), before);
  // Leave enough of the minute to approve and confirm pause without a first tick.
  while (await vmTime(host) % 60000 > 10000) await new Promise(resolve => setTimeout(resolve, 1000));
  const requestedAt = await vmTime(host); await host.command(['admin', 'approve', submitted.id, submitted.digest, revision]);
  const paused = await host.json(['admin', 'dispatch', app, 'pause']); assert.equal(paused.observed, 'paused');
  const confirmedAt = await vmTime(host); assert.equal(Math.floor(requestedAt / 60000), Math.floor(confirmedAt / 60000));
  const state = await controllerState(host), current = state.apps[app], deployment = state.deployments[current.active];
  assert.equal(current.slot, host.retirement.previous.slot); assert.equal(deployment.id, submitted.id); assert.equal(deployment.digest, submitted.digest); assert.equal(deployment.secretRevision, revision);
  const active = { ...submitted, slot: current.slot, secretRevision: revision, version: deployment.version };
  const fresh = await nativeObservation(host, active.slot, active.id, { persistedRecords: true, captureProofs: true });
  const keys = verifiedObservationKeys(host.policy, active.slot, fresh); assert.deepEqual(keys, warmKeys[active.slot]);
  assert.deepEqual(await nativeProcesses(host), host.nativeBaseline);
  assert.equal(fresh.status.paused, true); assert.equal(fresh.status.nextAlarm, null); assert.deepEqual(fresh.cronRecords.wakes, []);
  assert.equal(fresh.databases.length, 1);
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) {
    assert.ok(Object.hasOwn(fresh.databases[0].data, table)); assert.deepEqual(rows(fresh, table), []);
  }
  assert.deepEqual(rows(fresh, 'refresh_settings'), [{ id: 1, mode: 'retry-once' }]);
  assert.deepEqual(rows(fresh, 'cron_fault_control'), [{ id: 1, policy: 'healthy', phase: 'startup' }]);
  return { active, fresh, keys, requestedAt, confirmedAt, missingSecret, missingConfiguration, oldRevision, retiredToken, retiredApproval, scopeRefusal: scopeRefusal.json(), nameRefusal: nameRefusal.json(), distinctSecretValues: true };
}

export function assertNewSchedule(observed, since) {
  assert.equal(observed.databases.length, 1);
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) {
    assert.ok(Object.hasOwn(observed.databases[0].data, table));
    assert.ok(rows(observed, table).length > 0);
    assert.ok(rows(observed, table).every(row => row.scheduled_time > since && row.scheduled_time % 180000 === 0 && row.cron === '*/3 * * * *'));
  }
}
