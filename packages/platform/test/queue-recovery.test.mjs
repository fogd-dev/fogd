import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/queue-controller.mjs';
import { operateDelivery, deliveryView } from '../src/admin-delivery.mjs';
import { queueRecoveryCapability, assertSnapshotAge, validateQueueObservation } from '../src/queue-snapshot.mjs';
import { recoveryReview } from '../src/queue-recovery.mjs';
import { adminState } from '../src/admin-view.mjs';

async function prepared(t) {
  const f = await fixture(t), request = await f.request();
  await f.c.mutate(request.id, request.digest, 'approve');
  const at = Date.now() - 1000;
  let observation = { paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: at };
  f.backend.queues.snapshot = async () => structuredClone(observation);
  f.backend.queues.status = f.backend.queues.snapshot;
  const input = { deployment: request.id, digest: request.digest };
  await operateDelivery(f.c, 'imports', 'snapshot', input);
  const receipt = structuredClone(f.c.state.apps.imports.queueSnapshot);
  return { ...f, input, receipt, observation: value => { observation = value; } };
}
async function restored(f, alter = () => {}) {
  const app = f.c.state.apps.imports;
  f.c.state.requirements.push(queueRecoveryCapability);
  app.queueRecovery = { id: randomUUID(), status: 'pending', snapshot: 'a'.repeat(64), prepared: f.receipt };
  delete app.queueSnapshot; app.route = 'paused'; alter(app.queueRecovery);
  await f.c.save(); const c = f.create(); await c.init(); return c;
}

test('snapshot records approved paused generation and invalidates evidence on every delivery operation', async t => {
  const f = await prepared(t), app = f.c.state.apps.imports;
  assert.equal(app.delivery.desired, 'paused'); assert.equal(f.paused(), true);
  assert.equal(f.receipt.deployment, f.input.deployment);
  assertSnapshotAge(f.receipt, f.receipt.at);
  assert.throws(() => assertSnapshotAge(f.receipt, f.receipt.expiresAt), /expired/);
  assert.throws(() => assertSnapshotAge(f.receipt, f.receipt.at - 60001), /clock/);
  assert.throws(() => validateQueueObservation({ ...f.receipt.observation, stored: 2 }, f.receipt.at), /expired or unsettled/);
  await operateDelivery(f.c, 'imports', 'observe'); assert.equal(app.queueSnapshot, undefined);
  await assert.rejects(operateDelivery(f.c, 'imports', 'snapshot', { ...f.input, digest: 'b'.repeat(64) }), /changed/);
});

test('restored queues require explicit acknowledgment before routing, resume, or another approval', async t => {
  const f = await prepared(t), c = await restored(f), app = c.state.apps.imports;
  assert.equal(app.route, 'paused'); assert.equal(app.queueRecovery.diagnosis, null);
  assert.equal(deliveryView(c, 'imports').resumeAllowed, false);
  await assert.rejects(operateDelivery(c, 'imports', 'resume', f.input), /Resume requires/);
  const request = await f.request(c);
  await assert.rejects(c.mutate(request.id, request.digest, 'approve'), /Acknowledge restored queue recovery/);
  const ack = { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true };
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', { ...ack, recovery: randomUUID() }), /current recovery/);
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', { ...ack, acceptPossibleLoss: false }), /explicitly/);
  const before = f.events.filter(v => v === 'resume').length;
  await operateDelivery(c, 'imports', 'acknowledge-recovery', ack);
  assert.equal(app.route, 'active'); assert.equal(app.delivery.desired, 'paused');
  assert.equal(f.events.filter(v => v === 'resume').length, before);
  await operateDelivery(c, 'imports', 'resume', f.input); assert.equal(f.paused(), false);
  const again = f.create(); await again.init(); assert.equal(again.state.apps.imports.queueRecovery.status, 'acknowledged');
});

test('lower restored backlog retains a recovery diagnosis through pause and explicit loss acknowledgment', async t => {
  const f = await prepared(t);
  f.observation({ paused: true, stored: 0, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null });
  const c = await restored(f), app = c.state.apps.imports;
  assert.match(app.queueRecovery.diagnosis, /Possible message expiration/);
  await operateDelivery(c, 'imports', 'pause'); assert.match(app.queueRecovery.diagnosis, /Possible/);
  await operateDelivery(c, 'imports', 'acknowledge-recovery', { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true });
  assert.match(app.queueRecovery.diagnosis, /Possible/);
  const encoded = JSON.stringify(adminState(c));
  assert.ok(!encoded.includes('"prepared"')); assert.ok(!encoded.includes('"queueSnapshot"'));
});

test('runtime unavailability keeps restored HTTP and delivery paused and acknowledgment retryable', async t => {
  const f = await prepared(t), snapshot = f.backend.queues.snapshot;
  f.backend.queues.snapshot = async () => { throw Object.assign(Error('private endpoint'), { code: 'QUEUE_SNAPSHOT_UNCONFIRMED' }); };
  const c = await restored(f), app = c.state.apps.imports;
  assert.match(app.queueRecovery.checkError, /unavailable/);
  assert.equal(app.queueRecovery.diagnosis, undefined);
  assert.ok(!app.queueRecovery.checkError.includes('private endpoint'));
  const input = { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true };
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', input));
  assert.equal(app.queueRecovery.status, 'pending'); assert.equal(app.route, 'paused');
  f.backend.queues.snapshot = snapshot;
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', input), /findings changed/);
  assert.equal(app.queueRecovery.checkError, null);
  await operateDelivery(c, 'imports', 'acknowledge-recovery', { ...input, review: recoveryReview(app.queueRecovery) });
  assert.equal(app.queueRecovery.status, 'acknowledged');
});

test('delayed startup records expiration permanently even when the clock later returns within the bound', async t => {
  const f = await prepared(t);
  const original = f.create;
  f.create = () => { const c = original(); c.clock = () => f.receipt.expiresAt; return c; };
  const c = await restored(f), app = c.state.apps.imports;
  assert.match(app.queueRecovery.diagnosis, /Possible message expiration/);
  const first = structuredClone(app.queueRecovery.firstObservation);
  c.clock = () => f.receipt.completedAt;
  await operateDelivery(c, 'imports', 'acknowledge-recovery', { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true });
  assert.match(app.queueRecovery.diagnosis, /Possible message expiration/);
  assert.deepEqual(app.queueRecovery.firstObservation, first);
});

test('acknowledged historical receipts do not prevent startup after a runtime contract change', async t => {
  const f = await prepared(t), c = await restored(f), app = c.state.apps.imports;
  await operateDelivery(c, 'imports', 'acknowledge-recovery', { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true });
  app.queueRecovery.prepared.contract = { ...app.queueRecovery.prepared.contract, runtime: 'historical runtime' };
  await c.save(); const again = f.create(); await again.init();
  assert.equal(again.state.apps.imports.queueRecovery.status, 'acknowledged');
});

test('ambiguous acknowledgment writes stop effects and reload the committed recovery decision', async t => {
  for (const boundary of ['before', 'after']) await t.test(boundary, async t => {
    const f = await prepared(t), c = await restored(f), app = c.state.apps.imports;
    f.failWrite(state => state.apps?.imports?.queueRecovery?.status === 'acknowledged' ? boundary : null);
    const input = { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true };
    await assert.rejects(c.exclusive(() => operateDelivery(c, 'imports', 'acknowledge-recovery', input)), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    const effects = f.events.length;
    await assert.rejects(c.exclusive(() => operateDelivery(c, 'imports', 'resume', f.input)), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    assert.equal(f.events.length, effects); assert.equal(c.route('imports.localhost').state, 'paused');
    f.failWrite(null); const reloaded = f.create(); await reloaded.init();
    assert.equal(reloaded.state.apps.imports.queueRecovery.status, boundary === 'before' ? 'pending' : 'acknowledged');
    assert.equal(f.paused(), true);
  });
});

test('acknowledgment cannot accept newly discovered expiry or findings the caller has not inspected', async t => {
  const f = await prepared(t), c = await restored(f), app = c.state.apps.imports;
  const input = { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true };
  c.clock = () => f.receipt.expiresAt;
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', input), /findings changed/);
  assert.equal(app.queueRecovery.status, 'pending'); assert.match(app.queueRecovery.diagnosis, /Possible/);
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', input), /findings changed/);
  await operateDelivery(c, 'imports', 'acknowledge-recovery', { ...input, review: recoveryReview(app.queueRecovery) });
  assert.equal(app.queueRecovery.status, 'acknowledged'); assert.equal(f.paused(), true);
});

test('startup refuses missing recovery capability or running intent under a pending receipt', async t => {
  for (const problem of ['capability', 'running']) await t.test(problem, async t => {
    const f = await prepared(t);
    await assert.rejects(restored(f, () => {
      if (problem === 'capability') f.c.state.requirements = f.c.state.requirements.filter(value => value !== queueRecoveryCapability);
      else f.c.state.apps.imports.delivery.desired = 'running';
    }), /Invalid restored queue recovery state|remain operator paused/);
  });
});

test('acknowledgment binds changed queue metrics even when the possible-loss finding already exists', async t => {
  const f = await prepared(t);
  f.observation({ paused: true, stored: 0, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null });
  const c = await restored(f), app = c.state.apps.imports;
  const input = { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true };
  f.observation(f.receipt.observation);
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', input), /findings changed/);
  assert.equal(app.queueRecovery.status, 'pending');
  assert.notEqual(recoveryReview(app.queueRecovery), input.review);
});

test('recovery retries unconfirmed startup pause after replicas become available without resuming', async t => {
  const f = await prepared(t); f.fail('pause');
  const c = await restored(f), app = c.state.apps.imports;
  assert.equal(app.delivery.operation, 'pause');
  const input = { ...f.input, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true };
  await assert.rejects(operateDelivery(c, 'imports', 'acknowledge-recovery', input), /findings changed/);
  assert.equal(app.delivery.operation, null); assert.equal(app.queueRecovery.status, 'pending');
  await operateDelivery(c, 'imports', 'acknowledge-recovery', { ...input, review: recoveryReview(app.queueRecovery) });
  assert.equal(app.queueRecovery.status, 'acknowledged'); assert.equal(f.paused(), true);
});
