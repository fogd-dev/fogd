import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as queued } from './fixtures/queue-controller.mjs';
import { fixture as scheduled } from './fixtures/cron-controller.mjs';
import { policy } from './fixtures/runtime-policy.mjs';
import { operateDelivery } from '../src/admin-delivery.mjs';
import { operateDispatch } from '../src/admin-dispatch.mjs';
import { projectAppArchive, projectAppArchiveRestore } from '../src/app-archive.mjs';

const id = '33333333-3333-4333-8333-333333333333';
function profiles() {
  const source = { ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] };
  const target = structuredClone(source);
  target.fleets[0].prefix = `archive-generations/${id}`;
  target.fleets[0].nodes = [{ host: 'slot-1-a', id: `slot-1-a-${id}` }, { host: 'slot-1-b', id: `slot-1-b-${id}` }];
  return { source, target, slots: source.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) })) };
}
function roundTrip(state, request, source, target) {
  const archived = projectAppArchive({ state, sourceProfile: source, profile: target, snapshot: 'a'.repeat(64), app: request.app,
    digest: request.digest, id, at: '2026-10-30T02:00:00.000Z' });
  const restored = projectAppArchiveRestore({ state: archived, sourceProfile: target, profile: source, snapshot: 'b'.repeat(64),
    archive: id, expectedIdentity: archived.appArchives.records[id].identity, slot: 'slot-1' });
  return { archived, restored };
}

test('queued app projection retains its paused backlog receipt behind pending archive recovery', async t => {
  const p = profiles(), f = await queued(t, { slots: p.slots, clock: () => 1000000 }), request = await f.request();
  await f.c.mutate(request.id, request.digest, 'approve');
  f.backend.queues.snapshot = async () => ({ paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: 999000 });
  await operateDelivery(f.c, 'imports', 'snapshot', { deployment: request.id, digest: request.digest });
  const before = structuredClone(f.c.state), result = roundTrip(f.c.state, request, p.source, p.target);
  assert.deepEqual(structuredClone(f.c.state), before);
  assert.deepEqual(result.archived.appArchives.records[id].app.queueSnapshot, before.apps.imports.queueSnapshot);
  assert.deepEqual(result.restored.apps.imports.queueSnapshot, before.apps.imports.queueSnapshot);
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
  assert.deepEqual(result.restored.apps.refresh.cronSnapshot, before.apps.refresh.cronSnapshot);
  assert.equal(result.restored.apps.refresh.dispatch.desired, 'paused');
  assert.equal(result.restored.apps.refresh.dispatch.observed, 'paused');
  assert.equal(result.restored.deployments[request.id].secretRevision, secret.revision);
  assert.equal(result.restored.apps.refresh.archiveRecovery.status, 'pending');
});
