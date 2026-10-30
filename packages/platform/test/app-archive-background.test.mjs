import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as queued } from './fixtures/queue-controller.mjs';
import { fixture as scheduled } from './fixtures/cron-controller.mjs';
import { policy } from './fixtures/runtime-policy.mjs';
import { operateDelivery } from '../src/admin-delivery.mjs';
import { operateDispatch } from '../src/admin-dispatch.mjs';
import { recoverQueueSnapshots } from '../src/queue-recovery.mjs';
import { Controller } from '../src/controller.mjs';
import { archiveApprovalFixture } from './fixtures/archive-approval.mjs';
import { recoverCronSnapshots } from '../src/cron-recovery.mjs';
import { projectAppArchive, projectAppArchiveRestore, validateAppArchives } from '../src/app-archive.mjs';

const id = '33333333-3333-4333-8333-333333333333';
function profiles() {
  const source = { ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] };
  const target = structuredClone(source);
  target.fleets[0].prefix = `archive-generations/${id}`;
  target.fleets[0].nodes = [{ host: 'slot-1-a', id: `slot-1-a-${id}` }, { host: 'slot-1-b', id: `slot-1-b-${id}` }];
  return { source, target, slots: source.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) })) };
}
function roundTrip(state, request, source, target, slot = 'slot-1') {
  const archived = projectAppArchive({ state, sourceProfile: source, profile: target, snapshot: 'a'.repeat(64), app: request.app,
    digest: request.digest, id, at: '2026-10-30T02:00:00.000Z' });
  const profile = structuredClone(target), fleet = profile.fleets.find(value => value.id === slot);
  fleet.prefix = source.fleets[0].prefix;
  fleet.nodes = fleet.nodes.map((node, index) => ({ ...node, id: source.fleets[0].nodes[index].id }));
  const restored = projectAppArchiveRestore({ state: archived, sourceProfile: target, profile, snapshot: 'b'.repeat(64),
    archive: id, expectedIdentity: archived.appArchives.records[id].identity, slot });
  return { archived, restored, profile };
}

test('queued app projection retains its paused backlog receipt behind pending archive recovery', async t => {
  const p = profiles(), f = await queued(t, { slots: p.slots, clock: () => 1000000 }), request = await f.request();
  await f.c.mutate(request.id, request.digest, 'approve');
  f.backend.queues.snapshot = async () => ({ paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: 999000 });
  await operateDelivery(f.c, 'imports', 'snapshot', { deployment: request.id, digest: request.digest });
  const before = structuredClone(f.c.state), result = roundTrip(f.c.state, request, p.source, p.target);
  assert.deepEqual(structuredClone(f.c.state), before);
  assert.deepEqual(result.archived.appArchives.records[id].app.queueSnapshot, before.apps.imports.queueSnapshot);
  assert.equal(result.restored.apps.imports.queueSnapshot, undefined);
  assert.deepEqual(result.restored.apps.imports.queueRecovery.prepared, before.apps.imports.queueSnapshot);
  assert.equal(result.restored.apps.imports.queueRecovery.status, 'pending');
  assert.equal(result.restored.apps.imports.delivery.desired, 'paused');
  assert.equal(result.restored.apps.imports.delivery.observed, 'paused');
  assert.equal(result.restored.apps.imports.archiveRecovery.status, 'pending');
  assert.equal(result.restored.apps.imports.route, 'paused');
});

test('scheduled app projection retains its paused revision and secret reference behind pending archive recovery', async t => {
  const p = profiles(), f = await scheduled(t, { slots: p.slots }), request = await f.request(f.c, { requiredSecrets: ['REFRESH_TOKEN'] });
  const secret = await f.c.replaceSecrets('refresh', { REFRESH_TOKEN: 'private-app-archive-fixture' });
  await f.c.mutate(request.id, request.digest, 'approve', secret.revision);
  await f.c.exclusive(() => operateDispatch(f.c, 'refresh', 'snapshot', { deployment: request.id, digest: request.digest }));
  const before = structuredClone(f.c.state), result = roundTrip(f.c.state, request, p.source, p.target);
  assert.deepEqual(structuredClone(f.c.state), before);
  assert.deepEqual(result.archived.appArchives.records[id].app.cronSnapshot, before.apps.refresh.cronSnapshot);
  assert.equal(result.restored.apps.refresh.cronSnapshot, undefined);
  assert.deepEqual(result.restored.apps.refresh.cronRecovery.prepared, before.apps.refresh.cronSnapshot);
  assert.equal(result.restored.apps.refresh.cronRecovery.status, 'pending');
  assert.equal(result.restored.apps.refresh.dispatch.desired, 'paused');
  assert.equal(result.restored.apps.refresh.dispatch.observed, 'paused');
  assert.equal(result.restored.deployments[request.id].secretRevision, secret.revision);
  assert.equal(result.restored.apps.refresh.archiveRecovery.status, 'pending');
});

const families = [
  { app: 'imports', fixture: queued, operate: operateDelivery, field: 'queueSnapshot', recovery: 'queueRecovery', control: 'delivery', recover: recoverQueueSnapshots,
    observe: f => { f.backend.queues.snapshot = async () => ({ paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: 999000 }); } },
  { app: 'refresh', fixture: scheduled, operate: operateDispatch, field: 'cronSnapshot', recovery: 'cronRecovery', control: 'dispatch', recover: recoverCronSnapshots, observe: () => {} },
];
async function restoredBackground(t, family) {
  const p = profiles(), f = await family.fixture(t, { slots: p.slots, clock: () => 1000000 }), request = await f.request();
  await f.c.mutate(request.id, request.digest, 'approve');
  family.observe(f);
  await family.operate(f.c, family.app, 'snapshot', { deployment: request.id, digest: request.digest });
  return { f, request, p, ...roundTrip(f.c.state, request, p.source, p.target, 'slot-2') };
}

for (const family of families) test(`archived ${family.app} recovery rebinds only its slot while preserving old evidence`, async t => {
  const result = await restoredBackground(t, family), saved = result.f.c.state.apps[family.app][family.field];
  const app = result.restored.apps[family.app], recovery = app[family.recovery];
  assert.equal(app.slot, 'slot-2');
  assert.equal(app.route, 'paused');
  assert.equal(app.archiveRecovery.status, 'pending');
  assert.equal(app[family.field], undefined);
  assert.equal(recovery.status, 'pending');
  assert.equal(recovery.snapshot, 'b'.repeat(64));
  assert.equal(recovery.previous, null);
  assert.deepEqual(recovery.prepared, { ...saved, slot: 'slot-2' });
  assert.deepEqual(result.restored.appArchives.records[id].app[family.field], saved);
});

for (const family of families) for (const [name, mutate] of [
  ['wrong slot', (app, family) => { app[family.recovery].prepared.slot = 'slot-1'; }],
  ['changed observation time', (app, family) => { app[family.recovery].prepared.at++; }],
  ['different snapshot', (app, family) => { app[family.recovery].snapshot = 'c'.repeat(64); }],
  ['old acknowledgment', (app, family) => { app[family.recovery].status = 'acknowledged'; }],
  ['missing recovery', (app, family) => { delete app[family.recovery]; }],
  ['fabricated prior history', (app, family) => { app[family.recovery].previous = { status: 'acknowledged' }; }],
  ['resumed background control', (app, family) => { app[family.control].desired = 'running'; }],
]) test(`archived ${family.app} state refuses ${name} before approval`, async t => {
  const result = await restoredBackground(t, family);
  mutate(result.restored.apps[family.app], family);
  assert.throws(() => validateAppArchives(result.restored, result.profile), { code: 'APP_ARCHIVE_REFUSED' });
});

for (const family of families) test(`automatic ${family.app} diagnosis waits for explicit archive approval and keeps execution held`, async t => {
  const result = await restoredBackground(t, family), { f } = result;
  // Exercise recovery with the existing backend stand-in. Ordinary controller
  // startup still rejects archive state; this does not claim startup admission.
  f.c.state = result.restored;
  f.c.slots = result.profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  await family.recover(f.c);
  const app = f.c.state.apps[family.app], recovery = app[family.recovery];
  assert.equal(recovery.checkError, undefined);
  assert.equal(recovery.checkedAt, undefined);
  assert.equal(recovery.status, 'pending');
  assert.equal(app.route, 'paused');
  assert.equal(app[family.control].desired, 'paused');
  assert.equal(app[family.control].observed, 'paused');
  assert.equal(app.archiveRecovery.status, 'pending');
  validateAppArchives(f.c.state, result.profile);
});

test('expired archived queue evidence retains its original deadline and produces loss diagnosis after owner approval', async t => {
  const f = await archiveApprovalFixture(t, { background: 'queue' });
  const c = new Controller({ ...f.settings, archiveProfile: f.profile }); await c.init();
  const original = c.state.appArchives.records[id].app.queueSnapshot;
  c.clock = () => original.expiresAt + 1;
  const review = await c.archives.review('imports');
  await c.archives.approve('imports', review.selection, { actor: { kind: 'basic', name: 'owner' }, review: review.review });
  const app = c.state.apps.imports;
  assert.equal(app.queueRecovery.prepared.expiresAt, original.expiresAt);
  assert.equal(app.queueRecovery.prepared.at, original.at);
  assert.equal(app.queueRecovery.checkError, null);
  assert.match(app.queueRecovery.diagnosis, /Possible message expiration/);
  assert.equal(app.queueRecovery.status, 'pending');
  assert.equal(app.route, 'paused');
  assert.equal(app.delivery.observed, 'paused');
});
