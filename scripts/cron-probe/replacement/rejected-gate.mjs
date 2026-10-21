import assert from 'node:assert/strict';
import { expect } from '../../guestbook-browser.mjs';
import { cleanupRelease } from '../release/cleanup.mjs';
import { requireIdleHost } from '../activation/processes.mjs';

export async function rejectedPublicationGate(probe, session) {
  let before, approved, finalId, heldAt, pendingGate, failure, expectedRejection = false;
  try {
    await expect.poll(async () => (await session.receipt())?.step, { timeout: 180000 }).toBe('active');
    const newId = await session.send('update', { release: 'new' });
    await expect.poll(async () => (await session.receipt())?.step, { timeout: 15000 }).toBe('update-held');
    pendingGate = newId;
    await session.releaseUpdate(newId); pendingGate = null;
    await expect.poll(async () => (await session.receipt())?.command?.id, { timeout: 120000 }).toBe(newId);
    before = await probe.state(); approved = await session.receipt();
    finalId = await session.send('update', { release: 'final' });
    await expect.poll(async () => (await session.receipt())?.step, { timeout: 15000 }).toBe('update-held');
    const held = await session.receipt(); assert.equal(held.updateGate.point, 'before-publication');
    assert.equal(held.updateGate.id, finalId);
    // Exercise lost host gate knowledge: cleanup must discover the held broker.
    pendingGate = undefined;
    heldAt = Number(await probe.node('console.log(Date.now())'));
    expectedRejection = true;
  } catch (error) { failure = error; throw error; }
  finally { await cleanupRelease({ probe, session, pendingGate, failure: failure || Error('Deliberately rejected observation'), expectedRejection }); }
  assert.equal(session.exitCode, 1, 'A rejected gate must fail the broker without killing or approving it');
  const failed = await session.rawReceipt(); assert.equal(failed.step, 'failed'); assert.equal(failed.cleanupFailure, undefined);
  assert.equal(failed.updateLifecycle.gateReleasedAt, undefined);
  assert.equal(failed.updateGate.id, finalId);
  assert.equal(failed.updateGate.deadline - failed.updateGate.at, 20000);
  assert.ok(failed.updateLifecycle.gateTimedOutAt >= failed.updateGate.deadline, 'Broker must record expiration of the actual gate deadline');
  assert.ok(heldAt < failed.updateGate.deadline, 'Cleanup must begin while the gate is still held');
  await requireIdleHost(probe);
  const after = await probe.state();
  const versions = rows => rows.map(row => ({ host: row.host, version: row.deployment.version, generation: row.deployment.generation }));
  assert.deepEqual(versions(after), versions(before), 'Failed gate must not publish another native version');
  const state = JSON.parse(await probe.node("import{readFile}from'node:fs/promises';console.log(await readFile('/var/lib/fogd/state.json','utf8'));"));
  const app = state.apps.refresh, active = state.deployments[app.active], unfinished = state.deployments[app.dispatch.hold];
  assert.equal(active.digest, approved.digest); assert.equal(active.status, 'active');
  assert.equal(unfinished.status, 'failed'); assert.equal(app.dispatch.desired, 'paused'); assert.equal(app.dispatch.observed, 'paused'); assert.equal(app.dispatch.operation, null);
  const native = JSON.parse(await probe.cli(['cron', 'info', 'refresh', '--json'])); assert.equal(native.paused, true); assert.equal(native.nextAlarm, null);
  const releaseFileAbsent = await probe.node(`import{access}from'node:fs/promises';try{await access(${JSON.stringify('/var/lib/fogd/qualification/session/update-release.json')});console.log('false')}catch(error){if(error.code!=='ENOENT')throw error;console.log('true')}`);
  assert.equal(releaseFileAbsent.trim(), 'true');
  return { expectedBrokerExitCode: session.exitCode, cleanupGateHintOmitted: true, heldAt, broker: failed, before, after, native,
    active: { deployment: active.id, digest: active.digest, secretRevision: active.secretRevision },
    failedApproval: { deployment: unfinished.id, digest: unfinished.digest, secretRevision: unfinished.secretRevision }, desired: app.dispatch.desired, releaseFileAbsent: true };
}
