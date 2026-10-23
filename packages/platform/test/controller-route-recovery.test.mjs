import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixture as queueFixture } from './fixtures/queue-controller.mjs';
import { fixture as cronFixture } from './fixtures/cron-controller.mjs';
import { authorityFixture } from './fixtures/route-authority.mjs';
import { operateDelivery } from '../src/admin-delivery.mjs';
import { operateDispatch } from '../src/admin-dispatch.mjs';
import { queueRecoveryCapability } from '../src/queue-snapshot.mjs';
import { cronRecoveryCapability } from '../src/cron-snapshot.mjs';
import { recoveryReview } from '../src/recovery-review.mjs';

for (const [name, fixture, operate, capability, snapshotField, recoveryField, appName] of [
  ['queue', queueFixture, operateDelivery, queueRecoveryCapability, 'queueSnapshot', 'queueRecovery', 'imports'],
  ['cron', cronFixture, operateDispatch, cronRecoveryCapability, 'cronSnapshot', 'cronRecovery', 'refresh'],
]) test(`${name} snapshot retains active HTTP and restored recovery requires verified republication`, async t => {
  let verifications = 0;
  const authority = await authorityFixture(t, async () => { verifications++; });
  const f = await fixture(t, { routeAuthority: authority.options, clock: () => 100000 });
  const request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  if (name === 'queue') f.backend.queues.snapshot = async () => ({ paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: 90000 });
  const input = { deployment: request.id, digest: request.digest };
  await operate(f.c, appName, 'snapshot', input);
  assert.equal((await authority.record()).routes[0].state, 'active');
  const app = f.c.state.apps[appName];
  app[recoveryField] = { id: randomUUID(), status: 'pending', snapshot: 'b'.repeat(64), prepared: structuredClone(app[snapshotField]) };
  delete app[snapshotField]; f.c.state.requirements.push(capability); app.route = 'paused'; await f.c.save();
  const restored = f.create(); await restored.init();
  assert.equal((await authority.record()).routes[0].state, 'withheld');
  const receipt = restored.state.apps[appName][recoveryField];
  await operate(restored, appName, 'acknowledge-recovery', { ...input, recovery: receipt.id, review: recoveryReview(receipt), acceptPossibleLoss: true });
  assert.equal(verifications, 1); assert.equal((await authority.record()).routes[0].submission, request.id);
  assert.equal(receipt.status, 'acknowledged');
});

for (const [name, fixture, operate, appName] of [['queue', queueFixture, operateDelivery, 'imports'], ['cron', cronFixture, operateDispatch, 'refresh']]) {
  test(`${name} snapshot refuses a missing authority file before any native operation`, async t => {
    const authority = await authorityFixture(t), f = await fixture(t, { routeAuthority: authority.options });
    const request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
    const before = name === 'queue' ? [...f.events] : (await f.runtime()).events;
    await rm(authority.options.path);
    await assert.rejects(operate(f.c, appName, 'snapshot', { deployment: request.id, digest: request.digest }), /uncertain/);
    assert.deepEqual(name === 'queue' ? f.events : (await f.runtime()).events, before);
  });
  test(`${name} snapshot requires public serving permission rather than a desired active field`, async t => {
    const authority = await authorityFixture(t), f = await fixture(t, { routeAuthority: authority.options });
    const request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
    await f.c.decideRoute(appName, 'pause', { deployment: request.id, digest: request.digest });
    f.c.state.apps[appName].route = 'active'; await f.c.save();
    const before = name === 'queue' ? [...f.events] : (await f.runtime()).events;
    await assert.rejects(operate(f.c, appName, 'snapshot', { deployment: request.id, digest: request.digest }), /active public HTTP/);
    assert.deepEqual(name === 'queue' ? f.events : (await f.runtime()).events, before);
  });
}
