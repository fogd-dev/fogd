import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { retiredAuthorityRefusals } from './retirement-authority.mjs';
import { assertFreshCron } from './retirement-cron-state.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { privateFaultProject } from './background-fixtures.mjs';
import { controllerState, nativeObservation, vmTime } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { expectRefusal } from './evidence.mjs';

export async function secondCron(host, fixture, held, evidence) {
  fixture.secrets = [randomBytes(32).toString('hex')]; assert.notEqual(fixture.secrets[0], fixture.secret);
  fixture.tokens['scheduled-next'] = (await host.json(['admin', 'issue-token', 'second-cron-builder', 'scheduled-next'])).token;
  const project = await privateFaultProject(host, 'second-cron-source', '* * * * *');
  const submitted = await host.json(['deploy', '--name', 'scheduled-next'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens['scheduled-next'] }, cwd: project });
  assert.equal(submitted.status, 'pending');
  evidence.secondCronRefusals = await retiredAuthorityRefusals(host, held.request, fixture.approvals.imports, fixture.tokens.imports, submitted);
  evidence.missingSecondSecret = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest], /Approval requires an explicit secret revision/);
  evidence.missingSecondConfiguration = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest, fixture.approvals.refresh.secretRevision], /Select the current secret revision/);
  const revision = (await host.json(['admin', 'secrets', submitted.app], { inputText: JSON.stringify({ REFRESH_TOKEN: fixture.secrets[0] }) })).revision;
  assert.notEqual(revision, fixture.approvals.refresh.secretRevision);
  evidence.oldSecondRevision = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest, fixture.approvals.refresh.secretRevision], /Select the current secret revision/);
  while (await vmTime(host) % 60000 > 10000) await delay(1000);
  const approvalStartedAt = await vmTime(host);
  await host.command(['admin', 'approve', submitted.id, submitted.digest, revision]);
  const paused = await host.json(['admin', 'dispatch', submitted.app, 'pause']); assert.equal(paused.observed, 'paused');
  const approvalPausedAt = await vmTime(host), state = await controllerState(host), app = state.apps[submitted.app], active = state.deployments[app.active];
  assert.equal(app.active, submitted.id); assert.equal(active.digest, submitted.digest); assert.equal(active.secretRevision, revision);
  const survivor = { ...submitted, slot: app.slot, secretRevision: revision, version: active.version };
  assert.equal(Math.floor(approvalStartedAt / 60000), Math.floor(approvalPausedAt / 60000));
  assert.equal(survivor.slot, host.retirement.previous.slot); assert.notEqual(fixture.approvals.refresh.slot, survivor.slot); assert.notEqual(fixture.approvals.refresh.secretRevision, survivor.secretRevision);
  const fresh = await nativeObservation(host, survivor.slot, survivor.id, { persistedRecords: true, captureProofs: true });
  evidence.secondCron = { active: survivor, fresh, keys: verifiedObservationKeys(host.policy, survivor.slot, fresh), approvalStartedAt, approvalPausedAt };
  assertFreshCron(fresh); assert.deepEqual(evidence.secondCron.keys, evidence.held.warmKeys[survivor.slot]);
  assert.deepEqual(await nativeProcesses(host), host.nativeBaseline);
  return survivor;
}
