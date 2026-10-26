import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { routeController } from './fixtures/route-controller.mjs';
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

const database = 'alpha-db';
const create = { database, name: '0001_create.sql', digest: '6820495f6caeed60ed9816d751872cd5e4898d69f4286b1d5f8682ef9ec81114' };
const seed = { database, name: '0002_seed.sql', digest: '9cc36d2f92ec5244c5f2b3bd513b37ec49addb62f02f0b102575d20b2139efc9' };
const body = { database, name: '0003_body.sql', digest: '7ae04c0445e1b3b6565fc050b057654f35c947ac5ea23fa59dbf7143cea66075' };
// The ledger records committed names like d1_migrations; each call applies at most `limit` pending migrations.
async function migratingController(t) {
  const f = await routeController(t), ledger = [], calls = [], { migrate, applied } = f.backend;
  let declared = [], limit = Infinity;
  f.backend.migrate = async (slot, ...args) => {
    await migrate(slot, ...args); calls.push(slot.id);
    for (const m of declared.filter(m => !ledger.some(row => row.name === m.name)).slice(0, limit)) ledger.push({ database: m.database, name: m.name });
  };
  f.backend.applied = async (slot, ...args) => { await applied(slot, ...args); return slot.id === 'slot-1' ? structuredClone(ledger) : []; };
  async function release(migrations, controller = f.c) {
    const request = await f.request('alpha', controller);
    request.migrations = migrations;
    request.resources.d1 = [{ binding: 'DB', database_name: database, database_id: database, migrations_dir: 'migrations/DB' }];
    await controller.save(); declared = migrations; return request;
  }
  return { f, ledger, calls, release, limitTo: value => { limit = value; } };
}
for (const [label, next, limit, retryCalls] of [
  ['committed', [create, seed], Infinity, 0],
  ['partially committed', [create, seed, body], 1, 1],
]) test(`${label} migration with an unsaved hash ledger stays withheld and explicit retry ${retryCalls ? 'resumes' : 'skips'} backend migration`, async t => {
  const { f, ledger, calls, release, limitTo } = await migratingController(t);
  const first = await release([create]); await f.c.mutate(first.id, first.digest, 'approve');
  const peer = await f.request('beta'); await f.c.mutate(peer.id, peer.digest, 'approve');
  assert.deepEqual(calls, ['slot-1', 'slot-2']);
  const peerBefore = (await f.private()).apps.beta, peerRoute = (await f.public()).routes.find(route => route.host === 'beta.localhost');
  const update = await release(next); limitTo(limit);
  f.failPrivate((file, value) => file === f.statePath && value.apps?.alpha?.migrations?.some(m => m.name === seed.name) ? 'before' : null);
  await assert.rejects(f.c.mutate(update.id, update.digest, 'approve'), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  assert.deepEqual(ledger.map(row => row.name), [create.name, seed.name]);
  const saved = await f.private();
  assert.equal(saved.apps.alpha.uncertain, update.id); assert.deepEqual(saved.apps.alpha.migrations, [create]);
  assert.equal(saved.deployments[update.id].status, 'activating'); assert.equal(saved.deployments[update.id].step, 'migrating');
  f.failPrivate(null); limitTo(Infinity);
  const restored = f.create(); await restored.init();
  const interrupted = restored.state.deployments[update.id];
  assert.equal(interrupted.status, 'failed'); assert.match(interrupted.error, /interrupted at migrating/);
  assert.equal(restored.state.apps.alpha.uncertain, update.id);
  const routes = (await f.public()).routes;
  assert.equal(routes.find(route => route.host === 'alpha.localhost').state, 'withheld');
  assert.deepEqual(routes.find(route => route.host === 'beta.localhost'), peerRoute);
  assert.deepEqual((await f.private()).apps.beta, peerBefore);
  assert.deepEqual(calls, ['slot-1', 'slot-2', 'slot-1']);
  await restored.mutate(update.id, update.digest, 'approve');
  assert.equal(restored.state.deployments[update.id].status, 'active');
  assert.equal(calls.length, 3 + retryCalls, 'backend migration runs only for migrations missing from the committed ledger');
  assert.deepEqual(restored.state.apps.alpha.migrations, next);
  assert.equal(restored.state.apps.alpha.uncertain, null);
  const after = (await f.public()).routes;
  assert.equal(after.find(route => route.host === 'alpha.localhost').submission, update.id);
  assert.deepEqual(after.find(route => route.host === 'beta.localhost'), peerRoute);
  assert.deepEqual((await f.private()).apps.beta, peerBefore);
});
